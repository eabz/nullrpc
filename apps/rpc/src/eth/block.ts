// Decoding of a block exactly as debug_getRawBlock returns it, and its JSON-RPC form.
// Hashes are keccak256 of the stored encodings (header, legacy transaction list, typed
// transaction envelope), so they match the chain byte for byte.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { data, quantity, quantityBytes, toBigInt, toNumber } from "./hex";
import { bytes, decode, list, type Rlp } from "./rlp";

export interface Header {
  raw: Uint8Array;
  hash: Uint8Array;
  fields: Rlp[];
  number: number;
  timestamp: number;
  baseFee: bigint | null;
}

export interface RawTx {
  /** The transaction as it appears in eth_getRawTransaction*: typed envelope or legacy RLP. */
  raw: Uint8Array;
  hash: Uint8Array;
  /** 0 for legacy, else the envelope's type byte. */
  type: number;
  /** The transaction's RLP list (the payload after the type byte for typed transactions). */
  fields: Rlp[];
}

export interface Block {
  raw: Uint8Array;
  header: Header;
  txs: RawTx[];
  uncles: Header[];
  /** [index, validatorIndex, address, amount] per withdrawal; null before Shanghai. */
  withdrawals: Rlp[][] | null;
}

export function keccak(input: Uint8Array): Uint8Array {
  return keccak_256(input);
}

export function decodeHeader(item: Rlp): Header {
  const fields = list(item);
  if (fields.length < 15) throw new Error("header has too few fields");
  return {
    raw: item.raw,
    hash: keccak(item.raw),
    fields,
    number: toNumber(bytes(fields[8])),
    timestamp: toNumber(bytes(fields[11])),
    baseFee: fields.length > 15 ? toBigInt(bytes(fields[15])) : null,
  };
}

export function decodeTx(item: Rlp): RawTx {
  if (item.list) return { raw: item.raw, hash: keccak(item.raw), type: 0, fields: item.items };
  const envelope = item.value;
  const type = envelope[0];
  if (type === undefined || type > 0x7f) throw new Error("invalid transaction envelope");
  return { raw: envelope, hash: keccak(envelope), type, fields: list(decode(envelope.subarray(1))) };
}

export function decodeBlock(raw: Uint8Array): Block {
  const top = list(decode(raw));
  const header = decodeHeader(top[0]!);
  const txs = list(top[1]).map(decodeTx);
  const uncles = list(top[2]).map(decodeHeader);
  const withdrawals = top.length > 3 ? list(top[3]).map((w) => list(w)) : null;
  return { raw, header, txs, uncles, withdrawals };
}

const HEADER_KEYS = [
  "parentHash", "sha3Uncles", "miner", "stateRoot", "transactionsRoot", "receiptsRoot", "logsBloom",
  "difficulty", "number", "gasLimit", "gasUsed", "timestamp", "extraData", "mixHash", "nonce",
  "baseFeePerGas", "withdrawalsRoot", "blobGasUsed", "excessBlobGas", "parentBeaconBlockRoot", "requestsHash",
] as const;
// Integer fields are QUANTITY; the rest are DATA.
const QUANTITY_KEYS = new Set(["difficulty", "number", "gasLimit", "gasUsed", "timestamp", "baseFeePerGas", "blobGasUsed", "excessBlobGas"]);

/** The header's JSON fields (without size, transactions, uncles or withdrawals). */
export function headerJson(h: Header): Record<string, unknown> {
  const out: Record<string, unknown> = { hash: data(h.hash) };
  h.fields.forEach((f, i) => {
    const key = HEADER_KEYS[i];
    if (!key) return;
    out[key] = QUANTITY_KEYS.has(key) ? quantityBytes(bytes(f)) : data(bytes(f));
  });
  return out;
}

export function withdrawalJson(w: Rlp[]): Record<string, string> {
  return {
    index: quantityBytes(bytes(w[0])),
    validatorIndex: quantityBytes(bytes(w[1])),
    address: data(bytes(w[2])),
    amount: quantityBytes(bytes(w[3])),
  };
}

/** The block's JSON without transactions (filled in by the caller: hashes or objects). */
export function blockJson(b: Block): Record<string, unknown> {
  const out = headerJson(b.header);
  out.size = quantity(b.raw.length);
  out.uncles = b.uncles.map((u) => data(u.hash));
  if (b.withdrawals) out.withdrawals = b.withdrawals.map(withdrawalJson);
  return out;
}
