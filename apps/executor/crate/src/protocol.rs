//! The JSON the TypeScript shell and the executor exchange (apps/rpc/src/executor.ts types):
//! state keys out, state values and witnesses in.

use crate::state::{Known, Miss};
use alloy_primitives::{Address, B256, Bytes, KECCAK256_EMPTY, U256, keccak256};
use revm::state::{AccountInfo, Bytecode};
use serde_json::{Value, json};

/// A `StateKey`.
pub fn key_json(miss: &Miss) -> Value {
    match miss {
        Miss::Account(address) => json!({"kind": "account", "address": format!("{address:#x}")}),
        Miss::Storage(address, slot) => json!({
            "kind": "storage",
            "address": format!("{address:#x}"),
            "slot": format!("{slot:#066x}"),
        }),
        Miss::Code(hash) => json!({"kind": "code", "hash": format!("{hash:#x}")}),
        Miss::BlockHash(number) => json!({"kind": "blockHash", "number": number}),
    }
}

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a Value, String> {
    value
        .get(name)
        .ok_or_else(|| format!("state value missing {name}"))
}

fn quantity_u256(value: &Value) -> Result<U256, String> {
    match value {
        Value::String(text) => text
            .parse::<U256>()
            .map_err(|e| format!("invalid quantity {text}: {e}")),
        Value::Number(n) => n
            .as_u64()
            .map(U256::from)
            .ok_or_else(|| format!("invalid quantity {n}")),
        _ => Err("invalid quantity".into()),
    }
}

fn quantity_u64(value: &Value) -> Result<u64, String> {
    u64::try_from(quantity_u256(value)?).map_err(|_| "quantity exceeds u64".into())
}

fn address(value: &Value) -> Result<Address, String> {
    value
        .as_str()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "invalid address".into())
}

fn hash(value: &Value) -> Result<B256, String> {
    value
        .as_str()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "invalid hash".into())
}

fn code_hash(value: Option<&Value>) -> Result<B256, String> {
    match value {
        None | Some(Value::Null) => Ok(KECCAK256_EMPTY),
        Some(value) => hash(value),
    }
}

/// Parse a `StateKey`.
pub fn parse_key(value: &Value) -> Result<Miss, String> {
    Ok(match value.get("kind").and_then(Value::as_str) {
        Some("account") => Miss::Account(address(field(value, "address")?)?),
        Some("storage") => Miss::Storage(
            address(field(value, "address")?)?,
            quantity_u256(field(value, "slot")?)?,
        ),
        Some("code") => Miss::Code(hash(field(value, "hash")?)?),
        Some("blockHash") => Miss::BlockHash(quantity_u64(field(value, "number")?)?),
        _ => return Err("invalid state key".into()),
    })
}

/// Insert the answer `value` to `key` into `known`.
pub fn insert(known: &mut Known, key: &Miss, value: &Value) -> Result<(), String> {
    match key {
        Miss::Account(address) => {
            let info = if value.is_null() {
                None
            } else {
                Some(AccountInfo {
                    nonce: quantity_u64(field(value, "nonce")?)?,
                    balance: quantity_u256(field(value, "balance")?)?,
                    code_hash: code_hash(value.get("codeHash"))?,
                    code: None,
                    ..Default::default()
                })
            };
            known.insert_account(*address, info);
        }
        Miss::Storage(address, slot) => {
            let stored = if value.is_null() {
                U256::ZERO
            } else {
                quantity_u256(field(value, "value")?)?
            };
            known.insert_storage(*address, *slot, stored);
        }
        Miss::Code(expected) => {
            if value.is_null() {
                return Err(format!("code {expected} is unavailable"));
            }
            let code: Bytes = field(value, "code")?
                .as_str()
                .and_then(|s| s.parse().ok())
                .ok_or("invalid code")?;
            if keccak256(&code) != *expected {
                return Err(format!("code hash mismatch for {expected}"));
            }
            let code = Bytecode::new_raw_checked(code).map_err(|e| format!("invalid code: {e}"))?;
            known.insert_code(*expected, code);
        }
        Miss::BlockHash(number) => {
            // An unknown block hash reads as zero (BLOCKHASH outside the chain).
            let block_hash = if value.is_null() {
                B256::ZERO
            } else {
                hash(field(value, "hash")?)?
            };
            known.insert_hash(*number, block_hash);
        }
    }
    Ok(())
}

/// Seed `known` with a block's pre-state (`Witness`).
pub fn insert_witness(known: &mut Known, witness: &Value) -> Result<(), String> {
    for account in witness
        .get("accounts")
        .and_then(Value::as_array)
        .ok_or("invalid witness")?
    {
        let address = address(field(account, "address")?)?;
        let exists = account
            .get("exists")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let info = exists
            .then(|| -> Result<AccountInfo, String> {
                Ok(AccountInfo {
                    nonce: quantity_u64(field(account, "nonce")?)?,
                    balance: quantity_u256(field(account, "balance")?)?,
                    code_hash: code_hash(account.get("codeHash"))?,
                    code: None,
                    ..Default::default()
                })
            })
            .transpose()?;
        known.insert_account(address, info);
    }
    for entry in witness
        .get("storage")
        .and_then(Value::as_array)
        .ok_or("invalid witness")?
    {
        let address = address(field(entry, "address")?)?;
        for slot in field(entry, "slots")?.as_array().ok_or("invalid witness")? {
            known.insert_storage(
                address,
                quantity_u256(field(slot, "slot")?)?,
                quantity_u256(field(slot, "value")?)?,
            );
        }
    }
    Ok(())
}
