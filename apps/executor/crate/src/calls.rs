//! `eth_call`, `eth_estimateGas` and `eth_createAccessList` on the post-state of a block,
//! ported from exe-execution `executor` (go-ethereum semantics and error texts).
//!
//! The executor never awaits reads: each attempt runs the whole algorithm from the start over
//! the values known so far. An execution that misses a value continues on placeholders to
//! discover what else it needs, and the attempt stops with every key missed. Executions that
//! completed without misses are memoized, so an attempt re-runs only what earlier ones could
//! not finish.

use crate::{
    access_list::AccessListTracer,
    limits::{Error, Limits},
    options::Overrides,
    state::{Known, KnownRef, Miss},
};
use alloy_evm::{EthEvmFactory, Evm, EvmEnv, EvmFactory};
use alloy_primitives::{Address, B256, Bytes, KECCAK256_EMPTY, TxKind, U256};
use revm::{
    Database,
    context::{
        Cfg, TxEnv,
        result::{EVMError, ExecutionResult, HaltReason, InvalidTransaction},
    },
    database::CacheDB,
    state::AccountInfo,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};

/// The gas of a call that names none, and the most a call may use.
pub const MAX_CALL_GAS: u64 = 5_000_000;
/// EIP-7825 transaction gas cap: the most an estimate may return.
pub const MAX_ESTIMATE_GAS: u64 = 1 << 24;
/// Executions of the binary search after the first two (bounds CPU).
pub const MAX_ESTIMATE_ITERATIONS: usize = 24;
/// Geth's `eth_estimateGas` error ratio (`internal/ethapi`).
const ESTIMATE_ERROR_RATIO: f64 = 0.015;
const TX_GAS: u64 = 21_000;
const CALL_STIPEND: u64 = 2_300;
/// Rounds of `eth_createAccessList` before it gives up on a fixed point.
const MAX_ACCESS_LIST_ROUNDS: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallKind {
    Call,
    Estimate,
    AccessList,
}

/// One call request, ready to run.
pub struct CallJob {
    kind: CallKind,
    tx: TxEnv,
    env: EvmEnv,
    requested_gas: Option<u64>,
    block_gas_limit: u64,
    state: Option<alloy_rpc_types_eth::state::StateOverride>,
    /// The block the call runs on.
    pub block_hash: B256,
    /// Completed executions by (gas limit, access list round).
    memo: HashMap<(u64, usize), Run>,
}

/// One execution's result.
#[derive(Clone, Debug)]
enum Run {
    Done(ExecutionResult),
    Invalid(InvalidTransaction),
    /// With the access list it traced.
    Traced(ExecutionResult, Vec<(Address, Vec<B256>)>),
}

/// Why an attempt stopped.
pub enum Stop {
    /// Values are missing (collected in the attempt).
    Need,
    Fail(Error),
}

impl From<Error> for Stop {
    fn from(error: Error) -> Self {
        Self::Fail(error)
    }
}

/// A JSON-RPC error.
#[derive(Clone, Debug)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    /// Geth's revert error: code 3, the decoded `Error(string)` or `Panic` reason in the
    /// message, the raw revert data as `data`.
    pub fn reverted(output: &[u8]) -> Self {
        Self {
            code: 3,
            message: match revert_reason(output) {
                Some(reason) => format!("execution reverted: {reason}"),
                None => "execution reverted".into(),
            },
            data: Some(json!(format!("0x{}", hex::encode(output)))),
        }
    }

    pub fn to_json(&self) -> Value {
        let mut error = json!({"code": self.code, "message": self.message});
        if let Some(data) = &self.data {
            error["data"] = data.clone();
        }
        error
    }
}

/// The ABI-decoded reason of revert data (`Error(string)`, `Panic(uint256)`).
pub fn revert_reason(data: &[u8]) -> Option<String> {
    const ERROR: [u8; 4] = [0x08, 0xc3, 0x79, 0xa0];
    const PANIC: [u8; 4] = [0x4e, 0x48, 0x7b, 0x71];
    let (selector, body) = (data.get(..4)?, &data[4..]);
    let word = |at: usize| -> Option<U256> {
        Some(U256::from_be_slice(body.get(at..at.checked_add(32)?)?))
    };
    if selector == ERROR {
        let offset = usize::try_from(word(0)?).ok()?;
        let length = usize::try_from(word(offset)?).ok()?;
        let start = offset.checked_add(32)?;
        let text = body.get(start..start.checked_add(length)?)?;
        return String::from_utf8(text.to_vec()).ok();
    }
    if selector == PANIC {
        let code = word(0)?;
        let reason = match u64::try_from(code).ok() {
            Some(0x00) => "generic panic",
            Some(0x01) => "assert(false)",
            Some(0x11) => "arithmetic underflow or overflow",
            Some(0x12) => "division or modulo by zero",
            Some(0x21) => "enum overflow",
            Some(0x22) => "invalid encoded storage byte array accessed",
            Some(0x31) => "out-of-bounds array access; popping on an empty array",
            Some(0x32) => "out-of-bounds access of an array or bytesN",
            Some(0x41) => "out of memory",
            Some(0x51) => "uninitialized function",
            _ => return Some(format!("unknown panic code: {code:#x}")),
        };
        return Some(reason.into());
    }
    None
}

/// An exceptional halt as go-ethereum reports it: its `vm` error text.
pub fn halt_message(reason: &HaltReason) -> String {
    let name = format!("{reason:?}");
    match name.as_str() {
        _ if name.starts_with("OutOfGas") => "out of gas",
        "OpcodeNotFound" | "InvalidFEOpcode" => "invalid opcode: INVALID",
        "InvalidJump" => "invalid jump destination",
        "OutOfOffset" => "return data out of bounds",
        "CreateCollision" => "contract address collision",
        "NonceOverflow" => "nonce uint64 overflow",
        "CreateContractSizeLimit" => "max code size exceeded",
        "CreateContractStartingWithEF" => "invalid code: must not begin with 0xef",
        "CreateInitCodeSizeLimit" => "max initcode size exceeded",
        "StateChangeDuringStaticCall" | "CallNotAllowedInsideStatic" => "write protection",
        "OutOfFunds" => "insufficient balance for transfer",
        "CallTooDeep" => "max call depth exceeded",
        "StackUnderflow" => "stack underflow",
        "StackOverflow" => "stack limit reached",
        _ => return format!("execution halted: {name}"),
    }
    .into()
}

/// Geth-compatible text for transaction validation failures (`core` errors as go-ethereum
/// formats them).
fn rejected(invalid: &InvalidTransaction, tx: &TxEnv, base_fee: u64) -> Error {
    let max_fee = tx.gas_price;
    let tip = tx.gas_priority_fee.unwrap_or(max_fee);
    Error::Rejected(match invalid {
        InvalidTransaction::LackOfFundForMaxFee { fee, balance } => format!(
            "insufficient funds for gas * price + value: address {} have {balance} want {fee}",
            tx.caller
        ),
        InvalidTransaction::GasPriceLessThanBasefee => format!(
            "max fee per gas less than block base fee: address {}, maxFeePerGas: {max_fee}, baseFee: {base_fee}",
            tx.caller
        ),
        InvalidTransaction::PriorityFeeGreaterThanMaxFee => format!(
            "max priority fee per gas higher than max fee per gas: address {}, maxPriorityFeePerGas: {tip}, maxFeePerGas: {max_fee}",
            tx.caller
        ),
        InvalidTransaction::NonceTooLow { .. } => "nonce too low".into(),
        InvalidTransaction::NonceTooHigh { .. } => "nonce too high".into(),
        InvalidTransaction::CallGasCostMoreThanGasLimit {
            initial_gas,
            gas_limit,
        } => format!("intrinsic gas too low: have {gas_limit}, want {initial_gas}"),
        InvalidTransaction::GasFloorMoreThanGasLimit { .. } => {
            "insufficient gas for floor data gas cost".into()
        }
        InvalidTransaction::EmptyBlobs => "blob transaction missing blob hashes".into(),
        InvalidTransaction::BlobCreateTransaction => "blob transaction of type create".into(),
        InvalidTransaction::EmptyAuthorizationList => {
            "EIP-7702 transaction with empty auth list".into()
        }
        other => other.to_string(),
    })
}

/// One attempt: the known values and the keys missed so far.
struct Attempt<'a> {
    known: &'a Known,
    limits: &'a Limits,
    misses: BTreeMap<Miss, usize>,
}

impl CallJob {
    /// The call request (go-ethereum `TransactionArgs`) on the post-state of the block of
    /// `env`, with its overrides.
    pub fn new(
        kind: CallKind,
        request: &Value,
        mut env: EvmEnv,
        block_gas_limit: u64,
        overrides: &Overrides,
        known: &mut Known,
    ) -> Result<Self, Error> {
        let (tx, free_call, requested_gas) = parse_tx(request, env.cfg_env.chain_id)?;
        for (number, hash) in overrides.apply_block(&mut env) {
            known.insert_hash(number, hash);
        }
        // go-ethereum's call configuration: no nonce check, no EIP-3607 check, no base-fee
        // check when the call names no fee, and a zero blob base fee for a blob call with a
        // zero blob fee cap.
        env.cfg_env.disable_nonce_check = true;
        env.cfg_env.disable_eip3607 = true;
        env.cfg_env.disable_base_fee = free_call;
        env.cfg_env.memory_limit = 16 * 1024 * 1024;
        if free_call {
            env.block_env.basefee = 0;
        }
        if tx.tx_type == 3
            && tx.max_fee_per_blob_gas == 0
            && let Some(blob) = env.block_env.blob_excess_gas_and_price.as_mut()
        {
            blob.blob_gasprice = 0;
        }
        Ok(Self {
            kind,
            tx,
            env,
            requested_gas,
            block_gas_limit,
            state: overrides.state.clone(),
            memo: HashMap::new(),
            block_hash: B256::ZERO,
        })
    }

    /// Run the request as far as `known` allows: its JSON-RPC result or error, or the keys
    /// it needs.
    pub fn attempt(
        &mut self,
        known: &Known,
        limits: &Limits,
    ) -> Result<Result<Value, RpcError>, BTreeMap<Miss, usize>> {
        let mut attempt = Attempt {
            known,
            limits,
            misses: BTreeMap::new(),
        };
        let outcome = match self.kind {
            CallKind::Call => self.call(&mut attempt),
            CallKind::Estimate => self.estimate(&mut attempt),
            CallKind::AccessList => self.access_list(&mut attempt),
        };
        match outcome {
            Ok(value) => Ok(Ok(value)),
            Err(Stop::Need) => Err(attempt.misses),
            Err(Stop::Fail(error)) => Ok(Err(error_json(error))),
        }
    }

    fn base_fee(&self) -> u64 {
        self.env.block_env.basefee
    }

    /// Execute `tx` (or take its memoized result).
    fn exec(
        &mut self,
        attempt: &mut Attempt<'_>,
        tx: &TxEnv,
        round: usize,
        tracer: Option<&AccessListTracer>,
    ) -> Result<Run, Stop> {
        let key = (tx.gas_limit, round);
        if let Some(run) = self.memo.get(&key) {
            return Ok(run.clone());
        }
        let reader = KnownRef::new(attempt.known);
        let mut db = CacheDB::new(&reader);
        if let Some(state) = &self.state {
            let applied = alloy_evm::overrides::apply_state_overrides(state.clone(), &mut db);
            if reader.missed() == 0 {
                applied
                    .map_err(|e| Error::InvalidParams(format!("invalid state overrides: {e}")))?;
            }
        }
        let factory = EthEvmFactory::default();
        let (outcome, traced) = match tracer {
            None => {
                let mut evm = factory.create_evm(&mut db, self.env.clone());
                (evm.transact(tx.clone()), None)
            }
            Some(tracer) => {
                let mut evm =
                    factory.create_evm_with_inspector(&mut db, self.env.clone(), tracer.clone());
                let outcome = evm.transact(tx.clone());
                (outcome, Some(evm.inspector().list()))
            }
        };
        let gas = outcome
            .as_ref()
            .map_or(0, |result| result.result.tx_gas_used());
        attempt.limits.charge_executed(gas)?;
        let missed = reader.misses.take();
        if !missed.is_empty() {
            attempt.misses.extend(missed);
            return Err(Stop::Need);
        }
        let run = match (outcome, traced) {
            (Ok(result), Some(list)) => Run::Traced(result.result, list),
            (Ok(result), None) => Run::Done(result.result),
            (Err(EVMError::Transaction(invalid)), _) => Run::Invalid(invalid),
            (Err(error), _) => {
                return Err(Error::Unavailable(format!("execution failed: {error}")).into());
            }
        };
        self.memo.insert(key, run.clone());
        Ok(run)
    }

    /// The account as the call sees it (after state overrides).
    fn account(
        &self,
        attempt: &mut Attempt<'_>,
        address: Address,
    ) -> Result<Option<AccountInfo>, Stop> {
        let reader = KnownRef::new(attempt.known);
        let mut db = CacheDB::new(&reader);
        if let Some(state) = &self.state {
            let _ = alloy_evm::overrides::apply_state_overrides(state.clone(), &mut db);
        }
        let account = db.basic(address).ok().flatten();
        let missed = reader.misses.take();
        if !missed.is_empty() {
            attempt.misses.extend(missed);
            return Err(Stop::Need);
        }
        Ok(account)
    }

    /// The call's gas: the request's, capped at [`MAX_CALL_GAS`] and the block gas limit.
    fn call_tx(&self) -> TxEnv {
        let cap = MAX_CALL_GAS.min(self.block_gas_limit);
        let mut tx = self.tx.clone();
        tx.gas_limit = self.requested_gas.unwrap_or(cap).min(cap);
        tx
    }

    fn call(&mut self, attempt: &mut Attempt<'_>) -> Result<Value, Stop> {
        let tx = self.call_tx();
        match self.exec(attempt, &tx, 0, None)? {
            Run::Done(ExecutionResult::Success { output, .. }) => Ok(json!(output.into_data())),
            Run::Done(ExecutionResult::Revert { output, .. }) => Err(revert_stop(&output)),
            Run::Done(ExecutionResult::Halt { reason, .. }) => {
                Err(Stop::Fail(Error::Rejected(halt_message(&reason))))
            }
            Run::Invalid(invalid) => Err(rejected(&invalid, &tx, self.base_fee()).into()),
            Run::Traced(..) => unreachable!("untraced"),
        }
    }

    /// `eth_createAccessList` like go-ethereum: run the call under an access-list tracer,
    /// starting from the request's list, and again with each traced list until the list no
    /// longer changes; return it with that run's gas and error.
    fn access_list(&mut self, attempt: &mut Attempt<'_>) -> Result<Value, Stop> {
        if !self
            .env
            .cfg_env
            .spec
            .is_enabled_in(revm::primitives::hardfork::SpecId::BERLIN)
        {
            return Err(Error::Rejected("eip-2930 transactions require Berlin".into()).into());
        }
        let mut tx = self.call_tx();
        let mut list: Vec<(Address, Vec<B256>)> = tx
            .access_list
            .0
            .iter()
            .map(|item| (item.address, item.storage_keys.clone()))
            .collect();
        for round in 0..MAX_ACCESS_LIST_ROUNDS {
            tx.access_list = alloy_eips::eip2930::AccessList(
                list.iter()
                    .map(|(address, slots)| alloy_eips::eip2930::AccessListItem {
                        address: *address,
                        storage_keys: slots.clone(),
                    })
                    .collect(),
            );
            if tx.tx_type == 0 && !list.is_empty() {
                tx.tx_type = 1;
            }
            let tracer = AccessListTracer::new(&list);
            let (result, traced) = match self.exec(attempt, &tx, round + 1, Some(&tracer))? {
                Run::Traced(result, traced) => (result, traced),
                Run::Invalid(invalid) => {
                    return Err(rejected(&invalid, &tx, self.base_fee()).into());
                }
                Run::Done(_) => unreachable!("traced"),
            };
            if AccessListTracer::same(&traced, &list) {
                // go-ethereum lists addresses and keys in first-touch order.
                let access_list: Vec<Value> = list
                    .iter()
                    .map(|(address, slots)| json!({"address": address, "storageKeys": slots}))
                    .collect();
                let gas_used = result.tx_gas_used();
                let error = match &result {
                    ExecutionResult::Success { .. } => None,
                    ExecutionResult::Revert { .. } => Some("execution reverted".to_owned()),
                    ExecutionResult::Halt { reason, .. } => Some(halt_message(reason)),
                };
                // go-ethereum's `accessListResult` field order.
                let mut value = json!({"accessList": access_list});
                if let Some(error) = error {
                    value["error"] = json!(error);
                }
                value["gasUsed"] = json!(format!("{gas_used:#x}"));
                return Ok(value);
            }
            list = traced;
        }
        Err(Error::Unavailable("access list did not converge".into()).into())
    }

    /// Geth `gasestimator.execute`: intrinsic-gas and gas-cap errors count as failures (the
    /// limit moves), other validation errors abort.
    fn trial(&mut self, attempt: &mut Attempt<'_>, gas: u64) -> Result<Trial, Stop> {
        let mut tx = self.tx.clone();
        tx.gas_limit = gas;
        Ok(match self.exec(attempt, &tx, 0, None)? {
            Run::Done(result) if result.is_success() => Trial::Succeeded(result),
            Run::Done(result) => Trial::Failed(Some(result)),
            Run::Invalid(
                InvalidTransaction::CallGasCostMoreThanGasLimit { .. }
                | InvalidTransaction::GasFloorMoreThanGasLimit { .. }
                | InvalidTransaction::TxGasLimitGreaterThanCap { .. }
                | InvalidTransaction::CallerGasLimitMoreThanBlock,
            ) => Trial::Failed(None),
            Run::Invalid(invalid) => return Err(rejected(&invalid, &tx, self.base_fee()).into()),
            Run::Traced(..) => unreachable!("untraced"),
        })
    }

    /// `eth_estimateGas` following go-ethereum's `eth/gasestimator.Estimate`: cap by the
    /// request gas (else the block gas limit), EIP-7825, the sender's balance over the fee
    /// cap and [`MAX_ESTIMATE_GAS`]; short-circuit plain transfers; run once at the cap; try
    /// the optimistic `(peak gas + 2300) * 64 / 63`; then bisect (skewed low) until within
    /// 1.5%, at most [`MAX_ESTIMATE_ITERATIONS`] more runs.
    fn estimate(&mut self, attempt: &mut Attempt<'_>) -> Result<Value, Stop> {
        let tx = self.tx.clone();
        let tx_cap = self.env.cfg_env.tx_gas_limit_cap();
        let mut hi = match self.requested_gas {
            Some(gas) if gas >= TX_GAS => gas,
            _ => self.block_gas_limit,
        };
        hi = hi.min(tx_cap).min(self.block_gas_limit);
        if tx.gas_price != 0 {
            let balance = self
                .account(attempt, tx.caller)?
                .map(|account| account.balance)
                .unwrap_or_default();
            if tx.value >= balance {
                return Err(Error::Rejected("insufficient funds for transfer".into()).into());
            }
            let allowance = (balance - tx.value) / U256::from(tx.gas_price);
            if let Ok(allowance) = u64::try_from(allowance) {
                hi = hi.min(allowance);
            }
        }
        hi = hi.min(MAX_ESTIMATE_GAS);
        if tx.data.is_empty()
            && let TxKind::Call(to) = tx.kind
            && self
                .account(attempt, to)?
                .is_none_or(|account| account.code_hash == KECCAK256_EMPTY)
        {
            // Geth tries 21,000 and ignores a validation error here: the run at the cap
            // below reports it (or runs out of the allowance).
            match self.trial(attempt, TX_GAS) {
                Ok(Trial::Succeeded(result)) => {
                    return Ok(json!(format!("{:#x}", result.gas().tx_gas_used())));
                }
                Err(Stop::Need) => return Err(Stop::Need),
                Err(Stop::Fail(error)) if !matches!(error, Error::Rejected(_)) => {
                    return Err(Stop::Fail(error));
                }
                _ => {}
            }
        }
        let first = match self.trial(attempt, hi)? {
            Trial::Succeeded(result) => result,
            Trial::Failed(Some(ExecutionResult::Revert { output, .. })) => {
                return Err(revert_stop(&output));
            }
            Trial::Failed(Some(ExecutionResult::Halt { reason, .. }))
                if !matches!(reason, HaltReason::OutOfGas(_)) =>
            {
                return Err(Error::Rejected(halt_message(&reason)).into());
            }
            Trial::Failed(_) => {
                return Err(
                    Error::Rejected(format!("gas required exceeds allowance ({hi})")).into(),
                );
            }
        };
        let gas = first.gas();
        let mut lo = gas.tx_gas_used().saturating_sub(1);
        // Geth's `MaxUsedGas`: the peak before refunds (or the calldata floor).
        let peak = gas.total_gas_spent().max(gas.floor_gas());
        let optimistic = peak.saturating_add(CALL_STIPEND).saturating_mul(64) / 63;
        if optimistic < hi {
            match self.trial(attempt, optimistic)? {
                Trial::Failed(_) => lo = optimistic,
                Trial::Succeeded(_) => hi = optimistic,
            }
        }
        let mut iterations = 0;
        while lo + 1 < hi && iterations < MAX_ESTIMATE_ITERATIONS {
            if ((hi - lo) as f64 / hi as f64) < ESTIMATE_ERROR_RATIO {
                break;
            }
            let mut mid = lo + (hi - lo) / 2;
            if mid > lo.saturating_mul(2) {
                mid = lo * 2;
            }
            match self.trial(attempt, mid)? {
                Trial::Failed(_) => lo = mid,
                Trial::Succeeded(_) => hi = mid,
            }
            iterations += 1;
        }
        Ok(json!(format!("{hi:#x}")))
    }
}

enum Trial {
    Failed(Option<ExecutionResult>),
    Succeeded(ExecutionResult),
}

/// A revert, carried to the response as Geth's code-3 error.
fn revert_stop(output: &Bytes) -> Stop {
    Stop::Fail(Error::Rejected(format!(
        "{REVERT_MARKER}{}",
        hex::encode(output)
    )))
}

/// Reverts travel as `Error::Rejected` with this prefix and the revert data in hex.
const REVERT_MARKER: &str = "\u{0}revert:";

/// The JSON-RPC error of a failed call.
pub fn error_json(error: Error) -> RpcError {
    match error {
        Error::InvalidParams(message) => RpcError::new(-32602, message),
        Error::Rejected(message) => match message.strip_prefix(REVERT_MARKER) {
            Some(data) => RpcError::reverted(&hex::decode(data).unwrap_or_default()),
            None => RpcError::new(-32000, message),
        },
        Error::Limit(message) => RpcError::new(-32005, message),
        Error::Unavailable(message) => RpcError::new(-32000, message),
    }
}

/// The call request (go-ethereum `TransactionArgs`) as a transaction (gas limit unset),
/// whether it pays no fees, and its requested gas. Like Geth, unknown fields (including
/// `type`) are ignored; `gasPrice` makes a legacy fee, `maxFeePerGas`/`maxPriorityFeePerGas`
/// an EIP-1559 one (each defaulting to zero); `blobVersionedHashes`/`maxFeePerBlobGas` and
/// `authorizationList` make blob and EIP-7702 calls. A call naming no fee (zero fee cap and
/// tip) skips the base-fee checks.
pub fn parse_tx(value: &Value, chain_id: u64) -> Result<(TxEnv, bool, Option<u64>), Error> {
    let invalid = |message: String| Error::InvalidParams(message);
    let object = value
        .as_object()
        .ok_or_else(|| invalid("call request must be an object".into()))?;
    if let (Some(data), Some(input)) = (object.get("data"), object.get("input"))
        && data != input
    {
        return Err(invalid(
            "both \"data\" and \"input\" are set and not equal. Please use \"input\" to pass transaction call data".into(),
        ));
    }
    let mut fields = object.clone();
    fields.remove("type");
    let request: alloy_rpc_types_eth::TransactionRequest =
        serde_json::from_value(Value::Object(fields))
            .map_err(|error| invalid(format!("invalid call request: {error}")))?;
    if let Some(id) = request.chain_id
        && id != chain_id
    {
        return Err(Error::Rejected(format!(
            "chainId does not match node's (have={id}, want={chain_id})"
        )));
    }
    if request.gas_price.is_some()
        && (request.max_fee_per_gas.is_some() || request.max_priority_fee_per_gas.is_some())
    {
        return Err(Error::Rejected(
            "both gasPrice and (maxFeePerGas or maxPriorityFeePerGas) specified".into(),
        ));
    }
    let dynamic = request.gas_price.is_none()
        && (request.max_fee_per_gas.is_some() || request.max_priority_fee_per_gas.is_some());
    let gas_price = request
        .gas_price
        .or(request.max_fee_per_gas)
        .unwrap_or_default();
    let priority = dynamic.then(|| request.max_priority_fee_per_gas.unwrap_or_default());
    let free_call = gas_price == 0 && priority.unwrap_or_default() == 0;
    let mut tx = TxEnv {
        caller: request.from.unwrap_or_default(),
        kind: request.to.unwrap_or(TxKind::Create),
        gas_price,
        gas_priority_fee: priority,
        value: request.value.unwrap_or(U256::ZERO),
        data: request.input.into_input().unwrap_or_default(),
        nonce: request.nonce.unwrap_or_default(),
        chain_id: Some(chain_id),
        access_list: request.access_list.unwrap_or_default(),
        ..Default::default()
    };
    tx.derive_tx_type()
        .map_err(|error| invalid(format!("{error:?}")))?;
    if dynamic {
        tx.tx_type = 2;
    }
    if let Some(hashes) = request.blob_versioned_hashes {
        tx.blob_hashes = hashes;
        tx.max_fee_per_blob_gas = request.max_fee_per_blob_gas.unwrap_or_default();
        tx.gas_priority_fee = Some(priority.unwrap_or_default());
        tx.tx_type = 3;
    }
    if let Some(authorizations) = request.authorization_list {
        tx.set_signed_authorization(authorizations);
        tx.gas_priority_fee = Some(priority.unwrap_or_default());
        tx.tx_type = 4;
    }
    Ok((tx, free_call, request.gas))
}
