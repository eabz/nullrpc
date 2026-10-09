// Test-only writer: turns a reference node's JSON (test/fixtures/mainnet) into the bytes the
// archive stores (storage.md, "Block records"). It stands in for the Go daemon's writer until
// that writer commits golden fixtures; the header and transaction hashes it produces must match
// the chain, which checks the encoding byte for byte.

import { readFileSync, readdirSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { concat, parseData } from "../src/eth/hex";
import { encodeBytes, encodeList, intBytes } from "../src/eth/rlp";

type Json = Record<string, any>;

export interface Fixture {
  block: Json;
  receipts: Json[];
  uncles: Json[];
}

const DIR = new URL("./fixtures/mainnet/", import.meta.url);

export function fixtures(): Fixture[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".json.zst"))
    .map((f) => JSON.parse(zstdDecompressSync(readFileSync(new URL(f, DIR))).toString()) as Fixture)
    .sort((a, b) => Number(a.block.number) - Number(b.block.number));
}

const hex = (v: string) => parseData(v)!;
const int = (v: string | undefined) => encodeBytes(intBytes(BigInt(v ?? "0x0")));
const str = (v: string) => encodeBytes(hex(v));
const addr = (v: string | null) => encodeBytes(v ? hex(v) : new Uint8Array());

const HEADER: [string, "int" | "data"][] = [
  ["parentHash", "data"], ["sha3Uncles", "data"], ["miner", "data"], ["stateRoot", "data"],
  ["transactionsRoot", "data"], ["receiptsRoot", "data"], ["logsBloom", "data"], ["difficulty", "int"],
  ["number", "int"], ["gasLimit", "int"], ["gasUsed", "int"], ["timestamp", "int"], ["extraData", "data"],
  ["mixHash", "data"], ["nonce", "data"], ["baseFeePerGas", "int"], ["withdrawalsRoot", "data"],
  ["blobGasUsed", "int"], ["excessBlobGas", "int"], ["parentBeaconBlockRoot", "data"], ["requestsHash", "data"],
];

export function encodeHeader(h: Json): Uint8Array {
  const items: Uint8Array[] = [];
  for (const [key, kind] of HEADER) {
    if (h[key] === undefined) break;
    items.push(kind === "int" ? int(h[key]) : str(h[key]));
  }
  return encodeList(items);
}

const accessList = (l: Json[]) => encodeList(l.map((e) => encodeList([str(e.address), encodeList(e.storageKeys.map(str))])));

export function encodeTx(t: Json): Uint8Array {
  const sig = [int(t.yParity ?? t.v), int(t.r), int(t.s)];
  const type = Number(t.type);
  if (type === 0) return encodeList([int(t.nonce), int(t.gasPrice), int(t.gas), addr(t.to), int(t.value), str(t.input), int(t.v), int(t.r), int(t.s)]);
  let body: Uint8Array[];
  if (type === 1) body = [int(t.chainId), int(t.nonce), int(t.gasPrice), int(t.gas), addr(t.to), int(t.value), str(t.input), accessList(t.accessList)];
  else {
    body = [int(t.chainId), int(t.nonce), int(t.maxPriorityFeePerGas), int(t.maxFeePerGas), int(t.gas), addr(t.to), int(t.value), str(t.input), accessList(t.accessList)];
    if (type === 3) body.push(int(t.maxFeePerBlobGas), encodeList(t.blobVersionedHashes.map(str)));
    if (type === 4)
      body.push(encodeList(t.authorizationList.map((a: Json) => encodeList([int(a.chainId), str(a.address), int(a.nonce), int(a.yParity), int(a.r), int(a.s)]))));
  }
  return concat(Uint8Array.of(type), encodeList([...body, ...sig]));
}

export function encodeRawBlock(f: Fixture): Uint8Array {
  const b = f.block;
  const txs = b.transactions.map((t: Json) => {
    const raw = encodeTx(t);
    return Number(t.type) === 0 ? raw : encodeBytes(raw);
  });
  const items = [encodeHeader(b), encodeList(txs), encodeList(f.uncles.map(encodeHeader))];
  if (b.withdrawals) items.push(encodeList(b.withdrawals.map((w: Json) => encodeList([int(w.index), int(w.validatorIndex), str(w.address), int(w.amount)]))));
  return encodeList(items);
}

/** The block record frame (uncompressed). */
export function encodeRecord(f: Fixture): Uint8Array {
  const senders = concat(...f.block.transactions.map((t: Json) => hex(t.from)));
  const receipts = f.receipts.map((r) => {
    const status = r.root ? str(r.root) : r.status === "0x1" ? encodeBytes(Uint8Array.of(1)) : encodeBytes(new Uint8Array());
    const logs = encodeList(r.logs.map((l: Json) => encodeList([str(l.address), encodeList(l.topics.map(str)), str(l.data)])));
    return encodeList([int(r.type), status, int(r.cumulativeGasUsed), logs]);
  });
  const blobGasPrice = f.receipts.find((r) => r.blobGasPrice)?.blobGasPrice ?? "0x0";
  return encodeList([encodeBytes(encodeRawBlock(f)), encodeBytes(senders), encodeList(receipts), int(blobGasPrice), encodeList([])]);
}
