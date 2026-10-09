import { randomBytes } from "node:crypto";
import { zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { backend, decompress } from "../src/index";

/** Compressible bytes: runs of a few symbols, so frames are small and real. */
function text(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = 97 + (x >> 16) % 7;
  }
  return out;
}

describe("zstd decompress", () => {
  it("decodes through the WebAssembly module", () => {
    const plain = text(10_000);
    const out = decompress(new Uint8Array(zstdCompressSync(plain)), new Uint8Array(plain.length));
    expect(backend()).toBe("wasm");
    expect(Buffer.from(out).equals(plain)).toBe(true);
  });

  it("returns the filled prefix when the frame is smaller than the buffer, like fzstd", () => {
    const plain = text(1000);
    const buffer = new Uint8Array(1500);
    const out = decompress(new Uint8Array(zstdCompressSync(plain)), buffer);
    expect(out.length).toBe(1000);
    expect(out.buffer).toBe(buffer.buffer);
    expect(Buffer.from(out).equals(plain)).toBe(true);
  });

  it("throws when the frame does not fit the buffer or is malformed", () => {
    const frame = new Uint8Array(zstdCompressSync(text(1000)));
    expect(() => decompress(frame, new Uint8Array(999))).toThrow(/zstd/);
    expect(() => decompress(frame.subarray(0, frame.length - 3), new Uint8Array(1000))).toThrow(/zstd/);
    expect(() => decompress(new Uint8Array([1, 2, 3, 4, 5]), new Uint8Array(10))).toThrow(/zstd/);
    // The decoder is still usable after an error.
    expect(Buffer.from(decompress(frame, new Uint8Array(1000))).equals(text(1000))).toBe(true);
  });

  it("grows its buffers for larger frames and keeps decoding smaller ones", () => {
    for (const n of [10, 100_000, 8 * 1024 * 1024, 7, 2_000_000, 0]) {
      const plain = n % 3 === 0 ? text(n, n) : new Uint8Array(randomBytes(n));
      const out = decompress(new Uint8Array(zstdCompressSync(plain)), new Uint8Array(n));
      expect(out.length).toBe(n);
      expect(Buffer.from(out).equals(plain)).toBe(true);
    }
  });
});
