//! Replays a sequence of system calls and transactions in rounds (see `state`), tracing the
//! selected steps. Ported from exe-trace `replay`, made resumable: the executor keeps the
//! checkpoint between rounds instead of awaiting reads.

use crate::{
    limits::{Error, Limits, Usage},
    state::{Known, KnownRef, Miss, MissError},
};
use alloy_eips::eip4788::SYSTEM_ADDRESS;
use alloy_evm::{EthEvmFactory, Evm, EvmEnv, EvmFactory};
use alloy_primitives::map::HashSet;
use alloy_primitives::{Address, B256, Bytes, U256};
use alloy_rpc_types_eth::TransactionInfo;
use alloy_rpc_types_trace::{
    geth::{GethDebugTracingOptions, GethTrace, PreStateFrame},
    parity::{LocalizedTransactionTrace, TraceResults, TraceType},
};
use revm::{
    DatabaseCommit, Inspector,
    context::{
        ContextError, ContextTr, JournalTr, TxEnv,
        result::{EVMError, ExecutionResult, HaltReason, InvalidTransaction, ResultAndState},
    },
    database::{Cache, CacheDB},
    database_interface::WrapDatabaseRef,
    handler::FrameResult,
    inspector::JournalExt,
    interpreter::{
        CallInputs, CallOutcome, CreateInputs, CreateOutcome, FrameInput, Interpreter,
        interpreter_types::{LoopControl, MemoryTr},
    },
    primitives::Log,
    state::AccountInfo,
};
use revm_inspectors::tracing::{
    DebugInspector, TraceLimitBehavior, TraceLimits, TracingInspector, TracingInspectorConfig,
    TransactionContext,
};
use std::collections::{BTreeMap, BTreeSet};

/// One step of a replay.
#[derive(Clone, Debug)]
pub(crate) enum Step {
    /// A pre-block system call (EIP-2935, EIP-4788): its state changes are
    /// committed, nothing is traced or reported.
    System { contract: Address, data: Bytes },
    /// A block transaction (must be valid), or a call (may be rejected).
    Tx {
        tx: Box<TxEnv>,
        call: Option<CallFlags>,
    },
    /// The DAO fork's irregular state change (before the fork block's transactions).
    Dao,
    /// A call's state overrides, applied to the state before the calls.
    Overrides(alloy_rpc_types_eth::state::StateOverride),
}

/// A call's checks: no base fee without fee fields, nonce checked only when
/// given (like `eth_call`).
#[derive(Clone, Copy, Debug)]
pub(crate) struct CallFlags {
    pub free: bool,
    pub nonce: bool,
}

/// A block transaction's sender, recipient, access list and other accounts
/// likely touched.
pub(crate) type TxHints = (
    Address,
    Option<Address>,
    Vec<(Address, Vec<B256>)>,
    Vec<Address>,
);

/// What to produce for a traced step.
#[derive(Clone, Debug)]
pub(crate) enum Tracer {
    Geth {
        options: GethDebugTracingOptions,
        context: TransactionContext,
    },
    /// `trace_call`, `trace_replay*`: the requested trace types.
    Parity { types: HashSet<TraceType> },
    /// `trace_transaction`, `trace_block`, `trace_filter`, `trace_get`.
    Localized { info: TransactionInfo },
}

impl Tracer {
    /// The default Geth tracer: costly to run on discarded rounds.
    fn logs_steps(&self) -> bool {
        matches!(self, Self::Geth { options, .. }
            if options.tracer.as_ref().is_none_or(|t| t.as_str().is_empty()))
    }
}

#[derive(Debug)]
pub(crate) enum Traced {
    /// With the code hashes of prestate tracer accounts (`pre`, and `post`
    /// where the code changed): Geth and Erigon report `codeHash`.
    Geth(Box<GethTrace>, CodeHashes),
    Parity(TraceResults),
    Localized(Vec<LocalizedTransactionTrace>),
}

#[derive(Debug, Default)]
pub(crate) struct CodeHashes {
    pub pre: std::collections::BTreeMap<Address, B256>,
    pub post: std::collections::BTreeMap<Address, B256>,
    /// EIP-7702 refund for authorities that existed: Geth and Erigon count
    /// it in the refund counter struct logs report from the first step.
    pub refund: u64,
    /// Diff mode: touched accounts that exist neither before nor after.
    pub absent: Vec<Address>,
}

/// The EIP-7702 authorization refund of `tx` (as revm applies the list:
/// valid chain ID and nonce, no code or a delegation, 12,500 gas per
/// authority that already existed).
fn auth_refund(tx: &TxEnv, chain_id: u64, db: &Db<'_, '_>) -> u64 {
    use revm::{DatabaseRef, context_interface::transaction::AuthorizationTr};
    let mut accounts: std::collections::HashMap<Address, (u64, bool, bool)> = Default::default();
    let mut refunded = 0;
    for authorization in &tx.authorization_list {
        let auth_chain = authorization.chain_id();
        if !auth_chain.is_zero() && auth_chain != U256::from(chain_id) {
            continue;
        }
        if authorization.nonce() == u64::MAX {
            continue;
        }
        let Some(authority) = authorization.authority() else {
            continue;
        };
        let (nonce, exists, delegatable) = *accounts.entry(authority).or_insert_with(|| {
            let info = db.basic_ref(authority).ok().flatten().unwrap_or_default();
            let code = db.code_by_hash_ref(info.code_hash).unwrap_or_default();
            let nonce = info.nonce + u64::from(authority == tx.caller);
            let exists = nonce > 0 || !info.balance.is_zero() || !code.is_empty();
            (nonce, exists, code.is_empty() || code.is_eip7702())
        });
        if !delegatable || nonce != authorization.nonce() {
            continue;
        }
        if exists {
            refunded += 1;
        }
        accounts.insert(authority, (nonce + 1, true, true));
    }
    refunded * 12_500
}

/// A kept execution of a transaction step.
#[derive(Debug)]
pub(crate) struct Output {
    pub trace: Option<Traced>,
    /// Logs of the program's earlier transaction steps (the block-level
    /// index of this transaction's first log).
    pub log_offset: u64,
}

/// A replay: the EVM environment and its steps, with a tracer per step.
pub(crate) struct Program {
    pub env: EvmEnv,
    pub steps: Vec<Step>,
    pub tracers: Vec<Option<Tracer>>,
}

/// Gas from which an exploring step that missed nothing is not explored
/// again every round.
const HEAVY_GAS: u64 = 500_000;

/// Messages for the inspected-execution budgets.
const STEP_LIMIT: &str = "trace exceeds the execution step limit";
const STRUCT_LOG_LIMIT: &str = "trace exceeds the struct log limit";

/// A program replayed in rounds. Each round resumes from a checkpoint: the state after every
/// step that ran without a miss (those steps observed only answered values, which never change,
/// so they are never executed again). The first step that misses is discarded; to discover more
/// keys per round trip, the remaining steps are then explored on a scratch copy without
/// tracing, their results ignored.
pub(crate) struct Replayer {
    pub program: Program,
    end: usize,
    pub outputs: Vec<Option<Output>>,
    cache: Cache,
    next: usize,
    logs: u64,
    clean: Vec<bool>,
}

impl Replayer {
    /// Steps after the last traced one are not executed unless `run_all`.
    pub fn new(program: Program, run_all: bool) -> Self {
        let end = if run_all {
            program.steps.len()
        } else {
            program
                .tracers
                .iter()
                .rposition(Option::is_some)
                .map_or(0, |last| last + 1)
        };
        let steps = program.steps.len();
        Self {
            program,
            end,
            outputs: (0..steps).map(|_| None).collect(),
            cache: Cache::default(),
            next: 0,
            logs: 0,
            clean: vec![false; steps],
        }
    }

    /// Run as far as `known` allows. Returns the keys missed (with the step that first
    /// needed each), empty when the program is complete.
    pub fn round(
        &mut self,
        known: &Known,
        limits: &Limits,
    ) -> Result<BTreeMap<Miss, usize>, Error> {
        let program = &self.program;
        let end = self.end;
        let reader = KnownRef::new(known);
        let mut db = CacheDB {
            cache: std::mem::take(&mut self.cache),
            db: &reader,
        };
        let mut failed = None;
        while self.next < end {
            let next = self.next;
            let tracer = program.tracers[next].as_ref();
            reader.step.set(next);
            if let Step::Overrides(overrides) = &program.steps[next] {
                let mut trial = CacheDB {
                    cache: db.cache.clone(),
                    db: &reader,
                };
                let applied =
                    alloy_evm::overrides::apply_state_overrides(overrides.clone(), &mut trial);
                if reader.missed() > 0 {
                    failed = Some(Default::default());
                    break;
                }
                applied
                    .map_err(|e| Error::InvalidParams(format!("invalid state overrides: {e}")))?;
                db.cache = trial.cache;
                self.next += 1;
                continue;
            }
            // A struct-logged step first runs untraced until it needs no read: struct logs
            // are recorded once.
            if tracer.is_some_and(Tracer::logs_steps) {
                let plain = run_step(&program.env, &program.steps[next], None, &db, limits)?;
                if reader.missed() > 0 {
                    failed = Some(plain.state);
                    break;
                }
            }
            let ran = run_step(&program.env, &program.steps[next], tracer, &db, limits)?;
            if reader.missed() > 0 {
                failed = Some(ran.state);
                break;
            }
            let output = match (&program.steps[next], ran.result) {
                (Step::System { .. } | Step::Dao | Step::Overrides(_), _) => None,
                (Step::Tx { call, .. }, Err(invalid)) => {
                    return Err(if call.is_some() {
                        Error::Rejected(rejected(&invalid))
                    } else {
                        Error::Unavailable(format!(
                            "replayed transaction {next} is invalid: {invalid}"
                        ))
                    });
                }
                (Step::Tx { tx, .. }, Ok(result)) => {
                    let recorded = ran
                        .inspector
                        .as_ref()
                        .map_or((0, 0), |guard| (guard.struct_logs, guard.struct_log_bytes));
                    let trace = match (tracer, ran.inspector) {
                        (Some(tracer), Some(inspector)) => Some(finish(
                            tracer,
                            inspector,
                            tx,
                            &program.env,
                            &result,
                            &ran.state,
                            &db,
                        )?),
                        _ => None,
                    };
                    // Building a trace may read the pre-state (prestate and state diff
                    // tracers).
                    if reader.missed() > 0 {
                        failed = Some(ran.state);
                        break;
                    }
                    {
                        let mut used = limits.used.borrow_mut();
                        used.struct_logs += recorded.0;
                        used.struct_log_bytes += recorded.1;
                    }
                    let log_offset = self.logs;
                    self.logs += result.logs().len() as u64;
                    Some(Output { trace, log_offset })
                }
            };
            db.commit(ran.state);
            self.outputs[next] = output;
            self.next += 1;
        }
        if let Some(state) = failed {
            // Explore the rest of the program on a scratch copy.
            let mut scratch = CacheDB {
                cache: db.cache.clone(),
                db: &reader,
            };
            scratch.commit(state);
            // Bounded by gas: placeholder runs of heavy transactions cost CPU without being
            // kept. Heavy steps that already ran in exploration without missing are skipped
            // but every 8th round; light steps always run, their reads may depend on earlier
            // steps.
            let mut explored = 0u64;
            let revisit = limits.used.borrow().rounds.is_multiple_of(8);
            for (index, step) in program
                .steps
                .iter()
                .enumerate()
                .take(end)
                .skip(self.next + 1)
            {
                if explored >= limits.explore_gas {
                    break;
                }
                if self.clean[index] && !revisit {
                    continue;
                }
                reader.step.set(index);
                let before = reader.missed();
                if let Step::Overrides(overrides) = step {
                    let _ = alloy_evm::overrides::apply_state_overrides(
                        overrides.clone(),
                        &mut scratch,
                    );
                    continue;
                }
                // Placeholder values may make a step fail: only its reads matter here.
                match run_step(&program.env, step, None, &scratch, limits) {
                    Ok(ran) => {
                        explored += ran.gas;
                        self.clean[index] = reader.missed() == before && ran.gas >= HEAVY_GAS;
                        scratch.commit(ran.state);
                    }
                    Err(Error::Limit(message)) => return Err(Error::Limit(message)),
                    Err(_) => {}
                }
            }
        }
        self.cache = db.cache;
        Ok(reader.misses.take())
    }
}

struct Ran {
    /// Gas the execution used (0 when rejected).
    gas: u64,
    result: Result<ExecutionResult<HaltReason>, InvalidTransaction>,
    state: revm::state::EvmState,
    inspector: Option<Guard>,
}

type Db<'a, 'k> = CacheDB<&'a KnownRef<'k>>;

/// Execute one step on `db` without committing.
fn run_step(
    env: &EvmEnv,
    step: &Step,
    tracer: Option<&Tracer>,
    db: &Db<'_, '_>,
    limits: &Limits,
) -> Result<Ran, Error> {
    let mut ran = execute_step(env, step, tracer, db, limits)?;
    ran.gas = ran.result.as_ref().map_or(0, |r| r.tx_gas_used());
    limits.charge_executed(ran.gas)?;
    Ok(ran)
}

fn execute_step(
    env: &EvmEnv,
    step: &Step,
    tracer: Option<&Tracer>,
    db: &Db<'_, '_>,
    limits: &Limits,
) -> Result<Ran, Error> {
    let factory = EthEvmFactory::default();
    let tx = match step {
        Step::System { contract, data } => {
            let mut evm = untraced_evm(db, env.clone());
            let ResultAndState { result, state } = evm
                .transact_system_call(SYSTEM_ADDRESS, *contract, data.clone())
                .map_err(|e| system_error(e, *contract))?;
            return Ok(Ran {
                gas: 0,
                result: Ok(result),
                state,
                inspector: None,
            });
        }
        Step::Dao => {
            return Ok(Ran {
                gas: 0,
                result: Ok(ExecutionResult::Success {
                    reason: revm::context::result::SuccessReason::Stop,
                    gas: Default::default(),
                    logs: Vec::new(),
                    output: revm::context::result::Output::Call(Bytes::new()),
                }),
                state: dao_state(db),
                inspector: None,
            });
        }
        Step::Overrides(_) => unreachable!("overrides are applied by the replayer"),
        Step::Tx { tx, .. } => tx,
    };
    let mut env = env.clone();
    if let Step::Tx {
        call: Some(flags), ..
    } = step
    {
        env.cfg_env.disable_base_fee = flags.free;
        env.cfg_env.disable_nonce_check = !flags.nonce;
        if flags.free {
            // Geth and Erigon run a call without fees with a zero base fee
            // (BASEFEE reads 0), and a zero blob base fee without a blob fee cap.
            env.block_env.basefee = 0;
            if tx.max_fee_per_blob_gas == 0
                && let Some(blob) = env.block_env.blob_excess_gas_and_price.as_mut()
            {
                blob.blob_gasprice = 0;
            }
        }
    }
    let Some(tracer) = tracer else {
        let mut evm = untraced_evm(db, env);
        return match evm.transact((**tx).clone()) {
            Ok(ResultAndState { result, state }) => Ok(Ran {
                gas: 0,
                result: Ok(result),
                state,
                inspector: None,
            }),
            Err(error) => evm_error(error),
        };
    };
    let guard = Guard::new(tracer, limits, &limits.used.borrow())?;
    let mut evm = factory.create_evm_with_inspector(WrapDatabaseRef(db), env, guard);
    let outcome = evm.transact((**tx).clone());
    let (_, guard, _) = evm.components_mut();
    let guard = std::mem::replace(guard, Guard::empty());
    limits.used.borrow_mut().steps += guard.steps;
    if let Some(message) = guard.exceeded {
        return Err(Error::Limit(message.into()));
    }
    match outcome {
        Ok(ResultAndState { result, state }) => Ok(Ran {
            gas: 0,
            result: Ok(result),
            state,
            inspector: Some(guard),
        }),
        Err(error) => evm_error(error),
    }
}

/// One EVM type for traced and untraced runs (an untraced run disables the
/// inspector): one instantiation of revm's handler instead of two keeps the
/// Worker's WASM smaller.
fn untraced_evm<'a, 'k>(
    db: &'a Db<'a, 'k>,
    env: EvmEnv,
) -> <EthEvmFactory as EvmFactory>::Evm<WrapDatabaseRef<&'a Db<'a, 'k>>, Guard> {
    let mut evm = EthEvmFactory::default().create_evm_with_inspector(
        WrapDatabaseRef(db),
        env,
        Guard::empty(),
    );
    evm.disable_inspector();
    evm
}

fn evm_error(error: EVMError<MissError>) -> Result<Ran, Error> {
    match error {
        EVMError::Transaction(invalid) => Ok(Ran {
            gas: 0,
            result: Err(invalid),
            state: Default::default(),
            inspector: None,
        }),
        EVMError::Custom(message) => Err(Error::Limit(message)),
        // Placeholder values (a miss) can make a header or database check
        // fail; the caller sees the recorded misses and retries.
        EVMError::Database(_) => Ok(Ran {
            gas: 0,
            result: Err(InvalidTransaction::NonceOverflowInTransaction),
            state: Default::default(),
            inspector: None,
        }),
        other => Err(Error::Unavailable(format!("execution failed: {other}"))),
    }
}

fn system_error(error: EVMError<MissError>, contract: Address) -> Error {
    Error::Unavailable(format!("system call to {contract} failed: {error}"))
}

/// Build the trace of a kept execution; `db` is the state before it.
fn finish(
    tracer: &Tracer,
    guard: Guard,
    tx: &TxEnv,
    env: &EvmEnv,
    result: &ExecutionResult<HaltReason>,
    state: &revm::state::EvmState,
    db: &Db<'_, '_>,
) -> Result<Traced, Error> {
    let unavailable = |e: &dyn std::fmt::Display| Error::Unavailable(e.to_string());
    Ok(match (tracer, guard.inner) {
        (Tracer::Geth { context, .. }, Inner::Debug(mut inspector)) => {
            let res = ResultAndState {
                result: result.clone(),
                state: state.clone(),
            };
            let mut trace = inspector
                .get_result(Some(*context), tx, &env.block_env, &res, &mut &*db)
                .map_err(|e| unavailable(&e))?;
            // Geth drops accounts the transaction created from the prestate
            // when they did not exist before it (storage it touched is zero).
            let mut absent = Vec::new();
            // Accounts that did not exist before (no balance, nonce or code)
            // are dropped too, unless storage was read from them.
            let existed =
                |address: &Address, account: &alloy_rpc_types_trace::geth::AccountState| {
                    let created = state.get(address).is_some_and(|a| a.is_created());
                    account.balance.is_some_and(|b| !b.is_zero())
                        || account.nonce.is_some_and(|n| n > 0)
                        || account.code.as_ref().is_some_and(|c| !c.is_empty())
                        || (!created && !account.storage.is_empty())
                };
            match &mut trace {
                GethTrace::PreStateTracer(PreStateFrame::Default(mode)) => {
                    mode.0.retain(|address, account| existed(address, account));
                }
                GethTrace::PreStateTracer(PreStateFrame::Diff(diff)) => {
                    // Erigon lists a touched account that exists neither
                    // before nor after with a zero code hash in `post`.
                    for (address, account) in &diff.pre {
                        if !existed(address, account)
                            && !diff.post.contains_key(address)
                            && state.get(address).is_none_or(|a| a.info.is_empty())
                        {
                            absent.push(*address);
                        }
                    }
                    diff.pre
                        .retain(|address, account| existed(address, account));
                }
                _ => {}
            }
            let mut hashes = code_hashes(&trace, state, db);
            hashes.absent = absent;
            if tracer.logs_steps() {
                hashes.refund = auth_refund(tx, env.cfg_env.chain_id, db);
            }
            Traced::Geth(Box::new(trace), hashes)
        }
        // Parity root traces keep the frame's gas (after intrinsic gas) and
        // its gas used before refunds, like OpenEthereum and Erigon.
        (Tracer::Parity { types }, Inner::Tracing(inspector)) => {
            let builder = inspector.into_parity_builder();
            Traced::Parity(
                builder
                    .into_trace_results_with_state_parts(result, state, types, db)
                    .map_err(|e| unavailable(&e))?,
            )
        }
        (Tracer::Localized { info }, Inner::Tracing(inspector)) => {
            let builder = inspector.into_parity_builder();
            Traced::Localized(builder.into_localized_transaction_traces(*info))
        }
        _ => unreachable!("guard inspector matches its tracer"),
    })
}

/// Code hashes of the prestate tracer's accounts with code.
fn code_hashes(trace: &GethTrace, state: &revm::state::EvmState, db: &Db<'_, '_>) -> CodeHashes {
    use revm::DatabaseRef;
    let mut hashes = CodeHashes::default();
    let pre_hash = |address: &Address| {
        db.basic_ref(*address)
            .ok()
            .flatten()
            .map(|info| info.code_hash)
            .filter(|hash| *hash != alloy_primitives::KECCAK256_EMPTY)
    };
    match trace {
        GethTrace::PreStateTracer(PreStateFrame::Default(mode)) => {
            for address in mode.0.keys() {
                if let Some(hash) = pre_hash(address) {
                    hashes.pre.insert(*address, hash);
                }
            }
        }
        GethTrace::PreStateTracer(PreStateFrame::Diff(diff)) => {
            for address in diff.pre.keys() {
                if let Some(hash) = pre_hash(address) {
                    hashes.pre.insert(*address, hash);
                }
            }
            // Post: where the code changed, including to no code (a
            // cleared EIP-7702 delegation reports `code: "0x"`).
            for address in diff.post.keys() {
                let pre = pre_hash(address).unwrap_or(alloy_primitives::KECCAK256_EMPTY);
                if let Some(post) = state.get(address).map(|account| account.info.code_hash)
                    && post != pre
                {
                    hashes.post.insert(*address, post);
                }
            }
        }
        _ => {}
    }
    hashes
}

/// Geth-compatible text for a rejected call.
fn rejected(invalid: &InvalidTransaction) -> String {
    match invalid {
        InvalidTransaction::LackOfFundForMaxFee { .. } => {
            "insufficient funds for gas * price + value".into()
        }
        InvalidTransaction::GasPriceLessThanBasefee => {
            "max fee per gas less than block base fee".into()
        }
        InvalidTransaction::NonceTooLow { .. } => "nonce too low".into(),
        InvalidTransaction::NonceTooHigh { .. } => "nonce too high".into(),
        InvalidTransaction::CallGasCostMoreThanGasLimit { .. } => "intrinsic gas too low".into(),
        InvalidTransaction::GasFloorMoreThanGasLimit { .. } => {
            "insufficient gas for floor data gas cost".into()
        }
        other => other.to_string(),
    }
}

enum Inner {
    Debug(DebugInspector),
    Tracing(TracingInspector),
    None,
}

/// The step's inspector behind request-wide budgets: opcode steps executed
/// under inspection, struct log entries and their estimated JSON size. Over
/// a budget, execution halts with a custom error (reported as a limit).
struct Guard {
    inner: Inner,
    steps_left: u64,
    steps: u64,
    /// Struct logs are recorded (the default Geth tracer).
    struct_logger: bool,
    stack: bool,
    memory: bool,
    struct_logs_left: u64,
    log_bytes_left: u64,
    struct_logs: u64,
    struct_log_bytes: u64,
    exceeded: Option<&'static str>,
    skip_precompiles: bool,
}

impl Guard {
    fn empty() -> Self {
        Self {
            inner: Inner::None,
            steps_left: 0,
            steps: 0,
            struct_logger: false,
            stack: false,
            memory: false,
            struct_logs_left: 0,
            log_bytes_left: 0,
            struct_logs: 0,
            struct_log_bytes: 0,
            exceeded: None,
            skip_precompiles: false,
        }
    }

    fn new(tracer: &Tracer, limits: &Limits, usage: &Usage) -> Result<Self, Error> {
        let trace_limits = TraceLimits::default()
            .set_max_recorded_bytes(Some(limits.max_recorded_bytes))
            .set_behavior(TraceLimitBehavior::Halt);
        let mut guard = Self::empty();
        guard.inner = match tracer {
            Tracer::Geth { options, .. } => {
                guard.skip_precompiles = options
                    .tracer
                    .as_ref()
                    .is_some_and(|t| t.as_str() == "4byteTracer");
                if options
                    .tracer
                    .as_ref()
                    .is_none_or(|t| t.as_str().is_empty())
                {
                    guard.struct_logger = true;
                    guard.stack = !options.config.disable_stack.unwrap_or(false);
                    guard.memory = options.config.enable_memory.unwrap_or(false);
                }
                let mut inspector = DebugInspector::new(options.clone())
                    .map_err(|e| Error::InvalidParams(e.to_string()))?;
                if let DebugInspector::Default(inner, _)
                | DebugInspector::CallTracer(inner, _)
                | DebugInspector::PreStateTracer(inner, _)
                | DebugInspector::FlatCallTracer(inner) = &mut inspector
                {
                    *inner = std::mem::take(inner).with_limits(trace_limits);
                }
                Inner::Debug(inspector)
            }
            Tracer::Parity { types } => Inner::Tracing(
                TracingInspector::new(TracingInspectorConfig::from_parity_config(types))
                    .with_limits(trace_limits),
            ),
            Tracer::Localized { .. } => Inner::Tracing(
                TracingInspector::new(TracingInspectorConfig::default_parity())
                    .with_limits(trace_limits),
            ),
        };
        guard.steps_left = limits.max_steps.saturating_sub(usage.steps);
        guard.struct_logs_left = limits.max_struct_logs.saturating_sub(usage.struct_logs);
        guard.log_bytes_left = limits
            .max_struct_log_bytes
            .saturating_sub(usage.struct_log_bytes);
        Ok(guard)
    }

    fn halt<CTX: ContextTr>(
        &mut self,
        message: &'static str,
        interp: &mut Interpreter,
        context: &mut CTX,
    ) {
        self.exceeded = Some(message);
        if context.error().is_ok() {
            *context.error() = Err(ContextError::Custom(message.into()));
        }
        interp.bytecode.action().take();
        interp.bytecode.reset_action();
        interp.halt_fatal();
    }
}

macro_rules! delegate {
    ($self:expr => $insp:ident . $method:ident ( $($arg:expr),* ), $default:expr) => {
        match &mut $self.inner {
            Inner::Debug($insp) => Inspector::<CTX>::$method($insp, $($arg),*),
            Inner::Tracing($insp) => Inspector::<CTX>::$method($insp, $($arg),*),
            Inner::None => $default,
        }
    };
}

impl<CTX> Inspector<CTX> for Guard
where
    CTX: ContextTr<Journal: JournalExt>,
{
    fn initialize_interp(&mut self, interp: &mut Interpreter, context: &mut CTX) {
        delegate!(self => i.initialize_interp(interp, context), ())
    }

    fn step(&mut self, interp: &mut Interpreter, context: &mut CTX) {
        if self.exceeded.is_some() {
            return;
        }
        if self.steps_left == 0 {
            return self.halt(STEP_LIMIT, interp, context);
        }
        self.steps_left -= 1;
        self.steps += 1;
        if self.struct_logger {
            // The entry's JSON size, estimated: fields, stack items and
            // memory words as hex.
            let mut bytes = 110;
            if self.stack {
                bytes += 24 * interp.stack.len() as u64;
            }
            if self.memory {
                bytes += 70 * (interp.memory.size() as u64).div_ceil(32);
            }
            if self.struct_logs_left == 0 || self.log_bytes_left < bytes {
                return self.halt(STRUCT_LOG_LIMIT, interp, context);
            }
            self.struct_logs_left -= 1;
            self.log_bytes_left -= bytes;
            self.struct_logs += 1;
            self.struct_log_bytes += bytes;
        }
        delegate!(self => i.step(interp, context), ())
    }

    fn step_end(&mut self, interp: &mut Interpreter, context: &mut CTX) {
        if self.exceeded.is_some() {
            return;
        }
        delegate!(self => i.step_end(interp, context), ())
    }

    fn log(&mut self, context: &mut CTX, log: Log) {
        delegate!(self => i.log(context, log), ())
    }

    fn log_full(&mut self, interp: &mut Interpreter, context: &mut CTX, log: Log) {
        delegate!(self => i.log_full(interp, context, log), ())
    }

    fn call(&mut self, context: &mut CTX, inputs: &mut CallInputs) -> Option<CallOutcome> {
        // Geth's 4byte tracer skips calls into precompiles.
        if self.skip_precompiles
            && context
                .journal_ref()
                .precompile_addresses()
                .contains(&inputs.bytecode_address)
        {
            return None;
        }
        delegate!(self => i.call(context, inputs), None)
    }

    fn call_end(&mut self, context: &mut CTX, inputs: &CallInputs, outcome: &mut CallOutcome) {
        delegate!(self => i.call_end(context, inputs, outcome), ())
    }

    fn create(&mut self, context: &mut CTX, inputs: &mut CreateInputs) -> Option<CreateOutcome> {
        delegate!(self => i.create(context, inputs), None)
    }

    fn create_end(
        &mut self,
        context: &mut CTX,
        inputs: &CreateInputs,
        outcome: &mut CreateOutcome,
    ) {
        delegate!(self => i.create_end(context, inputs, outcome), ())
    }

    fn selfdestruct(&mut self, contract: Address, target: Address, value: U256) {
        match &mut self.inner {
            Inner::Debug(i) => Inspector::<CTX>::selfdestruct(i, contract, target, value),
            Inner::Tracing(i) => Inspector::<CTX>::selfdestruct(i, contract, target, value),
            Inner::None => {}
        }
    }

    fn frame_start(
        &mut self,
        context: &mut CTX,
        frame_input: &mut FrameInput,
    ) -> Option<FrameResult> {
        delegate!(self => i.frame_start(context, frame_input), None)
    }

    fn frame_end(
        &mut self,
        context: &mut CTX,
        frame_input: &FrameInput,
        frame_result: &mut FrameResult,
    ) {
        delegate!(self => i.frame_end(context, frame_input, frame_result), ())
    }
}

/// Keys every block replay reads: saves discovery rounds.
pub(crate) fn block_hints(
    beneficiary: Address,
    system: &[(Address, Vec<U256>)],
    txs: &[TxHints],
) -> BTreeSet<Miss> {
    let mut reads = BTreeSet::new();
    reads.insert(Miss::Account(beneficiary));
    for (address, slots) in system {
        reads.insert(Miss::Account(*address));
        for slot in slots {
            reads.insert(Miss::Storage(*address, *slot));
        }
    }
    for (sender, to, access_list, delegations) in txs {
        reads.insert(Miss::Account(*sender));
        if let Some(to) = to {
            reads.insert(Miss::Account(*to));
        }
        for (address, keys) in access_list {
            reads.insert(Miss::Account(*address));
            for key in keys {
                reads.insert(Miss::Storage(*address, U256::from_be_bytes(key.0)));
            }
        }
        for address in delegations {
            reads.insert(Miss::Account(*address));
        }
    }
    reads
}

/// The DAO fork: every drained account's balance moves to the refund contract.
fn dao_state(db: &Db<'_, '_>) -> revm::state::EvmState {
    use alloy_evm::eth::dao_fork::{DAO_HARDFORK_ACCOUNTS, DAO_HARDFORK_BENEFICIARY};
    use revm::DatabaseRef;
    let mut state = revm::state::EvmState::default();
    let mut drained = U256::ZERO;
    for address in DAO_HARDFORK_ACCOUNTS {
        if let Some(info) = db.basic_ref(address).ok().flatten() {
            drained += info.balance;
            let mut account = revm::state::Account::from(AccountInfo {
                balance: U256::ZERO,
                ..info
            });
            account.mark_touch();
            state.insert(address, account);
        }
    }
    let info = db
        .basic_ref(DAO_HARDFORK_BENEFICIARY)
        .ok()
        .flatten()
        .unwrap_or_default();
    let mut account = revm::state::Account::from(AccountInfo {
        balance: info.balance + drained,
        ..info
    });
    account.mark_touch();
    state.insert(DAO_HARDFORK_BENEFICIARY, account);
    state
}
