//! Request parameters: Geth tracer options, Parity trace types, call
//! requests, raw transactions and `trace_filter` filters.

use crate::limits::Error;
use alloy_evm::{EvmEnv, rpc::TryIntoTxEnv};
use alloy_primitives::map::HashSet;
use alloy_rpc_types_eth::TransactionRequest;
use alloy_rpc_types_trace::{
    geth::{GethDebugBuiltInTracerType, GethDebugTracerType, GethDebugTracingOptions},
    parity::TraceType,
};
use revm::context::TxEnv;
use revm_inspectors::tracing::DebugInspector;
use serde_json::Value;

/// Erigon's `rpc.gascap`: the gas of a call that names none, and the most a
/// call may use.
pub const CALL_GAS_CAP: u64 = 50_000_000;
/// The service's upper bound on a trace's wall time (milliseconds), and the
/// default when a request sets no `timeout`.
pub const MAX_TIMEOUT_MS: f64 = 25_000.0;

/// Parsed Geth tracer options.
#[derive(Clone, Debug, Default)]
pub struct GethOptions {
    pub options: GethDebugTracingOptions,
    /// The requested `timeout`, at most [`MAX_TIMEOUT_MS`].
    #[allow(dead_code)]
    pub timeout_ms: f64,
}

fn invalid(message: impl Into<String>) -> Error {
    Error::InvalidParams(message.into())
}

/// Geth's tracer config object (`null` or absent: the struct logger).
/// JavaScript tracers and tracers other than the built-in ones served here
/// are rejected.
pub fn parse_geth_options(value: Option<&Value>) -> Result<GethOptions, Error> {
    let options: GethDebugTracingOptions = match value {
        None | Some(Value::Null) => GethDebugTracingOptions::default(),
        Some(value @ Value::Object(_)) => serde_json::from_value(value.clone())
            .map_err(|e| invalid(format!("invalid tracer options: {e}")))?,
        Some(_) => return Err(invalid("tracer options must be an object")),
    };
    check_options(options)
}

/// `debug_traceCall`'s config: tracer options with state and block overrides.
pub fn parse_call_options(value: Option<&Value>) -> Result<(GethOptions, Overrides), Error> {
    let mut overrides = Overrides::default();
    let mut rest = value.cloned();
    if let Some(object) = rest.as_mut().and_then(Value::as_object_mut) {
        if object.get("txIndex").is_some_and(|v| !v.is_null()) {
            return Err(invalid("txIndex is not supported by this endpoint"));
        }
        overrides = Overrides::parse(
            object.remove("stateOverrides").as_ref(),
            object.remove("blockOverrides").as_ref(),
        )?;
    }
    Ok((parse_geth_options(rest.as_ref())?, overrides))
}

/// State and block overrides of a call (go-ethereum `StateOverride`, `BlockOverrides`).
#[derive(Clone, Debug, Default)]
pub struct Overrides {
    pub state: Option<alloy_rpc_types_eth::state::StateOverride>,
    pub block: Option<alloy_rpc_types_eth::BlockOverrides>,
}

impl Overrides {
    pub fn parse(state: Option<&Value>, block: Option<&Value>) -> Result<Self, Error> {
        let state = match state {
            None | Some(Value::Null) => None,
            Some(value) => Some(
                serde_json::from_value(value.clone())
                    .map_err(|e| invalid(format!("invalid state overrides: {e}")))?,
            ),
        };
        let block = match block {
            None | Some(Value::Null) => None,
            Some(value) => Some(
                serde_json::from_value(value.clone())
                    .map_err(|e| invalid(format!("invalid block overrides: {e}")))?,
            ),
        };
        Ok(Self { state, block })
    }

    /// Apply the block overrides to `env`; overridden block hashes are returned for the
    /// state the call reads.
    pub fn apply_block(&self, env: &mut EvmEnv) -> Vec<(u64, alloy_primitives::B256)> {
        let Some(block) = &self.block else {
            return Vec::new();
        };
        struct Hashes(Vec<(u64, alloy_primitives::B256)>);
        impl alloy_evm::overrides::OverrideBlockHashes for Hashes {
            fn override_block_hashes(
                &mut self,
                block_hashes: std::collections::BTreeMap<u64, alloy_primitives::B256>,
            ) {
                self.0.extend(block_hashes);
            }
        }
        let mut hashes = Hashes(Vec::new());
        alloy_evm::overrides::apply_block_overrides(block.clone(), &mut hashes, &mut env.block_env);
        hashes.0
    }
}

fn check_options(options: GethDebugTracingOptions) -> Result<GethOptions, Error> {
    match &options.tracer {
        None => {}
        Some(GethDebugTracerType::BuiltInTracer(tracer)) => {
            use GethDebugBuiltInTracerType::*;
            if !matches!(
                tracer,
                CallTracer
                    | PreStateTracer
                    | FourByteTracer
                    | NoopTracer
                    | FlatCallTracer
                    | MuxTracer
            ) {
                return Err(invalid(format!(
                    "tracer {} is not supported by this endpoint",
                    GethDebugTracerType::BuiltInTracer(*tracer).as_str()
                )));
            }
        }
        Some(GethDebugTracerType::JsTracer(code)) if code.is_empty() => {}
        Some(GethDebugTracerType::JsTracer(code)) => {
            // A name that is not a built-in tracer is Geth's "tracer not
            // found"; anything else is JavaScript.
            let name = code.trim();
            if name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && name.len() <= 64 {
                return Err(invalid(format!("tracer not found: {name}")));
            }
            return Err(invalid(
                "JavaScript tracers are not supported by this endpoint",
            ));
        }
    }
    let timeout_ms = match &options.timeout {
        None => MAX_TIMEOUT_MS,
        Some(text) => parse_duration(text)
            .ok_or_else(|| invalid(format!("time: invalid duration \"{text}\"")))?
            .min(MAX_TIMEOUT_MS),
    };
    // Reject a config the tracer cannot use before any work is done.
    DebugInspector::new(options.clone()).map_err(|e| invalid(e.to_string()))?;
    Ok(GethOptions {
        options,
        timeout_ms,
    })
}

/// A Go `time.Duration` string (`"5s"`, `"500ms"`, `"1m30s"`) in milliseconds.
fn parse_duration(text: &str) -> Option<f64> {
    let mut rest = text.trim();
    if rest == "0" {
        return Some(0.0);
    }
    if rest.is_empty() {
        return None;
    }
    let mut total = 0.0;
    while !rest.is_empty() {
        let end = rest
            .find(|c: char| !(c.is_ascii_digit() || c == '.'))
            .filter(|&end| end > 0)?;
        let number: f64 = rest[..end].parse().ok()?;
        rest = &rest[end..];
        let unit_end = rest
            .find(|c: char| c.is_ascii_digit() || c == '.')
            .unwrap_or(rest.len());
        let scale = match &rest[..unit_end] {
            "ns" => 1e-6,
            "us" | "µs" => 1e-3,
            "ms" => 1.0,
            "s" => 1e3,
            "m" => 60e3,
            "h" => 3600e3,
            _ => return None,
        };
        total += number * scale;
        rest = &rest[unit_end..];
    }
    Some(total)
}

/// Parity trace types (`["trace","vmTrace","stateDiff"]`).
pub fn parse_trace_types(value: &Value) -> Result<HashSet<TraceType>, Error> {
    let items = value
        .as_array()
        .ok_or_else(|| invalid("trace types must be an array"))?;
    items
        .iter()
        .map(|item| match item.as_str() {
            Some("trace") => Ok(TraceType::Trace),
            Some("vmTrace") => Ok(TraceType::VmTrace),
            Some("stateDiff") => Ok(TraceType::StateDiff),
            _ => Err(invalid(format!("invalid trace type {item}"))),
        })
        .collect()
}

/// A call request, converted against the block environment it runs in.
#[derive(Clone, Debug)]
pub struct CallRequest {
    pub(crate) tx: TxEnv,
    /// No fee fields: executed without base fee (like `eth_call`).
    pub(crate) free: bool,
    /// The request has a nonce: it is checked.
    pub(crate) nonce: bool,
}

/// A call object (`eth_call`'s) for a call at `header`'s block: Erigon's
/// defaults (gas: [`CALL_GAS_CAP`], capped by it; zero sender, value and gas
/// price).
pub fn parse_call(value: &Value, env: &EvmEnv) -> Result<CallRequest, Error> {
    if !value.is_object() {
        return Err(invalid("call request must be an object"));
    }
    let request: TransactionRequest = serde_json::from_value(value.clone())
        .map_err(|e| invalid(format!("invalid call request: {e}")))?;
    if request
        .chain_id
        .is_some_and(|id| id != env.cfg_env.chain_id)
    {
        return Err(invalid("call chain ID mismatch"));
    }
    // Like Geth, zero fees are no fees: no base fee check, BASEFEE reads 0.
    let free = request.gas_price.unwrap_or_default() == 0
        && request.max_fee_per_gas.unwrap_or_default() == 0
        && request.max_priority_fee_per_gas.unwrap_or_default() == 0;
    let nonce = request.nonce.is_some();
    let gas = request.gas.unwrap_or(CALL_GAS_CAP).min(CALL_GAS_CAP);
    let mut tx: TxEnv = request
        .try_into_tx_env(env)
        .map_err(|e| Error::Rejected(e.to_string()))?;
    tx.gas_limit = gas;
    Ok(CallRequest { tx, free, nonce })
}

#[cfg(test)]
pub(crate) mod duration_tests {
    #[test]
    fn go_durations() {
        assert_eq!(super::parse_duration("5s"), Some(5000.0));
        assert_eq!(super::parse_duration("500ms"), Some(500.0));
        assert_eq!(super::parse_duration("1m30s"), Some(90_000.0));
        assert_eq!(super::parse_duration("1.5s"), Some(1500.0));
        assert_eq!(super::parse_duration("0"), Some(0.0));
        assert_eq!(super::parse_duration("5"), None);
        assert_eq!(super::parse_duration("abc"), None);
        assert_eq!(super::parse_duration(""), None);
    }
}
