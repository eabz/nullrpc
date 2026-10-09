// zstd frame decompression for the RPC Worker (apps/rpc/src/archive): the C library compiled to
// WebAssembly (crate/, built by scripts/build.sh into crate/pkg and bundled by wrangler's
// CompiledWasm rule), about ten times faster than the pure-JavaScript fzstd on Workers. The
// instance is created on the first frame, not at module load (Workers' startup limit). When the
// module cannot be instantiated, every frame goes through fzstd instead, which is the same
// interface: `decompress(compressed, out)` fills `out` and returns the filled prefix.

import { decompress as fzstd } from "fzstd";
// @ts-ignore -- a compiled WebAssembly.Module (wrangler's CompiledWasm rule; test/wasm-node.ts under Node)
import module from "../crate/pkg/zstd.wasm";

interface Exports {
  memory: WebAssembly.Memory;
  nullrpc_alloc(len: number): number;
  nullrpc_free(ptr: number, len: number): void;
  nullrpc_decompress(src: number, srcLen: number, dst: number, dstLen: number): number;
}

/** A buffer in the module's memory, grown (reallocated) to the largest frame seen. */
interface Region {
  ptr: number;
  cap: number;
}

interface Decoder {
  wasm: Exports;
  src: Region;
  dst: Region;
}

// undefined: not tried yet; null: instantiation failed (fzstd serves every frame).
let decoder: Decoder | null | undefined;

function instantiate(): Decoder | null {
  if (decoder !== undefined) return decoder;
  try {
    const wasm = new WebAssembly.Instance(module as WebAssembly.Module, {}).exports as unknown as Exports;
    if (typeof wasm.nullrpc_decompress !== "function" || !(wasm.memory instanceof WebAssembly.Memory)) throw new Error("unexpected exports");
    decoder = { wasm, src: { ptr: 0, cap: 0 }, dst: { ptr: 0, cap: 0 } };
  } catch (e) {
    console.error("zstd WebAssembly unavailable, decoding with fzstd", e instanceof Error ? e.message : String(e));
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
  // Round up so a run of slightly larger frames does not reallocate for each.
  const cap = Math.max(len, 64 * 1024, Math.ceil(len * 1.25));
  const ptr = d.wasm.nullrpc_alloc(cap);
  if (!ptr) throw new Error(`zstd: cannot allocate ${cap} bytes`);
  r.ptr = ptr;
  r.cap = cap;
}

/** Which decoder serves frames: known once the first frame has been decoded. */
export function backend(): "wasm" | "fzstd" {
  return instantiate() ? "wasm" : "fzstd";
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
