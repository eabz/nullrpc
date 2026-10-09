// eth_getLogs under the read budget: planned index reads (whole small objects, shared records
// and frames), coalesced block runs, and the -32005 refusal with the range that fits.

import { describe, expect, test } from "vitest";
import { Archive } from "../src/archive/archive";
import { logCandidates, logIndexCost, logIndexRangeFor } from "../src/archive/logindex";
import { MemorySource } from "../src/archive/source";
import { Chain } from "../src/chain";
import { parseData } from "../src/eth/hex";
import type { BlockId, LiveApi, LiveState } from "../src/live";
import { Live } from "../src/live";
import { getLogs, MAX_BLOCKS, MAX_RANGE } from "../src/methods/logs";
import { buildArchive, logIndex, PREFIX } from "./archive";
import { encodeRecord, fixtures, type Fixture } from "./encode";

const FIXTURES = fixtures();
const ALL_LOGS = FIXTURES.flatMap((f) => f.receipts.flatMap((r) => r.logs));
const hex = (n: number) => "0x" + n.toString(16);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Two log index objects, split between 20,000,000 and 20,000,001 (65,536-block partitions: large directories, read per record). */
const SPLIT = buildArchive(FIXTURES, {
  extra: (b) => {
    const cut = FIXTURES.findIndex((f) => Number(f.block.number) === 20_000_001);
    const lo = logIndex(b, FIXTURES.slice(0, cut));
    const hi = logIndex(b, FIXTURES.slice(cut));
    return { log_index: { ...lo, objects: [...lo.objects, ...hi.objects] } };
  },
});
/** One partition over every fixture: a 896-byte directory and a small pack, read whole. */
const SMALL = buildArchive(FIXTURES, { extra: (b) => ({ log_index: logIndex(b, FIXTURES, 2 ** 25) }) });

// The archive caches HEAD.json per prefix for 10 s of its clock: every chain opens later.
let clock = Date.now();
const later = () => (clock += 60_000);
async function open(objects: Map<string, Uint8Array>) {
  const source = new MemorySource(objects);
  const chain = await Chain.open(new Archive(source, PREFIX), null, later());
  return { chain, source };
}
const indexReads = (s: MemorySource) => s.reads.filter((r) => r.key.includes("/log-index/")).length;
const packReads = (s: MemorySource, name: string) => s.reads.filter((r) => r.key.endsWith(name));
const scan = (pred: (l: { address: string; topics: string[]; blockNumber: string }) => boolean) => ALL_LOGS.filter(pred);
const inRange = (l: { blockNumber: string }, from: number, to: number) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to;

const addressesAt = (n: number) => [...new Set(FIXTURES.find((f) => Number(f.block.number) === n)!.receipts.flatMap((r) => r.logs.map((l: { address: string }) => l.address)))];

describe("log index reads are planned and shared", () => {
  test("a large object costs one record and one frame per value and partition, shared across equal values", async () => {
    const { chain, source } = await open(SPLIT);
    const addrs = addressesAt(20_000_000).slice(0, 3);
    const groups = [{ tag: 0, values: addrs.map((a) => parseData(a)!) }];
    // The older object (291 partitions, a 260 KiB directory) is read per record: 2 per value;
    // the newer one (46 partitions, 41 KiB) is read whole: 2 in all.
    const cost = logIndexCost(chain.pin, groups, 20_000_000, 20_000_001);
    expect(cost).toBe(2 * addrs.length + 2);
    const found = await logCandidates(chain.archiveHandle, chain.pin, groups, 20_000_000, 20_000_001);
    expect(found.reads).toBe(indexReads(source));
    expect(found.reads).toBeLessThanOrEqual(cost);
    expect(found.reads).toBeGreaterThanOrEqual(addrs.length + 1 + 2);
    expect(found.blocks).toEqual([20_000_000, ...(addrs.some((a) => addressesAt(20_000_001).includes(a)) ? [20_000_001] : [])]);
    // The same value twice adds no read.
    const twice = await logCandidates(chain.archiveHandle, chain.pin, [{ tag: 0, values: [...groups[0]!.values, groups[0]!.values[0]!] }], 20_000_000, 20_000_001);
    expect(twice.reads).toBe(found.reads);
    expect(twice.blocks).toEqual(found.blocks);
  });

  test("a small object is read whole: two reads whatever the filter", async () => {
    const { chain, source } = await open(SMALL);
    const addrs = [...addressesAt(20_000_000), ...addressesAt(23_000_000)].slice(0, 6);
    const groups = [{ tag: 0, values: addrs.map((a) => parseData(a)!) }, { tag: 1, values: [parseData(TRANSFER)!] }];
    expect(logIndexCost(chain.pin, groups, 1, 23_000_001)).toBe(2);
    const found = await logCandidates(chain.archiveHandle, chain.pin, groups, 1, 23_000_001);
    expect(found.reads).toBe(2);
    expect(indexReads(source)).toBe(2);
    const expected = [...new Set(scan((l) => addrs.includes(l.address) && l.topics[0] === TRANSFER).map((l) => Number(l.blockNumber)))].sort((a, b) => a - b);
    expect(found.blocks).toEqual(expected);
    // Through the method, with the exact filter applied.
    expect(await getLogs(chain, { fromBlock: hex(1), toBlock: hex(10_000), address: addrs, topics: [TRANSFER] })).toEqual(scan((l) => addrs.includes(l.address) && l.topics[0] === TRANSFER && inRange(l, 1, 10_000)));
  });
});

describe("candidate blocks are read in coalesced runs", () => {
  test("two neighbouring blocks cost one offsets page and one range read of blocks.pack", async () => {
    const { chain, source } = await open(SPLIT);
    const got = await getLogs(chain, { fromBlock: hex(20_000_000), toBlock: hex(20_000_001) });
    expect(got).toEqual(scan((l) => inRange(l, 20_000_000, 20_000_001)));
    expect(packReads(source, "offsets.bin")).toHaveLength(1);
    const runs = packReads(source, "blocks.pack");
    expect(runs).toHaveLength(1);
    // The run starts at a window boundary and covers both frames.
    expect(runs[0]!.offset % (256 * 1024)).toBe(0);
    expect(runs[0]!.length).toBeGreaterThan(0);
    // Blocks read for the query are in the request's block cache: no further reads.
    const before = source.reads.length;
    expect(await chain.block(20_000_001)).not.toBeNull();
    expect(source.reads.length).toBe(before);
  });

  test("results keep block order across runs and a topic filter", async () => {
    const { chain } = await open(SMALL);
    const got = await getLogs(chain, { fromBlock: hex(22_999_990), toBlock: hex(23_000_001), topics: [TRANSFER] });
    expect(got).toEqual(scan((l) => l.topics[0] === TRANSFER && inRange(l, 22_999_990, 23_000_001)));
  });
});

describe("the read budget refuses early with the range that fits", () => {
  const random = (seed: number) => "0x" + Array.from({ length: 40 }, (_, i) => ((seed * 31 + i * 7) % 16).toString(16)).join("");

  test("too many field values for the index: dropped oldest object first", async () => {
    const { chain, source } = await open(SPLIT);
    const addrs = Array.from({ length: 20 }, (_, i) => random(i + 1));
    // 19,999,000 … 20,000,001 touches one partition of each object: 2 × 20 reads per object.
    const groups = [{ tag: 0, values: addrs.map((a) => parseData(a)!) }];
    // 19,999,000 … 20,000,001 touches one partition of each object: 2 × 20 reads for the older
    // (large) object, 2 for the newer (small) one.
    expect(logIndexCost(chain.pin, groups, 19_999_000, 20_000_001)).toBe(42);
    expect(logIndexRangeFor(chain.pin, groups, 19_999_000, 20_000_001, 20)).toEqual({ from: 20_000_001, to: 20_000_001 });
    expect(logIndexRangeFor(chain.pin, groups, 19_999_000, 20_000_001, 1)).toBeNull();
    await expect(getLogs(chain, { fromBlock: hex(19_999_000), toBlock: hex(20_000_001), address: addrs }, 20)).rejects.toMatchObject({
      code: -32005,
      message: `query needs more than 20 reads; narrow the range to ${hex(20_000_001)}-${hex(20_000_001)}`,
      data: { fromBlock: hex(20_000_001), toBlock: hex(20_000_001) },
    });
    await expect(getLogs(chain, { fromBlock: hex(19_999_000), toBlock: hex(20_000_001), address: addrs }, 1)).rejects.toMatchObject({
      code: -32005,
      message: "query needs more than 1 reads; narrow the range or add filters",
    });
    expect(indexReads(source)).toBe(0);
    // Within budget: 42 reads planned, every value a miss, result empty.
    expect(await getLogs(chain, { fromBlock: hex(19_999_000), toBlock: hex(20_000_001), address: addrs }, 42)).toEqual([]);
    expect(indexReads(source)).toBeLessThanOrEqual(42);
  });

  test("index reads that fit but block runs that do not", async () => {
    const { chain, source } = await open(SPLIT);
    // No filter: two candidates, one offsets page, one run. Budget 1 pays the page, not the run.
    await expect(getLogs(chain, { fromBlock: hex(20_000_000), toBlock: hex(20_000_001) }, 1)).rejects.toMatchObject({ code: -32005, message: expect.stringMatching(/needs more than 1 reads/) });
    expect(packReads(source, "blocks.pack")).toHaveLength(0);
    expect(await getLogs(chain, { fromBlock: hex(20_000_000), toBlock: hex(20_000_001) }, 2)).toEqual(scan((l) => inRange(l, 20_000_000, 20_000_001)));
  });

  test("live-window blocks count one read each; the fitting range ends before the first that does not fit", async () => {
    const archived = FIXTURES.filter((f) => Number(f.block.number) <= 20_000_001);
    const window = FIXTURES.filter((f) => Number(f.block.number) > 20_000_001);
    const id = (f: Fixture): BlockId => ({ number: Number(f.block.number), hash: f.block.hash });
    const head = id(window.at(-1)!);
    const state: LiveState = { head, safe: head, finalized: id(window[0]!), promoted: id(archived.at(-1)!), generation: 1, shards: 16 };
    const calls: number[] = [];
    const api = {
      async state() {
        return state;
      },
      async block(key: number | string, pin: BlockId) {
        calls.push(Number(key));
        const f = window.find((w) => Number(w.block.number) === key);
        if (!f || Number(f.block.number) > pin.number) return null;
        return { stale: false as const, number: Number(f.block.number), hash: f.block.hash, record: Buffer.from(encodeRecord(f)).toString("hex") };
      },
    } as unknown as LiveApi;
    const objects = buildArchive(archived, { extra: (b) => ({ log_index: logIndex(b, archived) }) });
    const chain = await Chain.open(new Archive(new MemorySource(objects), PREFIX), new Live(api), later());
    // 12 live blocks under a budget of 10: the 11th (23,000,000) does not fit.
    await expect(getLogs(chain, { fromBlock: hex(22_999_990), toBlock: hex(23_000_001) }, 10)).rejects.toMatchObject({
      code: -32005,
      message: `query needs more than 10 reads; narrow the range to ${hex(22_999_990)}-${hex(22_999_999)}`,
      data: { fromBlock: hex(22_999_990), toBlock: hex(22_999_999) },
    });
    expect(calls).toEqual([]);
    expect(await getLogs(chain, { fromBlock: hex(22_999_990), toBlock: hex(23_000_001) }, 12)).toEqual(scan((l) => inRange(l, 22_999_990, 23_000_001)));
    expect(calls).toHaveLength(12);
    // More blocks than MAX_BLOCKS: the fitting range ends before the 1,001st block.
    await expect(getLogs(chain, { fromBlock: hex(22_999_000), toBlock: hex(23_000_001) })).rejects.toMatchObject({
      code: -32005,
      data: { fromBlock: hex(22_999_000), toBlock: hex(22_999_000 + MAX_BLOCKS - 1) },
    });
  });

  test("the range limit names the range that fits", async () => {
    const { chain } = await open(SPLIT);
    await expect(getLogs(chain, { fromBlock: "0x0", toBlock: hex(20_000) })).rejects.toMatchObject({ code: -32005, data: { fromBlock: "0x0", toBlock: hex(MAX_RANGE - 1) } });
  });
});
