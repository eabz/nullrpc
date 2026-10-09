// The archive's frames decode through the WebAssembly module (packages/frames): a real
// fixture frame (test/fixtures/mainnet, zstd files written by the zstd CLI) goes through
// Archive.decodeFrame with its recorded digest and length, as a pack frame does.

import { backend } from "@nullrpc/frames";
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

// ---- eth_getLogs extraction

import { frameLogs as wasmFrameLogs, FrameError } from "@nullrpc/frames";
import { blockLogs, decodeRecord, frameLogs, frameLogsJs, logMatches, type LogFilter } from "../src/eth/record";
import { parseData } from "../src/eth/hex";
import { encodeRecord, fixtures } from "./encode";

const TRANSFER = parseData("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef")!;

describe("frameLogs through the WebAssembly module", () => {
  const records = fixtures().map((f) => {
    const frame = encodeRecord(f);
    const rec = decodeRecord(frame);
    return { frame, rec, hash: rec.block.header.hash, name: rec.block.header.number };
  });
  const withLogs = records.filter((r) => blockLogs(r.rec).length > 0);
  expect(withLogs.length).toBeGreaterThan(3);
  const some = blockLogs(withLogs[0]!.rec);
  const first = some[0]!;
  const last = some[some.length - 1]!;

  const filters: [string, LogFilter][] = [
    ["everything", { addresses: [], topics: [] }],
    ["Transfer topic", { addresses: [], topics: [[TRANSFER]] }],
    ["one address", { addresses: [first.address], topics: [] }],
    ["two addresses", { addresses: [first.address, last.address], topics: [] }],
    ["address and topic", { addresses: [first.address], topics: [[first.topics[0]!]] }],
    ["any topic0, fixed topic2", { addresses: [], topics: [null, null, [first.topics[2] ?? new Uint8Array(32)]] }],
    ["two values at topic0", { addresses: [], topics: [[TRANSFER, first.topics[0]!]] }],
    ["four positions", { addresses: [], topics: [[first.topics[0]!], null, null, [new Uint8Array(32)]] }],
    ["nothing matches", { addresses: [new Uint8Array(20)], topics: [] }],
  ];

  for (const r of records) {
    for (const [label, filter] of filters) {
      it(`block ${r.name}, ${label}: equals the JavaScript decoder and a full scan`, () => {
        const wasm = wasmFrameLogs(r.frame, r.hash, filter);
        expect(wasm).not.toBeNull();
        const js = frameLogsJs(r.frame, r.hash, (a, t) => logMatches(a, t, filter));
        expect(JSON.stringify(wasm)).toBe(JSON.stringify(js));
        const scan = blockLogs(r.rec).filter((l) => logMatches(l.address, l.topics, filter)).map((l) => l.json);
        expect(wasm).toEqual(scan);
        expect(frameLogs(r.frame, r.hash, filter)).toEqual(scan);
      });
    }
  }

  it("finds logs, including several per transaction, with block-wide logIndex", () => {
    const all = withLogs.flatMap((r) => wasmFrameLogs(r.frame, r.hash, { addresses: [], topics: [] })!);
    expect(all.length).toBe(withLogs.reduce((n, r) => n + blockLogs(r.rec).length, 0));
    const indexes = all.filter((l) => l.blockNumber === all[0]!.blockNumber).map((l) => parseInt(l.logIndex as string, 16));
    expect(indexes).toEqual(indexes.map((_, i) => i));
    expect(all[0]).toMatchObject({ removed: false, transactionIndex: expect.stringMatching(/^0x[0-9a-f]+$/), blockHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
  });

  it("refuses a record whose header does not hash to the offsets record's hash, and the fallback says why", () => {
    const r = withLogs[0]!;
    const wrong = new Uint8Array(32);
    expect(() => wasmFrameLogs(r.frame, wrong, { addresses: [], topics: [] })).toThrow(FrameError);
    expect(() => frameLogs(r.frame, wrong, { addresses: [], topics: [] })).toThrow(/does not match its offsets record/);
  });

  it("refuses malformed records", () => {
    const r = withLogs[0]!;
    expect(() => wasmFrameLogs(r.frame.subarray(0, r.frame.length - 10), r.hash, { addresses: [], topics: [] })).toThrow(FrameError);
    expect(() => wasmFrameLogs(new Uint8Array([0xc0]), r.hash, { addresses: [], topics: [] })).toThrow(FrameError);
    expect(() => frameLogs(new Uint8Array([0xc0]), r.hash, { addresses: [], topics: [] })).toThrow();
  });
});
