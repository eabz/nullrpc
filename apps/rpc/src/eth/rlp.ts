// RLP decoding. Every node keeps `raw`, its exact encoding as a view into the input, so block
// and transaction hashes are computed over the stored bytes without re-encoding.

export type Rlp = RlpBytes | RlpList;
export interface RlpBytes {
  list: false;
  value: Uint8Array;
  raw: Uint8Array;
}
export interface RlpList {
  list: true;
  items: Rlp[];
  raw: Uint8Array;
}

export class RlpError extends Error {}

/** Decodes one complete RLP item; trailing bytes are an error. */
export function decode(input: Uint8Array): Rlp {
  const [item, end] = decodeAt(input, 0);
  if (end !== input.length) throw new RlpError("trailing bytes");
  return item;
}

function length(input: Uint8Array, at: number, n: number): number {
  if (at + n > input.length) throw new RlpError("truncated length");
  if (input[at] === 0) throw new RlpError("non-canonical length");
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + input[at + i]!;
  if (v < 56) throw new RlpError("non-canonical length");
  return v;
}

function decodeAt(input: Uint8Array, at: number): [Rlp, number] {
  const b = input[at];
  if (b === undefined) throw new RlpError("truncated");
  if (b < 0x80) return [{ list: false, value: input.subarray(at, at + 1), raw: input.subarray(at, at + 1) }, at + 1];
  if (b < 0xc0) {
    let start: number, n: number;
    if (b < 0xb8) {
      start = at + 1;
      n = b - 0x80;
      if (n === 1 && (input[start] ?? 0) < 0x80) throw new RlpError("non-canonical single byte");
    } else {
      const ll = b - 0xb7;
      n = length(input, at + 1, ll);
      start = at + 1 + ll;
    }
    const end = start + n;
    if (end > input.length) throw new RlpError("truncated string");
    return [{ list: false, value: input.subarray(start, end), raw: input.subarray(at, end) }, end];
  }
  let start: number, n: number;
  if (b < 0xf8) {
    start = at + 1;
    n = b - 0xc0;
  } else {
    const ll = b - 0xf7;
    n = length(input, at + 1, ll);
    start = at + 1 + ll;
  }
  const end = start + n;
  if (end > input.length) throw new RlpError("truncated list");
  const items: Rlp[] = [];
  let p = start;
  while (p < end) {
    const [item, next] = decodeAt(input, p);
    items.push(item);
    p = next;
  }
  if (p !== end) throw new RlpError("list overrun");
  return [{ list: true, items, raw: input.subarray(at, end) }, end];
}

export function bytes(item: Rlp | undefined): Uint8Array {
  if (!item || item.list) throw new RlpError("expected bytes");
  return item.value;
}

export function list(item: Rlp | undefined): Rlp[] {
  if (!item || !item.list) throw new RlpError("expected list");
  return item.items;
}

// ---- encoding (used for derived values such as legacy receipts' consensus form and tests)

function header(n: number, short: number): Uint8Array {
  if (n < 56) return Uint8Array.of(short + n);
  const be: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) be.unshift(v % 256);
  return Uint8Array.of(short + 55 + be.length, ...be);
}

export function encodeBytes(value: Uint8Array): Uint8Array {
  if (value.length === 1 && value[0]! < 0x80) return value;
  const h = header(value.length, 0x80);
  const out = new Uint8Array(h.length + value.length);
  out.set(h);
  out.set(value, h.length);
  return out;
}

export function encodeList(items: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const i of items) n += i.length;
  const h = header(n, 0xc0);
  const out = new Uint8Array(h.length + n);
  out.set(h);
  let o = h.length;
  for (const i of items) {
    out.set(i, o);
    o += i.length;
  }
  return out;
}

/** Minimal big-endian bytes of a non-negative integer (empty for zero). */
export function intBytes(v: number | bigint): Uint8Array {
  let x = BigInt(v);
  const out: number[] = [];
  while (x > 0n) {
    out.unshift(Number(x & 0xffn));
    x >>= 8n;
  }
  return Uint8Array.from(out);
}
