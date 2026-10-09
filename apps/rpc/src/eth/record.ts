// A block record (storage.md, "Block records"): the RLP list
// [raw_block, senders, receipts, blob_gas_price, extras], and the JSON-RPC views built from it.
// Everything the archive does not store is derived here: transaction and block hashes, gasUsed
// from consecutive cumulative gas, effectiveGasPrice, contractAddress, logIndex, logsBloom and
// blobGasUsed.

import { FrameError, frameLogs as wasmFrameLogs, receiptsLogs as wasmReceiptsLogs, type LogFilter } from "@nullrpc/frames";
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

/**
 * The record of a layout-2 segment's two frames (storage.md, "Block bundles"): the block frame
 * [raw_block, senders, blob_gas_price] and the receipts frame [number, timestamp, tx_hashes,
 * receipts, extras] become [raw_block, senders, receipts, blob_gas_price, extras], byte for
 * byte what a layout-1 frame holds. The items are spliced as encoded, not re-encoded.
 */
export function joinRecord(block: Uint8Array, receipts: Uint8Array): Uint8Array {
  const b = list(decode(block));
  const r = list(decode(receipts));
  if (b.length !== 3) throw new Error("block frame is not a list of 3 items");
  if (r.length !== 5) throw new Error("receipts frame is not a list of 5 items");
  return encodeList([b[0]!.raw, b[1]!.raw, r[3]!.raw, b[2]!.raw, r[4]!.raw]);
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

export type { LogFilter } from "@nullrpc/frames";

/** Whether a log passes an eth_getLogs filter: any listed address; per position, any listed topic. */
export function logMatches(address: Uint8Array, topics: Uint8Array[], f: LogFilter): boolean {
  if (f.addresses.length && !f.addresses.some((a) => equalBytes(a, address))) return false;
  for (let i = 0; i < f.topics.length; i++) {
    const accepted = f.topics[i];
    if (!accepted) continue;
    const t = topics[i];
    if (!t || !accepted.some((a) => equalBytes(a, t))) return false;
  }
  return true;
}

/**
 * The logs of a stored record that `filter` accepts, as eth_getLogs returns them, decoding only
 * what they need: the header, the receipts, and the hash of a transaction with an accepted log
 * (never the other transactions). `hash` is the block's hash from the offsets record, checked
 * against the header. Equivalent to filtering blockLogs(decodeRecord(frame)). Decoded by the
 * WebAssembly module (packages/frames); when it is unavailable, or refuses the record, by
 * `frameLogsJs`, which reports why.
 */
export function frameLogs(frame: Uint8Array, hash: Uint8Array, filter: LogFilter): Record<string, unknown>[] {
  try {
    const logs = wasmFrameLogs(frame, hash, filter);
    if (logs) return logs;
  } catch (e) {
    if (!(e instanceof FrameError)) throw e;
  }
  return frameLogsJs(frame, hash, (address, topics) => logMatches(address, topics, filter));
}

/**
 * `frameLogs` over a layout-2 receipts frame, which carries the block's number and timestamp,
 * every transaction's hash, the receipts and the extras: nothing of the transactions is read.
 * `hash` and `n` are the block's hash and number from the offsets record; the frame's number
 * must agree. Equivalent to frameLogs over the joined record.
 */
export function receiptsLogs(frame: Uint8Array, hash: Uint8Array, n: number, filter: LogFilter): Record<string, unknown>[] {
  try {
    const logs = wasmReceiptsLogs(frame, hash, n, filter);
    if (logs) return logs;
  } catch (e) {
    if (!(e instanceof FrameError)) throw e;
  }
  return receiptsLogsJs(frame, hash, n, (address, topics) => logMatches(address, topics, filter));
}

/** `receiptsLogs` in JavaScript, for any `want`: the fallback, and the reference the module is tested against. */
export function receiptsLogsJs(frame: Uint8Array, hash: Uint8Array, n: number, want: (address: Uint8Array, topics: Uint8Array[]) => boolean): Record<string, unknown>[] {
  const top = list(decode(frame));
  if (top.length !== 5) throw new Error("receipts frame is not a list of 5 items");
  const number = toNumber(bytes(top[0]));
  if (number !== n) throw new Error(`receipts frame is for block ${number}, not ${n}`);
  const hashes = bytes(top[2]);
  const receipts = list(top[3]);
  if (hashes.length !== receipts.length * 32) throw new Error("transaction hashes do not match the receipts");
  const blockNumber = quantity(number);
  const blockHash = data(hash);
  const blockTimestamp = quantity(toNumber(bytes(top[1])));
  const out: Record<string, unknown>[] = [];
  let logIndex = 0;
  for (let i = 0; i < receipts.length; i++) {
    const logs = list(list(receipts[i])[3]);
    let transactionHash: string | null = null;
    for (let j = 0; j < logs.length; j++) {
      const [address, topics, payload] = list(logs[j]);
      const a = bytes(address);
      const t = list(topics).map((x) => bytes(x));
      if (want(a, t)) {
        transactionHash ??= data(hashes.subarray(i * 32, i * 32 + 32));
        out.push({ address: data(a), topics: t.map((x) => data(x)), data: data(bytes(payload)), blockNumber, blockHash, blockTimestamp, transactionHash, transactionIndex: quantity(i), logIndex: quantity(logIndex + j), removed: false });
      }
    }
    logIndex += logs.length;
  }
  return out;
}

/** `frameLogs` in JavaScript, for any `want`: the fallback, and the reference the module is tested against. */
export function frameLogsJs(frame: Uint8Array, hash: Uint8Array, want: (address: Uint8Array, topics: Uint8Array[]) => boolean): Record<string, unknown>[] {
  const top = list(decode(frame));
  const block = list(decode(bytes(top[0])));
  const header = list(block[0]);
  if (header.length < 15) throw new Error("header has too few fields");
  const number = toNumber(bytes(header[8]));
  if (!equalBytes(keccak(block[0]!.raw), hash)) throw new Error(`block ${number} does not match its offsets record`);
  const txs = list(block[1]);
  const receipts = list(top[2]);
  if (receipts.length !== txs.length) throw new Error("receipts do not match the transactions");
  const blockNumber = quantity(number);
  const blockHash = data(hash);
  const blockTimestamp = quantity(toNumber(bytes(header[11])));
  const out: Record<string, unknown>[] = [];
  let logIndex = 0;
  for (let i = 0; i < receipts.length; i++) {
    const logs = list(list(receipts[i])[3]);
    let transactionHash: string | null = null;
    for (let j = 0; j < logs.length; j++) {
      const [address, topics, payload] = list(logs[j]);
      const a = bytes(address);
      const t = list(topics).map((x) => bytes(x));
      if (want(a, t)) {
        if (transactionHash === null) {
          const tx = txs[i]!;
          transactionHash = data(keccak(tx.list ? tx.raw : tx.value));
        }
        out.push({ address: data(a), topics: t.map((x) => data(x)), data: data(bytes(payload)), blockNumber, blockHash, blockTimestamp, transactionHash, transactionIndex: quantity(i), logIndex: quantity(logIndex + j), removed: false });
      }
    }
    logIndex += logs.length;
  }
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

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
