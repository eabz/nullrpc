// Hex and integer helpers for JSON-RPC values: QUANTITY (minimal hex, "0x0" for zero) and
// DATA (even-length hex of the exact bytes).

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

/** DATA: the bytes as 0x-prefixed lowercase hex. */
export function data(bytes: Uint8Array): string {
  let out = "0x";
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]!];
  return out;
}

/** QUANTITY from a number or bigint. */
export function quantity(value: number | bigint): string {
  return "0x" + value.toString(16);
}

/** QUANTITY from big-endian bytes (RLP integers), leading zeros ignored. */
export function quantityBytes(bytes: Uint8Array): string {
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) i++;
  if (i === bytes.length) return "0x0";
  let out = "0x" + bytes[i]!.toString(16);
  for (i++; i < bytes.length; i++) out += HEX[bytes[i]!];
  return out;
}

/** Big-endian bytes as a bigint. */
export function toBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i]!);
  return v;
}

/** Big-endian bytes as a number; throws above 2^53. */
export function toNumber(bytes: Uint8Array): number {
  if (bytes.length > 7) {
    const v = toBigInt(bytes);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("integer out of range");
    return Number(v);
  }
  let v = 0;
  for (let i = 0; i < bytes.length; i++) v = v * 256 + bytes[i]!;
  return v;
}

/** Parses 0x-prefixed hex DATA; returns null when malformed or not `length` bytes (if given). */
export function parseData(value: unknown, length?: number): Uint8Array | null {
  if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value)) return null;
  const n = (value.length - 2) / 2;
  if (length !== undefined && n !== length) return null;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(value.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

/** Parses a QUANTITY (no leading zeros, per the JSON-RPC spec, but leading zeros are tolerated). */
export function parseQuantity(value: unknown): number | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,14}$/.test(value)) return null;
  return parseInt(value.slice(2), 16);
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
