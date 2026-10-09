// A block record (storage.md, "Block records"): the RLP list
// [raw_block, senders, receipts, blob_gas_price, extras], and the JSON-RPC views built from it.
// Everything the archive does not store is derived here: transaction and block hashes, gasUsed
// from consecutive cumulative gas, effectiveGasPrice, contractAddress, logIndex, logsBloom and
// blobGasUsed.

import { decodeBlock, blockJson, keccak, type Block, type RawTx } from "./block";
import { data, quantity, quantityBytes, toBigInt, toNumber } from "./hex";
import { bytes, decode, encodeBytes, encodeList, intBytes, list, type Rlp } from "./rlp";
import { blobCount, effectiveGasPrice, nonce, recipient, txJson } from "./tx";

/** Blob gas per blob (EIP-4844). */
const GAS_PER_BLOB = 131_072n;

export interface ReceiptRecord {
  type: number;
  /** Empty: failed; 0x01: success; 32 bytes: pre-Byzantium post-state root. */
  status: Uint8Array;
  cumulativeGasUsed: bigint;
  /** [address, topics, data] per log. */
  logs: Rlp[][];
}

export interface BlockRecord {
  /** The record's encoding, as stored (passed to the executor). */
  frame: Uint8Array;
  block: Block;
  senders: Uint8Array[];
  receipts: ReceiptRecord[];
  blobGasPrice: bigint;
  /** Per transaction: [[name, value], …] receipt fields the chain adds (empty on Ethereum). */
  extras: [string, bigint][][];
}

export function decodeRecord(frame: Uint8Array): BlockRecord {
  const top = list(decode(frame));
  const block = decodeBlock(bytes(top[0]));
  const sendersRaw = bytes(top[1]);
  if (sendersRaw.length !== block.txs.length * 20) throw new Error("senders do not match the transactions");
  const senders = block.txs.map((_, i) => sendersRaw.subarray(i * 20, i * 20 + 20));
  const receipts = list(top[2]).map((r) => {
    const [type, status, cumulative, logs] = list(r);
    return { type: toNumber(bytes(type)), status: bytes(status), cumulativeGasUsed: toBigInt(bytes(cumulative)), logs: list(logs).map((l) => list(l)) };
  });
  if (receipts.length !== block.txs.length) throw new Error("receipts do not match the transactions");
  const extras = (top[4] ? list(top[4]) : []).map((perTx) =>
    list(perTx).map((kv) => {
      const [name, value] = list(kv);
      return [new TextDecoder().decode(bytes(name)), toBigInt(bytes(value))] as [string, bigint];
    }),
  );
  return { frame, block, senders, receipts, blobGasPrice: toBigInt(bytes(top[3])), extras };
}

export function txContext(rec: BlockRecord, index: number) {
  const h = rec.block.header;
  return { blockHash: h.hash, blockNumber: h.number, blockTimestamp: h.timestamp, index, from: rec.senders[index]!, baseFee: h.baseFee };
}

/** The block's JSON-RPC object; `full` includes transaction objects instead of hashes. */
export function blockResult(rec: BlockRecord, full: boolean): Record<string, unknown> {
  const out = blockJson(rec.block);
  out.transactions = rec.block.txs.map((tx, i) => (full ? txJson(tx, txContext(rec, i)) : data(tx.hash)));
  return out;
}

export function txResult(rec: BlockRecord, index: number): Record<string, unknown> | null {
  const tx = rec.block.txs[index];
  return tx ? txJson(tx, txContext(rec, index)) : null;
}

export function logsBloom(logs: Rlp[][]): Uint8Array {
  const bloom = new Uint8Array(256);
  const add = (v: Uint8Array) => {
    const h = keccak(v);
    for (let i = 0; i < 6; i += 2) {
      const bit = ((h[i]! << 8) | h[i + 1]!) & 2047;
      bloom[255 - (bit >> 3)]! |= 1 << (bit & 7);
    }
  };
  for (const [address, topics] of logs) {
    add(bytes(address));
    for (const t of list(topics)) add(bytes(t));
  }
  return bloom;
}

function contractAddress(tx: RawTx, sender: Uint8Array): string | null {
  if (recipient(tx)) return null;
  return data(keccak(encodeList([encodeBytes(sender), encodeBytes(intBytes(nonce(tx)))])).subarray(12));
}

/** The log objects of transaction `index`, with logIndex counted across the block. */
function logsJson(rec: BlockRecord, index: number, firstLogIndex: number) {
  const h = rec.block.header;
  const tx = rec.block.txs[index]!;
  return rec.receipts[index]!.logs.map(([address, topics, payload], i) => ({
    address: data(bytes(address)),
    topics: list(topics).map((t) => data(bytes(t))),
    data: data(bytes(payload)),
    blockNumber: quantity(h.number),
    blockHash: data(h.hash),
    blockTimestamp: quantity(h.timestamp),
    transactionHash: data(tx.hash),
    transactionIndex: quantity(index),
    logIndex: quantity(firstLogIndex + i),
    removed: false,
  }));
}

/** Every log of the block with its transaction and block positions, for eth_getLogs. */
export function blockLogs(rec: BlockRecord): { address: Uint8Array; topics: Uint8Array[]; json: Record<string, unknown> }[] {
  const out: { address: Uint8Array; topics: Uint8Array[]; json: Record<string, unknown> }[] = [];
  let logIndex = 0;
  rec.receipts.forEach((r, i) => {
    const json = logsJson(rec, i, logIndex);
    r.logs.forEach(([address, topics], j) => out.push({ address: bytes(address), topics: list(topics).map((t) => bytes(t)), json: json[j]! }));
    logIndex += r.logs.length;
  });
  return out;
}

/** Receipt `i`: gasUsed and logIndex need only the earlier receipts' gas and log counts. */
export function receiptResult(rec: BlockRecord, i: number): Record<string, unknown> | null {
  const tx = rec.block.txs[i];
  const r = rec.receipts[i];
  if (!tx || !r) return null;
  let logIndex = 0;
  for (let j = 0; j < i; j++) logIndex += rec.receipts[j]!.logs.length;
  const previous = i > 0 ? rec.receipts[i - 1]!.cumulativeGasUsed : 0n;
  const h = rec.block.header;
  const to = recipient(tx);
  const receipt: Record<string, unknown> = {
    blockHash: data(h.hash),
    blockNumber: quantity(h.number),
    contractAddress: contractAddress(tx, rec.senders[i]!),
    cumulativeGasUsed: quantity(r.cumulativeGasUsed),
    effectiveGasPrice: quantity(effectiveGasPrice(tx, h.baseFee)),
    from: data(rec.senders[i]!),
    gasUsed: quantity(r.cumulativeGasUsed - previous),
    logs: logsJson(rec, i, logIndex),
    logsBloom: data(logsBloom(r.logs)),
    to: to ? data(to) : null,
    transactionHash: data(tx.hash),
    transactionIndex: quantity(i),
    type: quantity(tx.type),
  };
  if (r.status.length === 32) receipt.root = data(r.status);
  else receipt.status = r.status.length ? quantityBytes(r.status) : "0x0";
  if (tx.type === 3) {
    receipt.blobGasUsed = quantity(BigInt(blobCount(tx)) * GAS_PER_BLOB);
    receipt.blobGasPrice = quantity(rec.blobGasPrice);
  }
  for (const [name, value] of rec.extras[i] ?? []) receipt[name] = quantity(value);
  return receipt;
}

/** Every receipt of the block, in order. */
export function receiptsResult(rec: BlockRecord): Record<string, unknown>[] {
  return rec.block.txs.map((_, i) => receiptResult(rec, i)!);
}
