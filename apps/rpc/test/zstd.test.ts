// The archive's frames decode through the zstd WebAssembly module (packages/zstd): a real
// fixture frame (test/fixtures/mainnet, zstd files written by the zstd CLI) goes through
// Archive.decodeFrame with its recorded digest and length, as a pack frame does.

import { backend } from "@nullrpc/zstd";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { Archive } from "../src/archive/archive";
import type { FrameRef } from "../src/archive/types";
import { MemorySource } from "../src/archive/source";

const FIXTURES = new URL("./fixtures/mainnet/", import.meta.url);

describe("archive frames through the zstd WebAssembly decoder", () => {
  const archive = new Archive(new MemorySource(new Map()), "1-test");
  const pack = { key: "1-test/segments/0/blocks.pack", bytes: 0, sha256: "" };

  for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith(".json.zst")).slice(0, 4)) {
    it(`decodes ${name}`, async () => {
      const compressed = new Uint8Array(readFileSync(new URL(name, FIXTURES)));
      const plain = zstdDecompressSync(compressed);
      const f: FrameRef = { pack, offset: 16, compressed: compressed.length, uncompressed: plain.length, sha256: new Uint8Array(createHash("sha256").update(compressed).digest()) };
      const out = await archive.decodeFrame(compressed, f);
      expect(backend()).toBe("wasm");
      expect(out.length).toBe(plain.length);
      expect(Buffer.from(out).equals(plain)).toBe(true);
      expect(JSON.parse(new TextDecoder().decode(out))).toHaveProperty("block");
    });
  }

  it("refuses a frame whose recorded length is wrong", async () => {
    const compressed = new Uint8Array(readFileSync(new URL("1000000.json.zst", FIXTURES)));
    const plain = zstdDecompressSync(compressed);
    const sha256 = new Uint8Array(createHash("sha256").update(compressed).digest());
    await expect(archive.decodeFrame(compressed, { pack, offset: 16, compressed: compressed.length, uncompressed: plain.length + 1, sha256 })).rejects.toThrow(/length mismatch/);
    await expect(archive.decodeFrame(compressed, { pack, offset: 16, compressed: compressed.length, uncompressed: plain.length - 1, sha256 })).rejects.toThrow(/zstd/);
  });
});
