//! JSON shapes of trace results, as Erigon answers.

use crate::{limits::Error, options::GethOptions, replay::Traced};
use alloy_rpc_types_trace::parity::{LocalizedTransactionTrace, TraceResults};
use serde_json::Value;

fn to_value(value: impl serde::Serialize) -> Result<Value, Error> {
    serde_json::to_value(value).map_err(Error::unavailable)
}

/// A Geth tracer's result. `log_offset` is the number of logs of the
/// block's earlier transactions: Geth and Erigon index call tracer logs
/// within the block.
pub(crate) fn geth(
    traced: &Traced,
    options: &GethOptions,
    log_offset: u64,
) -> Result<Value, Error> {
    let Traced::Geth(trace, hashes) = traced else {
        unreachable!("geth tracer")
    };
    let mut value = to_value(&**trace)?;
    let add_hashes = |accounts: &mut Value, hashes: &std::collections::BTreeMap<_, _>| {
        for (address, hash) in hashes {
            if let Some(account) = accounts.get_mut(format!("{address:#x}")) {
                account["codeHash"] = serde_json::json!(hash);
                if *hash == alloy_primitives::KECCAK256_EMPTY && account.get("code").is_none() {
                    account["code"] = serde_json::json!("0x");
                }
            }
        }
    };
    if value.get("pre").is_some() && value.get("post").is_some() {
        add_hashes(&mut value["pre"], &hashes.pre);
        add_hashes(&mut value["post"], &hashes.post);
        for address in &hashes.absent {
            value["post"][format!("{address:#x}")] =
                serde_json::json!({"codeHash": alloy_primitives::B256::ZERO});
        }
    } else {
        add_hashes(&mut value, &hashes.pre);
    }
    if let Some(logs) = value.get_mut("structLogs").and_then(Value::as_array_mut) {
        // Geth reports the refund counter after an SSTORE's gas (and refund)
        // was computed: the value of the frame's next step.
        for i in 0..logs.len().saturating_sub(1) {
            if logs[i]["op"] == "SSTORE" && logs[i + 1]["depth"] == logs[i]["depth"] {
                let next = logs[i + 1]["refund"].clone();
                logs[i]["refund"] = next;
            }
        }
        // revm counts refunds per call frame; Geth's counter is the
        // transaction's: a frame's base is its caller's counter at the call
        // (the outermost frame's, the EIP-7702 authorization refund).
        let mut bases: Vec<u64> = vec![hashes.refund];
        let mut previous: Option<(usize, u64)> = None;
        for log in logs.iter_mut() {
            let depth = log["depth"].as_u64().unwrap_or(1).max(1) as usize;
            let local = log["refund"].as_u64().unwrap_or_default();
            if let Some((caller_depth, caller_local)) = previous
                && depth > caller_depth
            {
                let base = bases[caller_depth - 1] + caller_local;
                bases.resize(depth, base);
                bases[depth - 1] = base;
            }
            bases.resize(depth.max(bases.len()), 0);
            if log.get("refund").is_some() {
                log["refund"] = serde_json::json!(bases[depth - 1] + local);
            }
            previous = Some((depth, local));
            struct_log(log);
        }
    }
    // go-ethereum indexes call tracer logs within the block (its state counts the logs of the
    // block's earlier transactions).
    let call_tracer = options
        .options
        .tracer
        .as_ref()
        .is_some_and(|t| t.as_str() == "callTracer");
    if call_tracer && log_offset > 0 {
        offset_logs(&mut value, log_offset);
    }
    Ok(value)
}

/// Geth's struct log JSON omits a zero refund counter and empty memory,
/// return data and storage.
fn struct_log(log: &mut Value) {
    let Some(entry) = log.as_object_mut() else {
        return;
    };
    if let Some(error) = entry.get("error").and_then(Value::as_str) {
        let error = geth_error(error);
        entry.insert("error".into(), Value::String(error));
    }
    if entry.get("refund").and_then(Value::as_u64) == Some(0) {
        entry.remove("refund");
    }
    if entry
        .get("memory")
        .and_then(Value::as_array)
        .is_some_and(Vec::is_empty)
    {
        entry.remove("memory");
    }
    if entry
        .get("returnData")
        .and_then(Value::as_str)
        .is_some_and(|data| data.is_empty() || data == "0x")
    {
        entry.remove("returnData");
    }
    if entry
        .get("storage")
        .and_then(Value::as_object)
        .is_some_and(|s| s.is_empty())
    {
        entry.remove("storage");
    }
}

/// Geth's error text for a struct log entry (revm-inspectors writes revm's
/// instruction result, `Some(OutOfGas)`).
fn geth_error(error: &str) -> String {
    let name = error
        .strip_prefix("Some(")
        .and_then(|e| e.strip_suffix(')'))
        .unwrap_or(error);
    match name {
        "OutOfGas" | "MemoryOOG" | "MemoryLimitOOG" | "PrecompileOOG" | "InvalidOperandOOG" => {
            "out of gas"
        }
        "Revert" => "execution reverted",
        "InvalidJump" => "invalid jump destination",
        "InvalidFEOpcode" => "invalid opcode: INVALID",
        "StateChangeDuringStaticCall" | "CallNotAllowedInsideStatic" => "write protection",
        "OutOfOffset" => "return data out of bounds",
        "CallTooDeep" => "max call depth exceeded",
        "OutOfFunds" => "insufficient balance for transfer",
        "StackUnderflow" => "stack underflow",
        "StackOverflow" => "stack limit reached",
        "CreateCollision" => "contract address collision",
        "CreateContractSizeLimit" => "max code size exceeded",
        "CreateContractStartingWithEF" => "invalid code: must not begin with 0xef",
        "NonceOverflow" => "nonce uint64 overflow",
        other => return other.to_string(),
    }
    .into()
}

fn offset_logs(frame: &mut Value, offset: u64) {
    if let Some(logs) = frame.get_mut("logs").and_then(Value::as_array_mut) {
        for log in logs {
            if let Some(index) = log.get("index").and_then(Value::as_str).and_then(quantity) {
                log["index"] = Value::String(format!("{:#x}", index + offset));
            }
        }
    }
    if let Some(calls) = frame.get_mut("calls").and_then(Value::as_array_mut) {
        for call in calls {
            offset_logs(call, offset);
        }
    }
}

/// One `trace_transaction` / `trace_block` / `trace_filter` entry.
pub(crate) fn localized(trace: &LocalizedTransactionTrace) -> Value {
    let mut value = serde_json::to_value(trace).expect("traces serialize");
    parity_error(&mut value);
    value
}

/// Erigon's text for a Parity trace error where it differs from
/// OpenEthereum's (revm-inspectors).
fn parity_error(trace: &mut Value) {
    let Some(error) = trace.get_mut("error") else {
        return;
    };
    let text = match error.as_str() {
        Some("Out of gas") => "out of gas",
        _ => return,
    };
    *error = Value::String(text.into());
}

/// A `trace_call` / `trace_replay*` result.
/// `idx` is Erigon's vmTrace op label prefix: the transaction index for
/// replays, the call's position for `trace_callMany`, none for `trace_call`.
pub(crate) fn trace_results(results: &TraceResults, idx: Option<usize>) -> Result<Value, Error> {
    let mut value = to_value(results)?;
    if let Some(traces) = value.get_mut("trace").and_then(Value::as_array_mut) {
        traces.iter_mut().for_each(parity_error);
    }
    if let Some(vm_trace) = value.get_mut("vmTrace").filter(|v| v.is_object()) {
        label_ops(vm_trace, idx.map(|i| i.to_string()));
    }
    Ok(value)
}

/// Erigon labels each vmTrace op `{prefix}-{position}` (a nested trace's
/// prefix is its call op's label).
fn label_ops(vm_trace: &mut Value, prefix: Option<String>) {
    let Some(ops) = vm_trace.get_mut("ops").and_then(Value::as_array_mut) else {
        return;
    };
    for (position, op) in ops.iter_mut().enumerate() {
        let label = match &prefix {
            Some(prefix) => format!("{prefix}-{position}"),
            None => position.to_string(),
        };
        if let Some(sub) = op.get_mut("sub").filter(|v| v.is_object()) {
            label_ops(sub, Some(label.clone()));
        }
        op["idx"] = Value::String(label);
    }
}

fn quantity(text: &str) -> Option<u64> {
    u64::from_str_radix(text.strip_prefix("0x")?, 16).ok()
}
