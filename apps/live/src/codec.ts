// Binary encodings shared with the nullrpc daemon (docs/storage.md, "Durable Objects").

import { keccak_256 } from "@noble/hashes/sha3";

export const DOMAIN = { accounts: 1, storage: 2, code: 3, wipe: 4 } as const;
export type Domain = keyof typeof DOMAIN;
const KEY_LEN: Record<number, number> = { 1: 20, 2: 52, 3: 32, 4: 20 };
export const DOMAIN_NAME: Record<number, Domain> = { 1: "accounts", 2: "storage", 3: "code", 4: "wipe" };

/** One state entry of a block's diff. `value` is null for a wipe. */
export interface Entry {
  domain: number;
  key: Uint8Array;
  value: Uint8Array | null;
}

export class Reader {
  at = 0;
  constructor(readonly b: Uint8Array) {}
  uvarint(): number {
    let x = 0;
    let s = 1;
    for (;;) {
      if (this.at >= this.b.length) throw new Error("truncated varint");
      const c = this.b[this.at++] as number;
      x += (c & 0x7f) * s;
      if (c < 0x80) return x;
      s *= 128;
    }
  }
  bytes(n: number): Uint8Array {
    if (this.at + n > this.b.length) throw new Error("truncated bytes");
    const out = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  done(): boolean {
    return this.at >= this.b.length;
  }
}

/**
 * A row holds one group of consecutive blocks, keyed by its first block; its data is one
 * section per block: uvarint(number - first) hash[32] uvarint(len) payload.
 */
export interface Section {
  number: number;
  hash: string; // 0x-prefixed
  payload: Uint8Array;
}

export function decodeSections(first: number, data: Uint8Array): Section[] {
  const r = new Reader(data);
  const out: Section[] = [];
  while (!r.done()) {
    const number = first + r.uvarint();
    const hash = "0x" + hex(r.bytes(32));
    out.push({ number, hash, payload: r.bytes(r.uvarint()) });
  }
  return out;
}

function uvarint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

export function encodeSections(first: number, sections: Section[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (const s of sections) {
    const head = new Uint8Array([...uvarint(s.number - first), ...unhex(s.hash), ...uvarint(s.payload.length)]);
    chunks.push(head, s.payload);
    size += head.length + s.payload.length;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * A shard section's payload: per entry a domain byte, the key (its length set by the domain),
 * then, except for a wipe, uvarint(len) and the value.
 */
export function decodeEntries(data: Uint8Array): Entry[] {
  const r = new Reader(data);
  const out: Entry[] = [];
  while (!r.done()) {
    const domain = r.bytes(1)[0] as number;
    const len = KEY_LEN[domain];
    if (!len) throw new Error(`unknown domain ${domain}`);
    const key = r.bytes(len);
    const value = domain === DOMAIN.wipe ? null : r.bytes(r.uvarint());
    out.push({ domain, key, value });
  }
  return out;
}

/** A ChainDO section's payload: uvarint(len) record, uvarint(len) witness, uvarint(n) tx hashes (32 bytes each). */
export interface BlockData {
  record: Uint8Array;
  witness: Uint8Array;
  txHashes: Uint8Array[];
}

export function decodeBlockData(data: Uint8Array): BlockData {
  const r = new Reader(data);
  const record = r.bytes(r.uvarint());
  const witness = r.bytes(r.uvarint());
  const n = r.uvarint();
  const txHashes: Uint8Array[] = [];
  for (let i = 0; i < n; i++) txHashes.push(r.bytes(32));
  return { record, witness, txHashes };
}

export function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function unhex(s: string): Uint8Array {
  const h = s.startsWith("0x") ? s.slice(2) : s;
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error("invalid hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The shard of a state key: keccak256(address)[0] mod n for accounts, storage and wipes; code_hash[0] mod n for code. */
export function shardOf(domain: number, key: Uint8Array, shards: number): number {
  if (domain === DOMAIN.code) return (key[0] as number) % shards;
  return (keccak_256(key.subarray(0, 20))[0] as number) % shards;
}

/** Rows are split into parts of at most 1 MiB (SQLite rows are limited to 2 MB). */
export const PART_BYTES = 1 << 20;

export function split(data: Uint8Array): Uint8Array[] {
  if (data.length === 0) return [data];
  const parts: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += PART_BYTES) parts.push(data.subarray(i, i + PART_BYTES));
  return parts;
}

export function join(parts: ArrayBuffer[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(new Uint8Array(p), at);
    at += p.byteLength;
  }
  return out;
}

export interface BlockId {
  number: number;
  hash: string; // 0x-prefixed lowercase
}

/** The RLP item at `at`: its payload is b[start, end). */
function rlpItem(b: Uint8Array, at: number): { list: boolean; start: number; end: number } {
  const p = b[at];
  if (p === undefined) throw new Error("truncated rlp");
  let list = false;
  let start = at + 1;
  let len: number;
  if (p < 0x80) return { list, start: at, end: at + 1 };
  if (p < 0xb8) len = p - 0x80;
  else if (p < 0xc0 || p >= 0xf8) {
    list = p >= 0xf8;
    const n = p - (list ? 0xf7 : 0xb7);
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + (b[at + 1 + i] ?? 0);
    start += n;
  } else {
    list = true;
    len = p - 0xc0;
  }
  if (start + len > b.length) throw new Error("truncated rlp");
  return { list, start, end: start + len };
}

/**
 * The timestamp (seconds) in a block record: the record is the RLP list [raw_block, …], raw_block
 * the block's RLP [header, …], and the timestamp the header's 12th field. Null if malformed.
 */
export function recordTimestamp(record: Uint8Array): number | null {
  try {
    const top = rlpItem(record, 0);
    const raw = rlpItem(record, top.start);
    if (!top.list || raw.list) return null;
    const block = rlpItem(record, raw.start);
    const header = rlpItem(record, block.start);
    if (!block.list || !header.list) return null;
    let at = header.start;
    for (let i = 0; i < 11; i++) at = rlpItem(record, at).end;
    const ts = rlpItem(record, at);
    if (ts.list || ts.end > header.end || ts.end - ts.start > 6) return null;
    let n = 0;
    for (let i = ts.start; i < ts.end; i++) n = n * 256 + (record[i] as number);
    return n;
  } catch {
    return null;
  }
}

/** A block id with a lowercase hash, or an error: number a safe integer ≥ 0, hash 0x + 64 hex. */
export function normalizeBlockId(v: unknown, what: string): BlockId {
  const b = v as { number?: unknown; hash?: unknown } | null;
  const hash = typeof b?.hash === "string" ? b.hash.toLowerCase() : "";
  if (!b || typeof b.number !== "number" || !Number.isSafeInteger(b.number) || b.number < 0 || !/^0x[0-9a-f]{64}$/.test(hash)) {
    throw new TypeError(`invalid ${what}`);
  }
  return { number: b.number, hash };
}

/** A state key as lowercase hex without 0x, or an error: accounts, storage and code keys only. */
export function normalizeKey(domain: number, keyHex: unknown): string {
  if (domain !== DOMAIN.accounts && domain !== DOMAIN.storage && domain !== DOMAIN.code) throw new TypeError(`invalid domain ${domain}`);
  const h = typeof keyHex === "string" ? keyHex.replace(/^0x/i, "").toLowerCase() : "";
  if (h.length !== 2 * (KEY_LEN[domain] as number) || /[^0-9a-f]/.test(h)) throw new TypeError(`invalid key for domain ${domain}`);
  return h;
}
