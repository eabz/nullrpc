//! Block records (docs/storage.md, "Block records"):
//! `[raw_block, senders, receipts, blob_gas_price, extras]`, RLP.

use alloy_consensus::{Block as ConsensusBlock, Header, Transaction as _, TxEnvelope};
use alloy_primitives::{Address, B256, Bytes};
use alloy_rlp::{Decodable, Header as RlpHeader};

/// A block transaction with its recorded sender.
#[derive(Clone, Debug)]
pub struct BlockTx {
    pub envelope: TxEnvelope,
    pub sender: Address,
    pub hash: B256,
    /// Accounts the transaction likely touches (address words of its input, its logs'
    /// addresses and address-like topics): read up front to save rounds.
    pub hints: Vec<Address>,
}

/// A decoded block record.
#[derive(Clone, Debug)]
pub struct Block {
    pub header: Header,
    pub hash: B256,
    pub txs: Vec<BlockTx>,
    pub ommers: Vec<Header>,
    /// Cumulative gas used after each transaction (from the receipts).
    pub cumulative_gas: Vec<u64>,
}

impl Block {
    pub fn number(&self) -> u64 {
        self.header.number
    }
}

/// A word that looks like an address (12 zero bytes, then a non-zero prefix): counters and
/// flags are skipped.
pub fn address_word(word: &[u8]) -> Option<Address> {
    (word.len() == 32 && word[..12].iter().all(|b| *b == 0) && word[12..20].iter().any(|b| *b != 0))
        .then(|| Address::from_slice(&word[12..]))
}

pub fn input_addresses(input: &[u8]) -> Vec<Address> {
    let body = input.get(4..).unwrap_or_default();
    body.as_chunks::<32>()
        .0
        .iter()
        .filter_map(|word| address_word(word))
        .take(64)
        .collect()
}

fn list<'a>(buf: &mut &'a [u8]) -> Result<&'a [u8], String> {
    let header = RlpHeader::decode(buf).map_err(|e| e.to_string())?;
    if !header.list {
        return Err("expected an RLP list".into());
    }
    let (body, rest) = buf
        .split_at_checked(header.payload_length)
        .ok_or("truncated RLP list")?;
    *buf = rest;
    Ok(body)
}

fn bytes(buf: &mut &[u8]) -> Result<Bytes, String> {
    Bytes::decode(buf).map_err(|e| e.to_string())
}

struct Receipt {
    cumulative_gas: u64,
    logs: Vec<(Address, Vec<B256>)>,
}

fn receipt(buf: &mut &[u8]) -> Result<Receipt, String> {
    let mut body = list(buf)?;
    let _ty = bytes(&mut body)?;
    let _status = bytes(&mut body)?;
    let cumulative_gas = u64::decode(&mut body).map_err(|e| e.to_string())?;
    let mut logs_body = list(&mut body)?;
    let mut logs = Vec::new();
    while !logs_body.is_empty() {
        let mut log = list(&mut logs_body)?;
        let address = Address::decode(&mut log).map_err(|e| e.to_string())?;
        let topics = Vec::<B256>::decode(&mut log).map_err(|e| e.to_string())?;
        logs.push((address, topics));
    }
    Ok(Receipt {
        cumulative_gas,
        logs,
    })
}

/// Decode a block record (bytes, not hex).
pub fn decode(record: &[u8]) -> Result<Block, String> {
    let mut buf = record;
    let mut body = list(&mut buf)?;
    let raw = bytes(&mut body)?;
    let senders = bytes(&mut body)?;
    let mut receipts_body = list(&mut body)?;
    let mut receipts = Vec::new();
    while !receipts_body.is_empty() {
        receipts.push(receipt(&mut receipts_body)?);
    }
    let block: ConsensusBlock<TxEnvelope> =
        alloy_rlp::decode_exact(&raw).map_err(|e| format!("invalid raw block: {e}"))?;
    if senders.len() != block.body.transactions.len() * 20 {
        return Err("block senders do not match its transactions".into());
    }
    if !receipts.is_empty() && receipts.len() != block.body.transactions.len() {
        return Err("block receipts do not match its transactions".into());
    }
    let hash = block.header.hash_slow();
    let mut txs: Vec<BlockTx> = block
        .body
        .transactions
        .into_iter()
        .zip(senders.as_chunks::<20>().0)
        .map(|(envelope, sender)| BlockTx {
            hash: *envelope.tx_hash(),
            hints: input_addresses(envelope.input()),
            envelope,
            sender: Address::from_slice(sender),
        })
        .collect();
    for (tx, receipt) in txs.iter_mut().zip(&receipts) {
        for (address, topics) in &receipt.logs {
            tx.hints.push(*address);
            tx.hints.extend(
                topics
                    .iter()
                    .skip(1)
                    .filter_map(|topic| address_word(topic.as_slice())),
            );
        }
        tx.hints.sort_unstable();
        tx.hints.dedup();
        tx.hints.truncate(256);
    }
    Ok(Block {
        header: block.header,
        hash,
        txs,
        ommers: block.body.ommers,
        cumulative_gas: receipts.iter().map(|r| r.cumulative_gas).collect(),
    })
}
