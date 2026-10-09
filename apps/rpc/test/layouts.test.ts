// Segment layouts (storage.md, "Block bundles"): a generation written in layout 2 (receipts in
// their own pack) answers every block, transaction, receipt and log query exactly as one in
// layout 1 does, and the receipts frame alone yields a block's logs.

import { backend, FrameError, receiptsLogs as wasmReceiptsLogs } from "@nullrpc/frames";
import { describe, expect, test } from "vitest";
import { Archive } from "../src/archive/archive";
import { MemorySource } from "../src/archive/source";
import { Chain } from "../src/chain";
import { parseData } from "../src/eth/hex";
import { blockLogs, decodeRecord, frameLogsJs, joinRecord, logMatches, receiptsLogs, receiptsLogsJs, type LogFilter } from "../src/eth/record";
import { getLogs } from "../src/methods/logs";
import { buildArchive, logIndex, PREFIX } from "./archive";
import { encodeRecord, encodeRecordParts, fixtures } from "./encode";

const FIXTURES = fixtures();
const TRANSFER_HEX = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TRANSFER = parseData(TRANSFER_HEX)!;
const hex = (n: number) => "0x" + n.toString(16);

let clock = Date.now();
async function open(layout: 1 | 2) {
  const objects = buildArchive(FIXTURES, { layout, extra: (b) => ({ log_index: logIndex(b, FIXTURES, 2 ** 25) }) });
  const source = new MemorySource(objects);
  const chain = await Chain.open(new Archive(source, PREFIX), null, (clock += 60_000));
  return { chain, source };
}

describe("layout-2 frames", () => {
  test("joined, the two frames are the layout-1 record byte for byte", () => {
    for (const f of FIXTURES) {
      const { block, receipts } = encodeRecordParts(f);
      expect(Buffer.from(joinRecord(block, receipts)).equals(encodeRecord(f))).toBe(true);
    }
  });

  test("the receipts frame yields the same logs as the record, through the module and in JavaScript", () => {
    expect(backend()).toBe("wasm");
    const filters: [string, LogFilter][] = [
      ["everything", { addresses: [], topics: [] }],
      ["Transfer topic", { addresses: [], topics: [[TRANSFER]] }],
      ["nothing matches", { addresses: [new Uint8Array(20)], topics: [] }],
    ];
    let checked = 0;
    for (const f of FIXTURES) {
      const record = encodeRecord(f);
      const { receipts } = encodeRecordParts(f);
      const rec = decodeRecord(record);
      const n = rec.block.header.number;
      for (const [, filter] of filters) {
        const want = (a: Uint8Array, t: Uint8Array[]) => logMatches(a, t, filter);
        const reference = frameLogsJs(record, rec.block.header.hash, want);
        expect(receiptsLogsJs(receipts, rec.block.header.hash, n, want)).toEqual(reference);
        const wasm = wasmReceiptsLogs(receipts, rec.block.header.hash, n, filter);
        expect(wasm).toEqual(reference);
        expect(receiptsLogs(receipts, rec.block.header.hash, n, filter)).toEqual(reference);
        checked += reference.length;
      }
      // The frame's number must agree with the offsets record's.
      expect(() => wasmReceiptsLogs(receipts, rec.block.header.hash, n + 1, filters[0]![1])).toThrow(FrameError);
      expect(() => receiptsLogsJs(receipts, rec.block.header.hash, n + 1, () => true)).toThrow(/for block/);
      expect(blockLogs(rec).length).toBeGreaterThanOrEqual(0);
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe("both layouts answer alike", () => {
  test("blocks, receipts and logs", async () => {
    const v1 = await open(1);
    const v2 = await open(2);
    for (const f of FIXTURES.slice(0, 6)) {
      const n = Number(f.block.number);
      const a = await v1.chain.block(n);
      const b = await v2.chain.block(n);
      expect(a && Buffer.from(a.frame).equals(b!.frame)).toBe(true);
      expect(b!.receipts.length).toBe(f.receipts.length);
      expect(await v2.chain.blockByHash(parseData(f.block.hash)!)).toBeTruthy();
    }
    for (const [from, to, topics] of [
      [20_000_000, 20_000_001, undefined],
      [22_999_990, 23_000_001, [TRANSFER_HEX]],
    ] as const) {
      const want = await getLogs(v1.chain, { fromBlock: hex(from), toBlock: hex(to), topics });
      const got = await getLogs(v2.chain, { fromBlock: hex(from), toBlock: hex(to), topics });
      expect(got).toEqual(want);
      expect(want.length).toBeGreaterThan(0);
    }
    // Layout 2 read no transaction bytes for the logs.
    expect(v2.source.reads.filter((r) => r.key.endsWith("/blocks.pack")).length).toBeLessThan(v1.source.reads.filter((r) => r.key.endsWith("/blocks.pack")).length);
  });
});
