//! eth_getLogs over a block record (docs/storage.md, "Block records": the RLP list
//! [raw_block, senders, receipts, blob_gas_price, extras]): the logs the filter accepts, written
//! as the JSON array eth_getLogs returns, with the same fields in the same order as
//! apps/rpc/src/eth/record.ts frameLogs. Only the header, the receipts and the hash of a
//! transaction with an accepted log are decoded.

use crate::rlp::{Item, Items, Malformed, bytes, item};
use sha3::{Digest, Keccak256};

pub enum Error {
    Malformed,
    HeaderFields,
    HashMismatch,
    ReceiptsMismatch,
    Integer,
    Filter,
}

impl From<Malformed> for Error {
    fn from(_: Malformed) -> Self {
        Error::Malformed
    }
}

impl Error {
    /// The negative code the module returns; src/index.ts falls back to JavaScript on any of them.
    pub fn code(&self) -> i32 {
        match self {
            Error::Malformed => -1,
            Error::HeaderFields => -2,
            Error::HashMismatch => -3,
            Error::ReceiptsMismatch => -4,
            Error::Integer => -5,
            Error::Filter => -6,
        }
    }
}

/// The filter as src/index.ts encodes it: u32 LE address count, the 20-byte addresses, u32 LE
/// topic position count, then per position a u32 LE value count (0xFFFFFFFF: any) and the
/// 32-byte values. An empty address list accepts every address.
pub struct Filter<'a> {
    addresses: Vec<&'a [u8]>,
    topics: Vec<Option<Vec<&'a [u8]>>>,
}

fn u32_at(b: &[u8], at: usize) -> Result<usize, Error> {
    let w = b.get(at..at + 4).ok_or(Error::Filter)?;
    Ok(u32::from_le_bytes([w[0], w[1], w[2], w[3]]) as usize)
}

fn values<'a>(b: &'a [u8], at: &mut usize, count: usize, width: usize) -> Result<Vec<&'a [u8]>, Error> {
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        out.push(b.get(*at..*at + width).ok_or(Error::Filter)?);
        *at += width;
    }
    Ok(out)
}

pub fn parse_filter(b: &[u8]) -> Result<Filter<'_>, Error> {
    let mut at = 0;
    let n = u32_at(b, at)?;
    at += 4;
    let addresses = values(b, &mut at, n, 20)?;
    let positions = u32_at(b, at)?;
    at += 4;
    if positions > 4 {
        return Err(Error::Filter);
    }
    let mut topics = Vec::with_capacity(positions);
    for _ in 0..positions {
        let count = u32_at(b, at)?;
        at += 4;
        topics.push(if count == 0xffff_ffff { None } else { Some(values(b, &mut at, count, 32)?) });
    }
    if at != b.len() {
        return Err(Error::Filter);
    }
    Ok(Filter { addresses, topics })
}

/// apps/rpc/src/methods/logs.ts `matches`: any listed address; per position, any listed value,
/// and a log with no topic at a constrained position is refused.
fn accepts(f: &Filter, address: &[u8], topics: Item<'_>) -> Result<bool, Malformed> {
    if !f.addresses.is_empty() && !f.addresses.iter().any(|a| *a == address) {
        return Ok(false);
    }
    if f.topics.is_empty() {
        return Ok(true);
    }
    let mut it = Items::of(&topics)?;
    for accepted in &f.topics {
        let topic = it.next().transpose()?;
        if let Some(accepted) = accepted {
            match topic {
                Some(t) if accepted.iter().any(|a| *a == bytes(t).unwrap_or(&[])) => {}
                _ => return Ok(false),
            }
        }
    }
    Ok(true)
}

const HEX: &[u8; 16] = b"0123456789abcdef";

fn hex_into(out: &mut Vec<u8>, b: &[u8]) {
    out.extend_from_slice(b"\"0x");
    out.reserve(b.len() * 2 + 1);
    for &x in b {
        out.push(HEX[(x >> 4) as usize]);
        out.push(HEX[(x & 15) as usize]);
    }
    out.push(b'"');
}

fn quantity_into(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(b"\"0x");
    if v == 0 {
        out.push(b'0');
    } else {
        let mut digits = [0u8; 16];
        let mut n = 0;
        let mut x = v;
        while x > 0 {
            digits[n] = HEX[(x & 15) as usize];
            x >>= 4;
            n += 1;
        }
        for i in (0..n).rev() {
            out.push(digits[i]);
        }
    }
    out.push(b'"');
}

/// A canonical RLP integer within JavaScript's safe range (apps/rpc/src/eth/hex.ts toNumber).
fn integer(b: &[u8]) -> Result<u64, Error> {
    if b.len() > 8 {
        return Err(Error::Integer);
    }
    let mut v = 0u64;
    for &x in b {
        v = (v << 8) | x as u64;
    }
    if v > (1u64 << 53) - 1 { Err(Error::Integer) } else { Ok(v) }
}

/// Appends the accepted logs of `frame` to `out` as a JSON array (nothing when there are none)
/// and returns how many there are. `hash` is the block's hash from the offsets record.
pub fn frame_logs(frame: &[u8], hash: &[u8], filter: &Filter, out: &mut Vec<u8>) -> Result<u32, Error> {
    let top = item(frame)?;
    let mut top = Items::of(&top)?;
    let raw_block = bytes(top.expect()?)?;
    let _senders = top.expect()?;
    let receipts = top.expect()?;
    let block = item(raw_block)?;
    let mut block = Items::of(&block)?;
    let header = block.expect()?;
    let txs = block.expect()?;

    let mut fields = Items::of(&header)?;
    if fields.remaining()? < 15 {
        return Err(Error::HeaderFields);
    }
    let mut number = 0;
    let mut timestamp = 0;
    for (i, field) in (&mut fields).enumerate() {
        match i {
            8 => number = integer(bytes(field?)?)?,
            11 => timestamp = integer(bytes(field?)?)?,
            _ => {
                field?;
            }
        }
    }
    if Keccak256::digest(header.raw).as_slice() != hash {
        return Err(Error::HashMismatch);
    }
    let mut txs = Items::of(&txs)?;
    let mut receipts = Items::of(&receipts)?;
    if txs.remaining()? != receipts.remaining()? {
        return Err(Error::ReceiptsMismatch);
    }

    // The fields every log of the block shares, formatted once.
    let mut shared = Vec::with_capacity(160);
    shared.extend_from_slice(b",\"blockNumber\":");
    quantity_into(&mut shared, number);
    shared.extend_from_slice(b",\"blockHash\":");
    hex_into(&mut shared, hash);
    shared.extend_from_slice(b",\"blockTimestamp\":");
    quantity_into(&mut shared, timestamp);
    shared.extend_from_slice(b",\"transactionHash\":");

    let mut count = 0u32;
    let mut log_index = 0u64;
    for (index, receipt) in (&mut receipts).enumerate() {
        let tx = txs.expect()?;
        let mut receipt = Items::of(&receipt?)?;
        let _type = receipt.expect()?;
        let _status = receipt.expect()?;
        let _cumulative = receipt.expect()?;
        let logs = receipt.expect()?;
        let mut tx_hash: Option<[u8; 32]> = None;
        let mut in_tx = 0u64;
        for log in Items::of(&logs)? {
            let mut parts = Items::of(&log?)?;
            let address = bytes(parts.expect()?)?;
            let topics = parts.expect()?;
            let data = bytes(parts.expect()?)?;
            if accepts(filter, address, topics)? {
                let h = *tx_hash.get_or_insert_with(|| Keccak256::digest(if tx.list { tx.raw } else { tx.payload }).into());
                out.push(if count == 0 { b'[' } else { b',' });
                out.extend_from_slice(b"{\"address\":");
                hex_into(out, address);
                out.extend_from_slice(b",\"topics\":[");
                for (i, t) in Items::of(&topics)?.enumerate() {
                    if i > 0 {
                        out.push(b',');
                    }
                    hex_into(out, bytes(t?)?);
                }
                out.extend_from_slice(b"],\"data\":");
                hex_into(out, data);
                out.extend_from_slice(&shared);
                hex_into(out, &h);
                out.extend_from_slice(b",\"transactionIndex\":");
                quantity_into(out, index as u64);
                out.extend_from_slice(b",\"logIndex\":");
                quantity_into(out, log_index + in_tx);
                out.extend_from_slice(b",\"removed\":false}");
                count += 1;
            }
            in_tx += 1;
        }
        log_index += in_tx;
    }
    if count > 0 {
        out.push(b']');
    }
    Ok(count)
}
