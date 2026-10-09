//! Requests (`ExecRequest`) as jobs that run in rounds, and their answers shaped like
//! go-ethereum's (`debug_*`, `eth_*`) and Erigon's (`trace_*`). Ported from exe-trace `api`.

use crate::{
    calls::{CallJob, CallKind, RpcError, error_json},
    config::ChainConfig,
    format,
    limits::{Error, Limits},
    options::{
        CALL_GAS_CAP, GethOptions, Overrides, parse_call, parse_call_options, parse_geth_options,
        parse_trace_types,
    },
    protocol,
    record::{Block, input_addresses},
    replay::{CallFlags, Output, Program, Replayer, Step, Traced, Tracer, block_hints},
    state::{Known, Miss},
};
use alloy_consensus::{Header, transaction::Transaction as _};
use alloy_eips::{eip2935::HISTORY_STORAGE_ADDRESS, eip4788::BEACON_ROOTS_ADDRESS};
use alloy_evm::{EvmEnv, FromRecoveredTx};
use alloy_hardforks::EthereumHardforks;
use alloy_primitives::{U256, map::HashSet};
use alloy_rpc_types_eth::TransactionInfo;
use alloy_rpc_types_trace::parity::{
    Action, LocalizedTransactionTrace, RewardAction, RewardType, TraceType, TransactionTrace,
};
use revm::context::TxEnv;
use revm_inspectors::tracing::TransactionContext;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// What a round produced.
pub enum Progress {
    /// The `ExecResponse`.
    Done(Value),
    /// The block's witness is wanted (state before block `number`, whose hash is given).
    Witness(u64, alloy_primitives::B256),
    /// Keys to read at the end of block `at`.
    Need(Vec<Miss>, u64),
}

/// One request, from its first round to its answer.
pub struct Session {
    job: Job,
    known: Known,
    limits: Limits,
    /// The block whose end state keys are read at.
    at: u64,
    /// The witness of `at + 1` is wanted before the first round.
    wants_witness: bool,
    /// Keys asked for in the last round.
    asked: Vec<Miss>,
    /// The request's block.
    block_hash: alloy_primitives::B256,
}

enum Job {
    /// The request failed before execution.
    Failed(RpcError),
    Call(Box<CallJob>),
    Trace(Box<TraceJob>),
}

struct TraceJob {
    replayer: Replayer,
    /// Steps before the block's first transaction (system calls).
    offset: usize,
    /// Keys read with the first round.
    hints: Option<BTreeSet<Miss>>,
    finish: Finish,
    block: Block,
    config: ChainConfig,
}

enum Finish {
    DebugTx(GethOptions),
    DebugBlock(GethOptions),
    TraceTx,
    TraceBlock,
    ReplayTx(usize),
    ReplayBlock,
    DebugCall(GethOptions),
    TraceCall,
}

fn response_ok(result: Value) -> Value {
    json!({ "result": result })
}

fn response_err(error: &RpcError) -> Value {
    json!({ "error": error.to_json() })
}

fn invalid(message: impl Into<String>) -> Error {
    Error::InvalidParams(message.into())
}

impl Session {
    /// A session for `request` (`ExecRequest` JSON).
    pub fn new(request: &str) -> Self {
        let mut known = Known::default();
        let (job, at, wants_witness, limits) = match parse(request, &mut known) {
            Ok(parsed) => parsed,
            Err(error) => (Job::Failed(error_json(error)), 0, false, Limits::calls()),
        };
        let block_hash = match &job {
            Job::Call(job) => job.block_hash,
            Job::Trace(job) => job.block.hash,
            Job::Failed(_) => Default::default(),
        };
        Self {
            job,
            known,
            limits,
            at,
            wants_witness,
            asked: Vec::new(),
            block_hash,
        }
    }

    /// Answer the last round's keys (`{"keys", "values", "witness"?}` JSON; keys may include
    /// more than were asked, such as code read with accounts) and run the next round.
    pub fn run(&mut self, input: &str) -> Progress {
        if let Err(message) = self.apply(input) {
            return Progress::Done(response_err(&RpcError::new(
                -32000,
                format!("execution unavailable: {message}"),
            )));
        }
        if self.wants_witness {
            self.wants_witness = false;
            return Progress::Witness(self.at + 1, self.block_hash);
        }
        let outcome = match &mut self.job {
            Job::Failed(error) => Ok(Ok(response_err(error))),
            Job::Call(job) => match job.attempt(&self.known, &self.limits) {
                Ok(Ok(result)) => Ok(Ok(response_ok(result))),
                Ok(Err(error)) => Ok(Ok(response_err(&error))),
                Err(misses) => Ok(Err(misses.into_keys().collect::<BTreeSet<_>>())),
            },
            Job::Trace(job) => job.advance(&self.known, &self.limits),
        };
        match outcome {
            Ok(Ok(response)) => Progress::Done(response),
            Err(error) => Progress::Done(response_err(&error_json(error))),
            Ok(Err(misses)) => {
                let mut misses: Vec<Miss> =
                    misses.into_iter().filter(|m| !self.known.has(m)).collect();
                // Code of accounts already known is read with them.
                for hash in self.known.missing_code() {
                    misses.push(Miss::Code(hash));
                }
                misses.sort_unstable();
                misses.dedup();
                if misses.is_empty() {
                    return Progress::Done(response_err(&RpcError::new(
                        -32000,
                        "execution unavailable: no progress",
                    )));
                }
                if let Err(error) = self.limits.charge_round(misses.len()) {
                    return Progress::Done(response_err(&error_json(error)));
                }
                self.asked = misses.clone();
                Progress::Need(misses, self.at)
            }
        }
    }

    fn apply(&mut self, input: &str) -> Result<(), String> {
        if input.trim().is_empty() {
            return Ok(());
        }
        let input: Value = serde_json::from_str(input).map_err(|e| e.to_string())?;
        if let Some(witness) = input.get("witness").filter(|w| !w.is_null()) {
            protocol::insert_witness(&mut self.known, witness)?;
        }
        let keys = input.get("keys").and_then(Value::as_array);
        let values = input.get("values").and_then(Value::as_array);
        if let (Some(keys), Some(values)) = (keys, values) {
            if keys.len() != values.len() {
                return Err("state values do not match their keys".into());
            }
            for (key, value) in keys.iter().zip(values) {
                let key = protocol::parse_key(key)?;
                protocol::insert(&mut self.known, &key, value)?;
            }
        }
        for miss in &self.asked {
            if !self.known.has(miss) {
                return Err(format!("state source did not answer {miss:?}"));
            }
        }
        self.asked.clear();
        Ok(())
    }

    pub fn usage(&self) -> String {
        self.limits.usage()
    }
}

impl TraceJob {
    fn advance(
        &mut self,
        known: &Known,
        limits: &Limits,
    ) -> Result<Result<Value, BTreeSet<Miss>>, Error> {
        if let Some(hints) = self.hints.take() {
            let hints: BTreeSet<Miss> = hints.into_iter().filter(|m| !known.has(m)).collect();
            if !hints.is_empty() {
                return Ok(Err(hints));
            }
        }
        let misses = self.replayer.round(known, limits)?;
        if !misses.is_empty() {
            return Ok(Err(misses.into_keys().collect()));
        }
        self.finish().map(|value| Ok(response_ok(value)))
    }

    /// Traced transaction outputs: (index in the block, output).
    fn traced(&self) -> Vec<(usize, &Output)> {
        self.replayer
            .outputs
            .iter()
            .skip(self.offset)
            .enumerate()
            .filter_map(|(index, output)| Some((index, output.as_ref()?)))
            .filter(|(_, output)| output.trace.is_some())
            .collect()
    }

    fn finish(&self) -> Result<Value, Error> {
        let block = &self.block;
        let traced = self.traced();
        let first = || {
            traced
                .first()
                .map(|(_, output)| *output)
                .ok_or_else(|| Error::unavailable("transaction not replayed"))
        };
        fn trace(output: &Output) -> &Traced {
            output.trace.as_ref().expect("traced")
        }
        Ok(match &self.finish {
            Finish::DebugTx(options) | Finish::DebugCall(options) => {
                let output = first()?;
                format::geth(trace(output), options, output.log_offset)?
            }
            Finish::DebugBlock(options) => Value::Array(
                traced
                    .iter()
                    .map(|(index, output)| {
                        Ok(json!({
                            "txHash": block.txs[*index].hash,
                            "result": format::geth(trace(output), options, output.log_offset)?,
                        }))
                    })
                    .collect::<Result<Vec<_>, Error>>()?,
            ),
            Finish::TraceTx => {
                let traces = traced
                    .first()
                    .map(|(_, output)| localized(trace(output)))
                    .unwrap_or(&[]);
                Value::Array(traces.iter().map(format::localized).collect())
            }
            Finish::TraceBlock => {
                let mut traces: Vec<Value> = traced
                    .iter()
                    .flat_map(|(_, output)| localized(trace(output)).iter().map(format::localized))
                    .collect();
                // Reward traces have no transaction (OpenEthereum and Erigon omit the fields).
                traces.extend(rewards(&self.config, block).iter().map(|reward| {
                    let mut value = format::localized(reward);
                    if let Some(object) = value.as_object_mut() {
                        object.remove("transactionHash");
                        object.remove("transactionPosition");
                    }
                    value
                }));
                Value::Array(traces)
            }
            Finish::ReplayTx(index) => {
                let output = first()?;
                let mut result = format::trace_results(parity(trace(output)), Some(*index))?;
                result["transactionHash"] = json!(block.txs[*index].hash);
                result
            }
            Finish::ReplayBlock => Value::Array(
                traced
                    .iter()
                    .map(|(index, output)| {
                        let mut result =
                            format::trace_results(parity(trace(output)), Some(*index))?;
                        result["transactionHash"] = json!(block.txs[*index].hash);
                        Ok(result)
                    })
                    .collect::<Result<Vec<_>, Error>>()?,
            ),
            Finish::TraceCall => {
                let output = first()?;
                format::trace_results(parity(trace(output)), None)?
            }
        })
    }
}

fn localized(traced: &Traced) -> &[LocalizedTransactionTrace] {
    match traced {
        Traced::Localized(traces) => traces,
        _ => unreachable!("localized tracer"),
    }
}

fn parity(traced: &Traced) -> &alloy_rpc_types_trace::parity::TraceResults {
    match traced {
        Traced::Parity(results) => results,
        _ => unreachable!("parity tracer"),
    }
}

/// Pre-Merge block and uncle rewards, as OpenEthereum and Erigon list them in `trace_block`.
fn rewards(config: &ChainConfig, block: &Block) -> Vec<LocalizedTransactionTrace> {
    let number = block.number();
    let Some(reward) = config.block_reward(number) else {
        return Vec::new();
    };
    let trace = |author, reward_type, value: u128| LocalizedTransactionTrace {
        trace: TransactionTrace {
            action: Action::Reward(RewardAction {
                author,
                reward_type,
                value: U256::from(value),
            }),
            error: None,
            result: None,
            subtraces: 0,
            trace_address: Vec::new(),
        },
        transaction_position: None,
        transaction_hash: None,
        block_number: Some(number),
        block_hash: Some(block.hash),
    };
    let ommers = block.ommers.len() as u128;
    let mut traces = vec![trace(
        block.header.beneficiary,
        RewardType::Block,
        reward + reward / 32 * ommers,
    )];
    for ommer in &block.ommers {
        let value = reward * (8 + u128::from(ommer.number) - u128::from(number)) / 8;
        traces.push(trace(ommer.beneficiary, RewardType::Uncle, value));
    }
    traces
}

fn tx_info(block: &Block, index: usize) -> TransactionInfo {
    TransactionInfo {
        hash: Some(block.txs[index].hash),
        index: Some(index as u64),
        block_hash: Some(block.hash),
        block_number: Some(block.number()),
        base_fee: block.header.base_fee_per_gas,
        ..Default::default()
    }
}

fn tx_context(block: &Block, index: usize) -> TransactionContext {
    TransactionContext {
        block_hash: Some(block.hash),
        tx_index: Some(index),
        tx_hash: Some(block.txs[index].hash),
    }
}

fn geth_tracer(options: &GethOptions, context: TransactionContext) -> Tracer {
    Tracer::Geth {
        options: options.options.clone(),
        context,
    }
}

/// A replay of `block` (on its parent's post-state) through the last transaction
/// `tracer_for` traces: the DAO change, the EIP-2935 and EIP-4788 system calls, then the
/// transactions in order.
fn block_job(
    config: ChainConfig,
    block: Block,
    limits: &Limits,
    finish: Finish,
    mut tracer_for: impl FnMut(&Block, usize) -> Option<Tracer>,
) -> Result<TraceJob, Error> {
    let header = &block.header;
    if header.number == 0 {
        return Err(Error::Rejected("genesis is not traceable".into()));
    }
    let env = config.env(header).map_err(Error::Unavailable)?;
    let mut steps = Vec::new();
    let mut system = Vec::new();
    if config.dao_fork_block() == Some(header.number) {
        steps.push(Step::Dao);
        let mut dao: Vec<_> = alloy_evm::eth::dao_fork::DAO_HARDFORK_ACCOUNTS.to_vec();
        dao.push(alloy_evm::eth::dao_fork::DAO_HARDFORK_BENEFICIARY);
        for address in dao {
            system.push((address, Vec::new()));
        }
    }
    if config.is_prague_active_at_timestamp(header.timestamp) {
        steps.push(Step::System {
            contract: HISTORY_STORAGE_ADDRESS,
            data: header.parent_hash.0.into(),
        });
        system.push((
            HISTORY_STORAGE_ADDRESS,
            vec![U256::from((header.number - 1) % 8191)],
        ));
    }
    if config.is_cancun_active_at_timestamp(header.timestamp)
        && let Some(root) = header.parent_beacon_block_root
    {
        steps.push(Step::System {
            contract: BEACON_ROOTS_ADDRESS,
            data: root.0.into(),
        });
        let slot = U256::from(header.timestamp % 8191);
        system.push((BEACON_ROOTS_ADDRESS, vec![slot, slot + U256::from(8191)]));
    }
    let offset = steps.len();
    let mut tracers: Vec<Option<Tracer>> = vec![None; offset];
    let mut last = None;
    for index in 0..block.txs.len() {
        let tracer = tracer_for(&block, index);
        if tracer.is_some() {
            last = Some(index);
        }
        tracers.push(tracer);
    }
    let txs_through = last.map_or(0, |last| last + 1);
    tracers.truncate(offset + txs_through);
    let txs = &block.txs[..txs_through];
    if let Some(last) = last {
        let gas = match block.cumulative_gas.get(last) {
            Some(gas) => *gas,
            None => txs
                .iter()
                .map(|tx| tx.envelope.gas_limit())
                .sum::<u64>()
                .min(header.gas_used),
        };
        limits.charge_gas(gas)?;
    }
    let mut hint_txs = Vec::with_capacity(txs.len());
    for tx in txs {
        steps.push(Step::Tx {
            tx: Box::new(TxEnv::from_recovered_tx(&tx.envelope, tx.sender)),
            call: None,
        });
        hint_txs.push((
            tx.sender,
            tx.envelope.to(),
            tx.envelope
                .access_list()
                .map(|list| {
                    list.iter()
                        .map(|item| (item.address, item.storage_keys.clone()))
                        .collect()
                })
                .unwrap_or_default(),
            tx.envelope
                .authorization_list()
                .map(|list| list.iter().map(|auth| auth.address))
                .into_iter()
                .flatten()
                .chain(tx.hints.iter().copied())
                .collect(),
        ));
    }
    let hints = if last.is_some() {
        block_hints(header.beneficiary, &system, &hint_txs)
    } else {
        BTreeSet::new()
    };
    let program = Program {
        env,
        steps,
        tracers,
    };
    Ok(TraceJob {
        replayer: Replayer::new(program, false),
        offset,
        hints: Some(hints),
        finish,
        block,
        config,
    })
}

/// The environment of calls at `header`'s block (`eth_call` semantics with Erigon's gas cap:
/// no block gas limit or EIP-7825 cap); each call's fee and nonce checks are applied when it
/// runs (`replay::CallFlags`).
fn trace_call_env(config: &ChainConfig, header: &Header) -> Result<EvmEnv, Error> {
    let mut env = config.env(header).map_err(Error::Unavailable)?;
    env.cfg_env.disable_eip3607 = true;
    env.cfg_env.disable_block_gas_limit = true;
    env.cfg_env.tx_gas_limit_cap = Some(u64::MAX);
    Ok(env)
}

/// A call traced on the post-state of `block`.
fn call_job(
    config: ChainConfig,
    block: Block,
    request: &Value,
    overrides: &Overrides,
    tracer: Tracer,
    finish: Finish,
    known: &mut Known,
) -> Result<TraceJob, Error> {
    let mut env = trace_call_env(&config, &block.header)?;
    for (number, hash) in overrides.apply_block(&mut env) {
        known.insert_hash(number, hash);
    }
    let call = parse_call(request, &env)?;
    let mut hints = BTreeSet::new();
    hints.insert(Miss::Account(call.tx.caller));
    if let alloy_primitives::TxKind::Call(to) = call.tx.kind {
        hints.insert(Miss::Account(to));
    }
    hints.extend(
        input_addresses(&call.tx.data)
            .into_iter()
            .map(Miss::Account),
    );
    hints.insert(Miss::Account(env.block_env.beneficiary));
    let mut steps = Vec::new();
    let mut tracers = Vec::new();
    if let Some(state) = &overrides.state {
        steps.push(Step::Overrides(state.clone()));
        tracers.push(None);
    }
    let offset = steps.len();
    steps.push(Step::Tx {
        tx: Box::new(call.tx),
        call: Some(CallFlags {
            free: call.free,
            nonce: call.nonce,
        }),
    });
    tracers.push(Some(tracer));
    let program = Program {
        env,
        steps,
        tracers,
    };
    Ok(TraceJob {
        replayer: Replayer::new(program, true),
        offset,
        hints: Some(hints),
        finish,
        block,
        config,
    })
}

fn tx_index(index: Option<u64>, block: &Block) -> Result<usize, Error> {
    let index = index.ok_or_else(|| invalid("transaction index missing"))? as usize;
    if index >= block.txs.len() {
        return Err(invalid("transaction index out of range"));
    }
    Ok(index)
}

fn arity(params: &[Value], min: usize, max: usize) -> Result<(), Error> {
    if params.len() < min || params.len() > max {
        return Err(invalid(format!(
            "invalid params: expected {min} to {max} arguments, got {}",
            params.len()
        )));
    }
    Ok(())
}

type Parsed = (Job, u64, bool, Limits);

fn parse(request: &str, known: &mut Known) -> Result<Parsed, Error> {
    let request: Value =
        serde_json::from_str(request).map_err(|e| invalid(format!("invalid request: {e}")))?;
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("request method missing"))?
        .to_owned();
    let params: Vec<Value> = match request.get("params") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items.clone(),
        Some(_) => return Err(invalid("params must be an array")),
    };
    let config = ChainConfig::from_value(request.get("chain").unwrap_or(&Value::Null))
        .map_err(|e| Error::Unavailable(format!("execution unavailable: {e}")))?;
    let record = request
        .get("block")
        .and_then(Value::as_str)
        .and_then(|s| hex::decode(s.strip_prefix("0x").unwrap_or(s)).ok())
        .ok_or_else(|| Error::unavailable("block record missing"))?;
    let block = crate::record::decode(&record)
        .map_err(|e| Error::Unavailable(format!("invalid block record: {e}")))?;
    let index = request.get("txIndex").and_then(Value::as_u64);
    let number = block.number();
    let call_kind = match method.as_str() {
        "eth_call" => Some(CallKind::Call),
        "eth_estimateGas" => Some(CallKind::Estimate),
        "eth_createAccessList" => Some(CallKind::AccessList),
        _ => None,
    };
    if let Some(kind) = call_kind {
        let max = if kind == CallKind::AccessList { 3 } else { 4 };
        arity(&params, 1, max)?;
        let overrides = Overrides::parse(params.get(2), params.get(3))?;
        let env = config.env(&block.header).map_err(Error::Unavailable)?;
        let mut job = CallJob::new(
            kind,
            &params[0],
            env,
            block.header.gas_limit,
            &overrides,
            known,
        )?;
        job.block_hash = block.hash;
        return Ok((Job::Call(Box::new(job)), number, false, Limits::calls()));
    }
    let limits = Limits::traces();
    let mined = |job: TraceJob| -> Parsed {
        (
            Job::Trace(Box::new(job)),
            number.saturating_sub(1),
            true,
            Limits::traces(),
        )
    };
    let job = match method.as_str() {
        "debug_traceTransaction" => {
            arity(&params, 1, 2)?;
            let options = parse_geth_options(params.get(1))?;
            let index = tx_index(index, &block)?;
            let tracer_options = options.clone();
            mined(block_job(
                config,
                block,
                &limits,
                Finish::DebugTx(options),
                |b, i| (i == index).then(|| geth_tracer(&tracer_options, tx_context(b, i))),
            )?)
        }
        "debug_traceBlockByNumber" | "debug_traceBlockByHash" => {
            arity(&params, 1, 2)?;
            let options = parse_geth_options(params.get(1))?;
            let tracer_options = options.clone();
            mined(block_job(
                config,
                block,
                &limits,
                Finish::DebugBlock(options),
                |b, i| Some(geth_tracer(&tracer_options, tx_context(b, i))),
            )?)
        }
        "trace_transaction" => {
            arity(&params, 1, 1)?;
            let index = tx_index(index, &block)?;
            mined(block_job(
                config,
                block,
                &limits,
                Finish::TraceTx,
                |b, i| {
                    (i == index).then(|| Tracer::Localized {
                        info: tx_info(b, i),
                    })
                },
            )?)
        }
        "trace_block" => {
            arity(&params, 1, 1)?;
            mined(block_job(
                config,
                block,
                &limits,
                Finish::TraceBlock,
                |b, i| {
                    Some(Tracer::Localized {
                        info: tx_info(b, i),
                    })
                },
            )?)
        }
        "trace_replayTransaction" => {
            arity(&params, 2, 2)?;
            let types = parse_trace_types(&params[1])?;
            let index = tx_index(index, &block)?;
            mined(block_job(
                config,
                block,
                &limits,
                Finish::ReplayTx(index),
                |_, i| {
                    (i == index).then(|| Tracer::Parity {
                        types: types.clone(),
                    })
                },
            )?)
        }
        "trace_replayBlockTransactions" => {
            arity(&params, 2, 2)?;
            let types = parse_trace_types(&params[1])?;
            mined(block_job(
                config,
                block,
                &limits,
                Finish::ReplayBlock,
                |_, _| {
                    Some(Tracer::Parity {
                        types: types.clone(),
                    })
                },
            )?)
        }
        "debug_traceCall" => {
            arity(&params, 1, 3)?;
            let (options, overrides) = parse_call_options(params.get(2))?;
            let tracer = geth_tracer(&options, TransactionContext::default());
            let job = call_job(
                config,
                block,
                &params[0],
                &overrides,
                tracer,
                Finish::DebugCall(options),
                known,
            )?;
            (Job::Trace(Box::new(job)), number, false, Limits::traces())
        }
        "trace_call" => {
            arity(&params, 2, 5)?;
            let types: HashSet<TraceType> = parse_trace_types(&params[1])?;
            let overrides = Overrides::parse(params.get(3), params.get(4))?;
            let job = call_job(
                config,
                block,
                &params[0],
                &overrides,
                Tracer::Parity { types },
                Finish::TraceCall,
                known,
            )?;
            (Job::Trace(Box::new(job)), number, false, Limits::traces())
        }
        other => {
            return Err(Error::InvalidParams(format!(
                "the method {other} is not served by the executor"
            )));
        }
    };
    let _ = CALL_GAS_CAP;
    Ok(job)
}

/// Run a session to completion over an in-memory answer function (tests and tools).
pub fn run_with(
    request: &str,
    witness: impl Fn(u64) -> Option<Value>,
    mut read: impl FnMut(&[Miss], u64) -> Vec<Value>,
) -> (Value, String) {
    let mut session = Session::new(request);
    let mut input = String::new();
    loop {
        match session.run(&input) {
            Progress::Done(response) => return (response, session.usage()),
            Progress::Witness(number, _) => {
                input = json!({ "witness": witness(number) }).to_string();
            }
            Progress::Need(keys, at) => {
                let values = read(&keys, at);
                let keys: Vec<Value> = keys.iter().map(protocol::key_json).collect();
                input = json!({ "keys": keys, "values": values }).to_string();
            }
        }
    }
}

/// Unused keys of a map (helper for tests).
#[allow(dead_code)]
pub(crate) fn keys<K: Ord + Clone, V>(map: &BTreeMap<K, V>) -> Vec<K> {
    map.keys().cloned().collect()
}
