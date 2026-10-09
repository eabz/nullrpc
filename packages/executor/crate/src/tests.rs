//! Sessions over in-memory state (ported from exe-trace's and exe-execution's tests).

use crate::{api::run_with, state::Miss};
use alloy_consensus::{BlockBody, EMPTY_OMMER_ROOT_HASH, Header, Signed, TxEip1559, TxEnvelope};
use alloy_eips::eip7685::EMPTY_REQUESTS_HASH;
use alloy_primitives::{
    Address, B256, Bytes, KECCAK256_EMPTY, Signature, TxKind, U256, address, bytes, keccak256,
};

use serde_json::{Value, json};
use std::{cell::Cell, collections::HashMap};

const SENDER: Address = address!("0x00000000000000000000000000000000000000aa");
const CONTRACT: Address = address!("0x00000000000000000000000000000000000000cc");
const COINBASE: Address = address!("0x00000000000000000000000000000000000000fe");

fn config() -> Value {
    serde_json::from_str(include_str!("../../test/fixtures/hoodi-config.json")).unwrap()
}

/// `s[1] = s[s[0]] + 1`: a dependent read chain (two rounds of reads).
fn code() -> Bytes {
    bytes!("600054546001016001550000")
}

#[derive(Default)]
struct Memory {
    accounts: HashMap<Address, (u64, U256, B256)>,
    storage: HashMap<(Address, U256), U256>,
    code: HashMap<B256, Bytes>,
}

impl Memory {
    fn insert(
        &mut self,
        address: Address,
        nonce: u64,
        balance: U256,
        code: Bytes,
        slots: &[(u64, u64)],
    ) {
        let hash = if code.is_empty() {
            KECCAK256_EMPTY
        } else {
            keccak256(&code)
        };
        self.code.insert(hash, code);
        self.accounts.insert(address, (nonce, balance, hash));
        for (slot, value) in slots {
            self.storage
                .insert((address, U256::from(*slot)), U256::from(*value));
        }
    }

    fn answer(&self, keys: &[Miss]) -> Vec<Value> {
        keys.iter()
            .map(|key| match key {
                Miss::Account(a) => match self.accounts.get(a) {
                    Some((nonce, balance, hash)) => json!({
                        "kind": "account", "nonce": nonce, "balance": format!("{balance:#x}"),
                        "codeHash": (*hash != KECCAK256_EMPTY).then(|| format!("{hash:#x}")),
                    }),
                    None => Value::Null,
                },
                Miss::Storage(a, s) => json!({"kind": "storage",
                    "value": format!("{:#x}", self.storage.get(&(*a, *s)).copied().unwrap_or_default())}),
                Miss::Code(h) => json!({"kind": "code", "code": self.code[h]}),
                Miss::BlockHash(n) => json!({"kind": "blockHash", "hash": B256::with_last_byte(*n as u8)}),
            })
            .collect()
    }
}

fn state() -> Memory {
    let mut state = Memory::default();
    state.insert(SENDER, 0, U256::from(10u128.pow(18)), Bytes::new(), &[]);
    state.insert(CONTRACT, 1, U256::ZERO, code(), &[(0, 5), (5, 41)]);
    state
}

fn tx(nonce: u64) -> TxEnvelope {
    let tx = TxEip1559 {
        chain_id: 560048,
        nonce,
        gas_limit: 100_000,
        max_fee_per_gas: 100,
        max_priority_fee_per_gas: 1,
        to: TxKind::Call(CONTRACT),
        value: U256::from(nonce),
        access_list: Default::default(),
        input: Bytes::new(),
    };
    TxEnvelope::Eip1559(Signed::new_unhashed(tx, Signature::test_signature()))
}

/// A block record with two transactions of `SENDER`.
fn record() -> String {
    let header = Header {
        parent_hash: B256::with_last_byte(0x99),
        ommers_hash: EMPTY_OMMER_ROOT_HASH,
        beneficiary: COINBASE,
        number: 1000,
        gas_limit: 60_000_000,
        gas_used: 100_000,
        timestamp: 1_800_000_000,
        base_fee_per_gas: Some(7),
        withdrawals_root: Some(B256::ZERO),
        blob_gas_used: Some(0),
        excess_blob_gas: Some(0),
        parent_beacon_block_root: Some(B256::with_last_byte(0x42)),
        requests_hash: Some(EMPTY_REQUESTS_HASH),
        ..Default::default()
    };
    let block = BlockBody {
        transactions: vec![tx(0), tx(1)],
        ommers: vec![],
        withdrawals: Some(Default::default()),
    }
    .into_block(header);
    let raw = alloy_rlp::encode(&block);
    let senders: Vec<u8> = [SENDER, SENDER].iter().flat_map(|a| a.to_vec()).collect();
    let mut out = Vec::new();
    let items: Vec<Vec<u8>> = vec![
        alloy_rlp::encode(Bytes::from(raw)),
        alloy_rlp::encode(Bytes::from(senders)),
        vec![0xc0],
        alloy_rlp::encode(0u64),
        vec![0xc0],
    ];
    let len: usize = items.iter().map(Vec::len).sum();
    alloy_rlp::Header {
        list: true,
        payload_length: len,
    }
    .encode(&mut out);
    for item in items {
        out.extend(item);
    }
    format!("0x{}", hex::encode(out))
}

fn request(method: &str, params: Value, tx_index: Option<u64>) -> String {
    let mut request =
        json!({"method": method, "params": params, "chain": config(), "block": record()});
    if let Some(index) = tx_index {
        request["txIndex"] = json!(index);
    }
    request.to_string()
}

/// Run with no witness, answering reads from `state`; returns the response and rounds.
fn run(state: &Memory, request: &str) -> (Value, usize) {
    let rounds = Cell::new(0);
    let (response, _) = run_with(
        request,
        |_| None,
        |keys, _| {
            rounds.set(rounds.get() + 1);
            state.answer(keys)
        },
    );
    (response, rounds.get())
}

#[test]
fn call_tracer_replays_the_block_prefix() {
    let state = state();
    let (response, rounds) = run(
        &state,
        &request(
            "debug_traceTransaction",
            json!(["0x00", {"tracer": "callTracer"}]),
            Some(1),
        ),
    );
    let trace = &response["result"];
    assert_eq!(trace["from"], json!(format!("{SENDER:#x}")), "{response}");
    assert_eq!(trace["to"], json!(format!("{CONTRACT:#x}")));
    assert_eq!(trace["value"], json!("0x1"));
    assert_eq!(trace["type"], json!("CALL"));
    assert!(rounds >= 2, "rounds {rounds}");

    // The pre-state of tx 1 already has s[1] = 42 (written by tx 0).
    let (pre, _) = run(
        &state,
        &request(
            "debug_traceTransaction",
            json!(["0x00", {"tracer": "prestateTracer"}]),
            Some(1),
        ),
    );
    let pre = &pre["result"];
    let slot1 = format!("{:#066x}", 1);
    assert_eq!(
        pre[format!("{CONTRACT:#x}")]["storage"][&slot1],
        json!(format!("{:#066x}", 42))
    );
    assert_eq!(pre[format!("{SENDER:#x}")]["nonce"], json!(1));
}

#[test]
fn witness_answers_the_pre_state() {
    let state = state();
    let witness = json!({
        "accounts": [
            {"address": format!("{SENDER:#x}"), "exists": true, "nonce": 0, "balance": "0xde0b6b3a7640000", "codeHash": null},
            {"address": format!("{CONTRACT:#x}"), "exists": true, "nonce": 1, "balance": "0x0", "codeHash": format!("{:#x}", keccak256(code()))},
            {"address": format!("{COINBASE:#x}"), "exists": false, "nonce": 0, "balance": "0x0", "codeHash": null},
        ],
        "storage": [{"address": format!("{CONTRACT:#x}"), "slots": [
            {"slot": "0x0", "value": "0x5"}, {"slot": "0x5", "value": "0x29"}, {"slot": "0x1", "value": "0x0"}]}],
    });
    let mut asked = Vec::new();
    let (response, _) = run_with(
        &request("trace_transaction", json!(["0x00"]), Some(0)),
        |n| {
            assert_eq!(n, 1000);
            Some(witness.clone())
        },
        |keys, at| {
            assert_eq!(at, 999);
            asked.extend_from_slice(keys);
            state.answer(keys)
        },
    );
    assert_eq!(response["result"][0]["type"], json!("call"), "{response}");
    // Only the code and the system contracts were read.
    assert!(
        asked
            .iter()
            .all(|k| !matches!(k, Miss::Account(a) if *a == SENDER)),
        "{asked:?}"
    );
}

#[test]
fn struct_logs_and_parity_traces() {
    let state = state();
    let (response, _) = run(
        &state,
        &request("debug_traceTransaction", json!(["0x00"]), Some(0)),
    );
    let logs = response["result"]["structLogs"].as_array().unwrap();
    let ops: Vec<&str> = logs.iter().map(|l| l["op"].as_str().unwrap()).collect();
    assert_eq!(
        ops,
        [
            "PUSH1", "SLOAD", "SLOAD", "PUSH1", "ADD", "PUSH1", "SSTORE", "STOP"
        ]
    );
    assert_eq!(response["result"]["failed"], json!(false));

    let (traces, _) = run(&state, &request("trace_block", json!(["0x3e8"]), None));
    let traces = traces["result"].as_array().unwrap();
    assert_eq!(traces.len(), 2);
    assert_eq!(traces[1]["transactionPosition"], json!(1));
    assert_eq!(traces[1]["blockNumber"], json!(1000));

    let (replayed, _) = run(
        &state,
        &request(
            "trace_replayBlockTransactions",
            json!(["0x3e8", ["trace", "stateDiff"]]),
            None,
        ),
    );
    let diff = &replayed["result"][0]["stateDiff"][format!("{CONTRACT:#x}")]["storage"];
    assert_eq!(
        diff[format!("{:#066x}", 1)],
        json!({"*": {"from": format!("{:#066x}", 0), "to": format!("{:#066x}", 42)}})
    );
}

#[test]
fn calls_run_on_the_post_state() {
    let state = state();
    let call = json!({"to": format!("{CONTRACT:#x}")});
    let (trace, _) = run(
        &state,
        &request(
            "debug_traceCall",
            json!([call, "latest", {"tracer": "callTracer"}]),
            None,
        ),
    );
    assert_eq!(trace["result"]["gas"], json!("0x2faf080"), "{trace}");
    let (result, _) = run(
        &state,
        &request("trace_call", json!([call, ["trace"], "latest"]), None),
    );
    assert_eq!(
        result["result"]["trace"][0]["type"],
        json!("call"),
        "{result}"
    );
    assert_eq!(result["result"]["stateDiff"], Value::Null);

    let (called, _) = run(&state, &request("eth_call", json!([call, "latest"]), None));
    assert_eq!(called, json!({"result": "0x"}));
    let (estimate, _) = run(&state, &request("eth_estimateGas", json!([call]), None));
    let gas = u64::from_str_radix(
        estimate["result"]
            .as_str()
            .unwrap()
            .trim_start_matches("0x"),
        16,
    )
    .unwrap();
    assert!((40_000..50_000).contains(&gas), "{estimate}");
    let (list, _) = run(
        &state,
        &request(
            "eth_createAccessList",
            json!([{"from": format!("{SENDER:#x}"), "to": format!("{CONTRACT:#x}")}]),
            None,
        ),
    );
    // Like Geth, the recipient's storage keys are listed.
    assert_eq!(
        list["result"]["accessList"][0]["storageKeys"]
            .as_array()
            .unwrap()
            .len(),
        3,
        "{list}"
    );
}

#[test]
fn overrides_and_reverts() {
    let state = state();
    // Code `PUSH1 0 PUSH1 0 REVERT` overridden onto the contract.
    let call = json!({"to": format!("{CONTRACT:#x}")});
    let overrides = json!({format!("{CONTRACT:#x}"): {"code": "0x60006000fd"}});
    let (reverted, _) = run(
        &state,
        &request("eth_call", json!([call, "latest", overrides]), None),
    );
    assert_eq!(
        reverted,
        json!({"error": {"code": 3, "message": "execution reverted", "data": "0x"}})
    );
    // Error(string) "nope".
    let code = "0x7f08c379a0000000000000000000000000000000000000000000000000000000006000527f00000000000000000000000000000000000000000000000000000000000000206004527f00000000000000000000000000000000000000000000000000000000000000046024527f6e6f70650000000000000000000000000000000000000000000000000000000060445260646000fd";
    let overrides = json!({format!("{CONTRACT:#x}"): {"code": code}});
    let (reverted, _) = run(
        &state,
        &request("eth_estimateGas", json!([call, "latest", overrides]), None),
    );
    assert_eq!(reverted["error"]["code"], json!(3), "{reverted}");
    assert_eq!(
        reverted["error"]["message"],
        json!("execution reverted: nope")
    );
    // Insufficient funds with a gas price.
    let call = json!({"to": format!("{CONTRACT:#x}"), "from": format!("{COINBASE:#x}"), "gasPrice": "0x10", "value": "0x1"});
    let (rejected, _) = run(&state, &request("eth_call", json!([call]), None));
    assert_eq!(rejected["error"]["code"], json!(-32000), "{rejected}");
    assert!(
        rejected["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("insufficient funds")
    );
}

#[test]
fn limits_and_params_are_explicit() {
    let state = state();
    let (response, _) = run(
        &state,
        &request("debug_traceTransaction", json!(["0x00"]), None),
    );
    assert_eq!(response["error"]["code"], json!(-32602));
    let (response, _) = run(
        &state,
        &request(
            "debug_traceTransaction",
            json!(["0x00", {"tracer": "function() {}"}]),
            Some(0),
        ),
    );
    assert_eq!(response["error"]["code"], json!(-32602));
    assert!(
        response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("JavaScript")
    );
    let (response, _) = run(&state, &request("eth_sign", json!([]), None));
    assert_eq!(response["error"]["code"], json!(-32602));
}

#[test]
fn the_module_keeps_blocks_and_snapshots_by_hash() {
    use crate::{api::Session, cache, protocol};
    cache::reset();
    let state = state();
    let call = json!([{"from": SENDER, "to": CONTRACT, "data": "0x"}, "latest"]);
    let first = request("eth_call", call.clone(), None);
    let (expected, _) = run(&state, &first);
    // Decoding the record kept the block; a request may now name its hash only.
    let block_hash = {
        let record = hex::decode(&record()[2..]).unwrap();
        crate::record::decode(&record).unwrap().hash
    };
    assert!(cache::has_block(&block_hash));
    assert!(!cache::has_known(&block_hash));
    let mut without_record: Value = serde_json::from_str(&first).unwrap();
    without_record.as_object_mut().unwrap().remove("block");
    without_record["blockHash"] = json!(format!("{block_hash:#x}"));
    let (same, rounds) = run(&state, &without_record.to_string());
    assert_eq!(same, expected);
    assert!(rounds >= 1);

    // A session whose first round is marked `snapshot` leaves the state it knew behind; the
    // next request starting from it (`seed`) reads only what the first wave did not cover.
    let mut session = Session::new(&first);
    let keys = match session.run("") {
        crate::api::Progress::Need(keys, _) => keys,
        _ => panic!("the first round asks for the call's keys"),
    };
    let values = state.answer(&keys);
    let keys: Vec<Value> = keys.iter().map(protocol::key_json).collect();
    let mut answered = json!({ "keys": keys, "values": values });
    // The code of the callee comes with its account, as the shell sends it.
    let code_hash = keccak256(code());
    answered["keys"]
        .as_array_mut()
        .unwrap()
        .push(json!({"kind": "code", "hash": code_hash}));
    answered["values"]
        .as_array_mut()
        .unwrap()
        .push(json!({"kind": "code", "code": code()}));
    answered["snapshot"] = json!(format!("{block_hash:#x}"));
    let _ = session.run(&answered.to_string());
    assert!(cache::has_known(&block_hash));

    let mut seeded: Value = serde_json::from_str(&first).unwrap();
    seeded["seed"] = json!(format!("{block_hash:#x}"));
    let (again, rounds_seeded) = run(&state, &seeded.to_string());
    assert_eq!(again, expected);
    assert!(rounds_seeded < rounds, "the accounts and code come from the snapshot");
    cache::reset();
    assert!(!cache::has_block(&block_hash));
}
