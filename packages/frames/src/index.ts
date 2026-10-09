// Archive frame decoding for the RPC Worker (apps/rpc/src/archive, apps/rpc/src/eth/record.ts):
// zstd decompression and eth_getLogs extraction in WebAssembly (crate/, built by
// scripts/build.sh into crate/pkg and bundled by wrangler's CompiledWasm rule), where both run
// one to two orders of magnitude faster than in JavaScript. The instance is created on the first
// call, not at module load (Workers' startup limit). When the module cannot be instantiated,
// `decompress` goes through fzstd (the same interface) and `frameLogs` returns null for the
// caller's JavaScript decoder.

import { decompress as fzstd } from "fzstd";
// @ts-ignore -- a compiled WebAssembly.Module (wrangler's CompiledWasm rule; test/wasm-node.ts under Node)
import module from "../crate/pkg/frames.wasm";

interface Exports {
  memory: WebAssembly.Memory;
  nullrpc_alloc(len: number): number;
  nullrpc_free(ptr: number, len: number): void;
  nullrpc_decompress(src: number, srcLen: number, dst: number, dstLen: number): number;
  nullrpc_frame_logs(frame: number, frameLen: number, hash: number, filter: number, filterLen: number): number;
  nullrpc_receipts_logs(frame: number, frameLen: number, hash: number, number: number, filter: number, filterLen: number): number;
  nullrpc_out_ptr(): number;
}

/** A buffer in the module's memory, grown (reallocated) to the largest input seen. */
interface Region {
  ptr: number;
  cap: number;
}

interface Decoder {
  wasm: Exports;
  /** Compressed frames, and decompressed frames for `frameLogs`. */
  src: Region;
  /** Decompressed output. */
  dst: Region;
  /** A block hash followed by an encoded filter. */
  aux: Region;
}

// undefined: not tried yet; null: instantiation failed (the JavaScript paths serve everything).
let decoder: Decoder | null | undefined;

function instantiate(): Decoder | null {
  if (decoder !== undefined) return decoder;
  try {
    const wasm = new WebAssembly.Instance(module as WebAssembly.Module, {}).exports as unknown as Exports;
    if (typeof wasm.nullrpc_decompress !== "function" || typeof wasm.nullrpc_frame_logs !== "function" || typeof wasm.nullrpc_receipts_logs !== "function" || !(wasm.memory instanceof WebAssembly.Memory)) {
      throw new Error("unexpected exports");
    }
    decoder = { wasm, src: { ptr: 0, cap: 0 }, dst: { ptr: 0, cap: 0 }, aux: { ptr: 0, cap: 0 } };
  } catch (e) {
    console.error("frames WebAssembly unavailable, decoding in JavaScript", e instanceof Error ? e.message : String(e));
    decoder = null;
  }
  return decoder;
}

/** Makes `r` hold at least `len` bytes (a fresh allocation when it grows). */
function reserve(d: Decoder, r: Region, len: number): void {
  if (r.cap >= len) return;
  if (r.cap) d.wasm.nullrpc_free(r.ptr, r.cap);
  r.ptr = 0;
  r.cap = 0;
  // Round up so a run of slightly larger inputs does not reallocate for each.
  const cap = Math.max(len, 64 * 1024, Math.ceil(len * 1.25));
  const ptr = d.wasm.nullrpc_alloc(cap);
  if (!ptr) throw new Error(`frames: cannot allocate ${cap} bytes`);
  r.ptr = ptr;
  r.cap = cap;
}

/** Which decoder serves: known once the module has been instantiated or has failed to. */
export function backend(): "wasm" | "js" {
  return instantiate() ? "wasm" : "js";
}

/**
 * Decompresses one zstd frame into `out`, which the caller sized from the frame's recorded
 * uncompressed length. Returns `out` when the frame fills it exactly, else the filled prefix;
 * throws when the frame is malformed or larger than `out`.
 */
export function decompress(compressed: Uint8Array, out: Uint8Array): Uint8Array {
  const d = instantiate();
  if (!d) return fzstd(compressed, out);
  reserve(d, d.src, compressed.length);
  reserve(d, d.dst, out.length);
  // memory.buffer is re-read after every call into the module: an allocation may have grown
  // (and so replaced) the memory.
  new Uint8Array(d.wasm.memory.buffer, d.src.ptr, compressed.length).set(compressed);
  const n = d.wasm.nullrpc_decompress(d.src.ptr, compressed.length, d.dst.ptr, out.length);
  if (n < 0) throw new Error(`zstd: malformed frame (error ${-n})`);
  out.set(new Uint8Array(d.wasm.memory.buffer, d.dst.ptr, n));
  return n === out.length ? out : out.subarray(0, n);
}

// ---- eth_getLogs over block records

/** An eth_getLogs filter's value sets: any listed address (none: all), and per topic position null (any) or the accepted values. */
export interface LogFilter {
  addresses: Uint8Array[];
  topics: (Uint8Array[] | null)[];
}

/** The module could not decode the record: `code` as crate/src/lib.rs nullrpc_frame_logs documents. */
export class FrameError extends Error {
  constructor(readonly code: number) {
    super(`frames: record refused (code ${code})`);
  }
}

const encoded = new WeakMap<LogFilter, Uint8Array>();

/** The filter as the module reads it (crate/src/logs.rs parse_filter), encoded once per filter. */
function encodeFilter(f: LogFilter): Uint8Array {
  let out = encoded.get(f);
  if (out) return out;
  if (f.topics.length > 4) throw new Error("at most 4 topic positions");
  const len = 4 + f.addresses.length * 20 + 4 + f.topics.reduce((n, t) => n + 4 + (t ? t.length * 32 : 0), 0);
  out = new Uint8Array(len);
  const view = new DataView(out.buffer);
  let at = 0;
  const u32 = (v: number) => {
    view.setUint32(at, v, true);
    at += 4;
  };
  const put = (v: Uint8Array, width: number) => {
    if (v.length !== width) throw new Error(`filter value must be ${width} bytes`);
    out!.set(v, at);
    at += width;
  };
  u32(f.addresses.length);
  for (const a of f.addresses) put(a, 20);
  u32(f.topics.length);
  for (const t of f.topics) {
    u32(t ? t.length : 0xffffffff);
    for (const v of t ?? []) put(v, 32);
  }
  encoded.set(f, out);
  return out;
}

const utf8 = new TextDecoder();

/**
 * The logs of the block record `frame` (decompressed) that `filter` accepts, as eth_getLogs
 * returns them (address, topics, data, blockNumber, blockHash, blockTimestamp, transactionHash,
 * transactionIndex, logIndex, removed), decoding only the header, the receipts and the hash of a
 * transaction with an accepted log. `hash` is the block's hash from the offsets record, checked
 * against the header. Returns null when the module is unavailable; throws FrameError when the
 * module refuses the record (the caller's JavaScript decoder then reports why).
 */
export function frameLogs(frame: Uint8Array, hash: Uint8Array, filter: LogFilter): Record<string, unknown>[] | null {
  return extract(frame, hash, filter, (d, f) => d.wasm.nullrpc_frame_logs(d.src.ptr, frame.length, d.aux.ptr, d.aux.ptr + 32, f.length));
}

/**
 * `frameLogs` over a layout-2 receipts frame (docs/storage.md, "Block bundles": [number,
 * timestamp, tx_hashes, receipts, extras]), which carries everything a log needs. `number` is
 * the block's number from the offsets record; the frame must agree.
 */
export function receiptsLogs(frame: Uint8Array, hash: Uint8Array, number: number, filter: LogFilter): Record<string, unknown>[] | null {
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("block number must be a safe integer");
  return extract(frame, hash, filter, (d, f) => d.wasm.nullrpc_receipts_logs(d.src.ptr, frame.length, d.aux.ptr, number, d.aux.ptr + 32, f.length));
}

function extract(frame: Uint8Array, hash: Uint8Array, filter: LogFilter, call: (d: Decoder, f: Uint8Array) => number): Record<string, unknown>[] | null {
  const d = instantiate();
  if (!d) return null;
  if (hash.length !== 32) throw new Error("block hash must be 32 bytes");
  const f = encodeFilter(filter);
  reserve(d, d.src, frame.length);
  reserve(d, d.aux, 32 + f.length);
  let mem = new Uint8Array(d.wasm.memory.buffer);
  mem.set(frame, d.src.ptr);
  mem.set(hash, d.aux.ptr);
  mem.set(f, d.aux.ptr + 32);
  const n = call(d, f);
  if (n < 0) throw new FrameError(n);
  if (n === 0) return [];
  mem = new Uint8Array(d.wasm.memory.buffer);
  const ptr = d.wasm.nullrpc_out_ptr();
  return JSON.parse(utf8.decode(mem.subarray(ptr, ptr + n))) as Record<string, unknown>[];
}
