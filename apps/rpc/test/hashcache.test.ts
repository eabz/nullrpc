// Hash lookups (src/chain.ts, src/archive/hashindex.ts): verified locations are kept per isolate
// and keyed to the generation that verified them, hash index directory pages are shared by
// lookups in one request and across requests, hashes the live window answers are not kept,
// and methods that need no receipts read a layout-2 block's frame alone.

import { beforeEach, describe, expect, test } from "vitest";
import { Archive } from "../src/archive/archive";
import { directoryPages } from "../src/archive/hashindex";
import { MemorySource } from "../src/archive/source";
import { Chain, hashLocations } from "../src/chain";
import { parseData } from "../src/eth/hex";
import { Live, type BlockId, type LiveApi, type LiveState } from "../src/live";
import { METHODS } from "../src/methods";
import { buildArchive, PREFIX } from "./archive";
import { encodeRecord, fixtures, type Fixture } from "./encode";

const ALL = fixtures();
// The archive holds everything up to 20,000,001 (P); the live window holds the Prague blocks.
const ARCHIVED = ALL.filter((f) => Number(f.block.number) <= 20_000_001);
const WINDOW = ALL.filter((f) => Number(f.block.number) > 20_000_001);
const LAYOUT2 = buildArchive(ARCHIVED);
const LAYOUT1 = buildArchive(ARCHIVED, { layout: 1 });
const id = (f: Fixture): BlockId => ({ number: Number(f.block.number), hash: f.block.hash });
const txOf = (f: Fixture, i: number) => f.block.transactions[i] as { hash: string };
const hexOf = (hash: string) => Buffer.from(parseData(hash)!).toString("hex");

let clock = Date.now() + Math.random() * 1e12;
/** A fresh pin per open: HEAD.json is cached 10 s per isolate. */
const tick = () => (clock += 60_000);

async function open(objects: Map<string, Uint8Array>, live: LiveApi | null = null) {
  const source = new MemorySource(objects);
  const chain = await Chain.open(new Archive(source, PREFIX), live ? new Live(live) : null, tick());
  const call = (method: string, ...params: unknown[]) => METHODS[method]!(chain, params, { chainId: 1 });
  return { chain, source, call };
}
const indexReads = (source: MemorySource) => source.reads.filter((r) => r.key.includes("/hash-index/"));
const directoryReads = (source: MemorySource) => source.reads.filter((r) => r.key.includes("/hash-index/") && r.key.endsWith(".dir"));
/** Segment frame reads, by pack name. */
const frameReads = (source: MemorySource) => source.reads.filter((r) => r.key.includes("/segments/") && r.key.endsWith(".pack")).map((r) => r.key.split("/").at(-1)).sort();

/** A fake live API over WINDOW that records what it was asked. */
function fakeLive() {
  const head = id(WINDOW.at(-1)!);
  const calls: string[] = [];
  const state: LiveState = { head, safe: head, finalized: id(WINDOW[0]!), promoted: id(ARCHIVED.at(-1)!), generation: 1, shards: 16 };
  const api: LiveApi = {
    async state() {
      return state;
    },
    async block(key, pin) {
      calls.push(`block:${key}`);
      const f = WINDOW.find((w) => (typeof key === "number" ? Number(w.block.number) === key : w.block.hash === key.toLowerCase()));
      if (!f || Number(f.block.number) > pin.number) return null;
      return { stale: false, number: Number(f.block.number), hash: f.block.hash, record: Buffer.from(encodeRecord(f)).toString("hex") };
    },
    async witness() {
      return null;
    },
    async txBlock(hash, pin) {
      calls.push(`tx:${hash}`);
      const f = WINDOW.find((w) => w.block.transactions.some((t: { hash: string }) => t.hash === hash));
      return f && Number(f.block.number) <= pin.number ? { stale: false, number: Number(f.block.number) } : null;
    },
    async getPinned() {
      return { stale: false, block: null, value: null };
    },
    async getPinnedMany(keys) {
      return { stale: false, values: keys.map(() => ({ block: null, value: null })) };
    },
    async scanPinned() {
      return { stale: false, slots: {} };
    },
  };
  return { api, calls };
}

beforeEach(() => {
  hashLocations.clear();
  directoryPages.clear();
});

describe("hash location cache", () => {
  test("a miss reads the index and remembers nothing", async () => {
    const { source, call } = await open(LAYOUT2);
    expect(await call("eth_getTransactionByHash", "0x" + "ab".repeat(32))).toBeNull();
    expect(await call("eth_getBlockByHash", "0x" + "cd".repeat(32), false)).toBeNull();
    expect(indexReads(source).length).toBeGreaterThan(0);
    expect(hashLocations.size).toBe(0);
  });

  test("a verified transaction location answers the next request without the index, for every method that resolves the hash", async () => {
    const f = ARCHIVED[3]!;
    const tx = txOf(f, 2);
    const first = await open(LAYOUT2);
    expect(await first.call("eth_getTransactionByHash", tx.hash)).toEqual(tx);
    expect(indexReads(first.source).length).toBeGreaterThan(0);
    expect(hashLocations.size).toBe(1);
    expect(hashLocations.get(`${PREFIX}:tx:${hexOf(tx.hash)}`)).toEqual({ block: Number(f.block.number), index: 2, generation: 1 });

    const second = await open(LAYOUT2);
    expect(await second.call("eth_getTransactionReceipt", tx.hash)).toEqual(f.receipts[2]);
    expect(indexReads(second.source)).toHaveLength(0);
    expect(frameReads(second.source)).toEqual(["blocks.pack", "receipts.pack"]);

    const third = await open(LAYOUT2);
    expect(await third.call("eth_getRawTransactionByHash", tx.hash)).toBe(tx.hash && (await third.call("debug_getRawTransaction", tx.hash)));
    expect(indexReads(third.source)).toHaveLength(0);
    expect(frameReads(third.source)).toEqual(["blocks.pack"]);
    expect(hashLocations.size).toBe(1);
  });

  test("a verified block location likewise", async () => {
    const f = ARCHIVED[1]!;
    const first = await open(LAYOUT2);
    expect(((await first.call("eth_getBlockByHash", f.block.hash, false)) as { number: string }).number).toBe(f.block.number);
    expect(indexReads(first.source).length).toBeGreaterThan(0);
    expect(hashLocations.get(`${PREFIX}:block:${hexOf(f.block.hash)}`)).toEqual({ block: Number(f.block.number), index: 0, generation: 1 });

    const second = await open(LAYOUT2);
    expect(await second.call("eth_getBlockTransactionCountByHash", f.block.hash)).toBe("0x" + f.block.transactions.length.toString(16));
    expect(await second.call("eth_getBlockByNumber", { blockHash: f.block.hash }, true)).toEqual(f.block);
    expect(indexReads(second.source)).toHaveLength(0);
    expect(frameReads(second.source)).toEqual(["blocks.pack"]);
  });

  test("directory pages are shared by lookups in one request and across requests", async () => {
    const objects = LAYOUT2;
    const a = txOf(ARCHIVED[0]!, 0);
    const b = txOf(ARCHIVED[2]!, 1);
    const c = txOf(ARCHIVED[4]!, 3);
    const first = await open(objects);
    const [ra, rb] = await Promise.all([first.call("eth_getTransactionByHash", a.hash), first.call("eth_getTransactionByHash", b.hash)]);
    expect(ra).toEqual(a);
    expect(rb).toEqual(b);
    // Two index objects, one transactions directory each: one page read per directory, not per lookup.
    expect(directoryReads(first.source)).toHaveLength(2);
    expect(new Set(directoryReads(first.source).map((r) => r.key)).size).toBe(2);

    const second = await open(objects);
    expect(await second.call("eth_getTransactionByHash", c.hash)).toEqual(c);
    expect(directoryReads(second.source)).toHaveLength(0);
    // The bucket frames are still read: the location of a new hash is not known.
    expect(indexReads(second.source).length).toBeGreaterThan(0);
  });

  test("a location is used only when the pinned generation's archive reaches its block", async () => {
    // Generation 2 archives through 20,000,001; generation 1 through 20,000,000 (other index objects).
    const gen2 = buildArchive(ARCHIVED, { generation: 2 });
    const gen1 = buildArchive(ARCHIVED.slice(0, -1));
    const last = ARCHIVED.at(-1)!;
    const tx = txOf(last, 0);
    const key = `${PREFIX}:tx:${hexOf(tx.hash)}`;

    const newer = await open(gen2);
    expect(newer.chain.pin.generation).toBe(2);
    expect(await newer.call("eth_getTransactionByHash", tx.hash)).toEqual(tx);
    expect(hashLocations.get(key)).toEqual({ block: 20_000_001, index: 0, generation: 2 });

    // A request still pinned to generation 1 reads its own index and does not find the hash.
    const older = await open(gen1);
    expect(older.chain.pin.generation).toBe(1);
    expect(older.chain.archived).toBe(20_000_000);
    expect(await older.call("eth_getTransactionByHash", tx.hash)).toBeNull();
    expect(indexReads(older.source).length).toBeGreaterThan(0);
    expect(hashLocations.get(key)).toEqual({ block: 20_000_001, index: 0, generation: 2 });

    // Back on generation 2 the location answers again.
    const again = await open(gen2);
    expect(await again.call("eth_getTransactionByHash", tx.hash)).toEqual(tx);
    expect(indexReads(again.source)).toHaveLength(0);

    // A location verified under generation 1 holds for generation 2, whose index objects differ.
    const old = txOf(ARCHIVED[0]!, 1);
    const g1 = await open(gen1);
    expect(await g1.call("eth_getTransactionByHash", old.hash)).toEqual(old);
    expect(hashLocations.get(`${PREFIX}:tx:${hexOf(old.hash)}`)?.generation).toBe(1);
    const g2 = await open(gen2);
    expect(await g2.call("eth_getTransactionByHash", old.hash)).toEqual(old);
    expect(indexReads(g2.source)).toHaveLength(0);
  });

  test("a wrong location is dropped and the hash resolved through the index", async () => {
    const f = ARCHIVED[2]!;
    const tx = txOf(f, 0);
    const key = `${PREFIX}:tx:${hexOf(tx.hash)}`;
    hashLocations.set(key, { block: Number(ARCHIVED[0]!.block.number), index: 0, generation: 1 });
    const { source, call } = await open(LAYOUT2);
    expect(await call("eth_getTransactionByHash", tx.hash)).toEqual(tx);
    expect(indexReads(source).length).toBeGreaterThan(0);
    expect(hashLocations.get(key)).toEqual({ block: Number(f.block.number), index: 0, generation: 1 });
  });

  test("a hash the live window answers is not cached; an archived one is, and then skips the window", async () => {
    const liveTx = txOf(WINDOW[0]!, 5);
    const liveBlock = WINDOW[1]!;
    const oldTx = txOf(ARCHIVED[0]!, 0);
    // A live transaction costs the window two calls: its block number, then the block.
    const liveCalls = [`tx:${liveTx.hash}`, `block:${Number(WINDOW[0]!.block.number)}`, `block:${liveBlock.block.hash}`];
    const first = fakeLive();
    const a = await open(LAYOUT2, first.api);
    expect(await a.call("eth_getTransactionByHash", liveTx.hash)).toEqual(liveTx);
    expect(((await a.call("eth_getBlockByHash", liveBlock.block.hash, false)) as { number: string }).number).toBe(liveBlock.block.number);
    expect(await a.call("eth_getTransactionByHash", oldTx.hash)).toEqual(oldTx);
    expect(first.calls).toEqual([...liveCalls, `tx:${oldTx.hash}`]);
    expect(hashLocations.size).toBe(1);
    expect(hashLocations.get(`${PREFIX}:tx:${hexOf(liveTx.hash)}`)).toBeUndefined();
    expect(hashLocations.get(`${PREFIX}:block:${hexOf(liveBlock.block.hash)}`)).toBeUndefined();

    // The next request asks the window again for the live hashes (a reorg may have moved them)
    // and not at all for the archived one.
    const second = fakeLive();
    const b = await open(LAYOUT2, second.api);
    expect(await b.call("eth_getTransactionByHash", liveTx.hash)).toEqual(liveTx);
    expect(((await b.call("eth_getBlockByHash", liveBlock.block.hash, false)) as { number: string }).number).toBe(liveBlock.block.number);
    expect(await b.call("eth_getTransactionByHash", oldTx.hash)).toEqual(oldTx);
    expect(second.calls).toEqual(liveCalls);
    expect(indexReads(b.source)).toHaveLength(0);
  });
});

describe("selective reads", () => {
  /** A request with meta.json warm, so only frame reads remain to count. */
  async function warm(objects: Map<string, Uint8Array>) {
    const r = await open(objects);
    await r.call("eth_getBlockByNumber", ARCHIVED[5]!.block.number, false);
    r.source.reads.length = 0;
    return r;
  }

  test("layout 2: blocks, headers and transactions read the block frame; receipts read both", async () => {
    const f = ARCHIVED[4]!;
    const tx = txOf(f, 1);
    const cases: [string, unknown[], unknown, string[]][] = [
      ["eth_getBlockByNumber", [f.block.number, true], f.block, ["blocks.pack"]],
      ["eth_getBlockByHash", [f.block.hash, true], f.block, ["blocks.pack"]],
      ["eth_getTransactionByHash", [tx.hash], tx, ["blocks.pack"]],
      ["eth_getTransactionByBlockNumberAndIndex", [f.block.number, "0x1"], tx, ["blocks.pack"]],
      ["eth_getTransactionByBlockHashAndIndex", [f.block.hash, "0x1"], tx, ["blocks.pack"]],
      ["debug_getRawHeader", [f.block.number], undefined, ["blocks.pack"]],
      ["debug_getRawBlock", [{ blockHash: f.block.hash }], undefined, ["blocks.pack"]],
      ["eth_getTransactionReceipt", [tx.hash], f.receipts[1], ["blocks.pack", "receipts.pack"]],
      ["eth_getBlockReceipts", [f.block.number], f.receipts, ["blocks.pack", "receipts.pack"]],
      ["eth_getBlockReceipts", [{ blockHash: f.block.hash }], f.receipts, ["blocks.pack", "receipts.pack"]],
      ["debug_getRawReceipts", [f.block.number], undefined, ["blocks.pack", "receipts.pack"]],
    ];
    for (const [method, params, want, packs] of cases) {
      const { source, call } = await warm(LAYOUT2);
      const got = await call(method, ...params);
      if (want !== undefined) expect(got, method).toEqual(want);
      else if (Array.isArray(got)) expect(got, method).toHaveLength(f.receipts.length);
      else expect(got, method).toMatch(/^0x/);
      expect(frameReads(source), method).toEqual(packs);
    }
  });

  test("layout 2: a request that reads the block, then its receipts, reads each frame once", async () => {
    const n = Number(ARCHIVED[4]!.block.number);
    const { chain, source } = await warm(LAYOUT2);
    const part = await chain.part(n);
    expect(part!.block.txs.length).toBe(ARCHIVED[4]!.block.transactions.length);
    expect(frameReads(source)).toEqual(["blocks.pack"]);
    const rec = await chain.block(n);
    expect(rec!.receipts.length).toBe(ARCHIVED[4]!.receipts.length);
    expect(frameReads(source)).toEqual(["blocks.pack", "blocks.pack", "receipts.pack"]);
    // The record now stands in for the part.
    expect(await chain.part(n)).toBe(rec);
    expect(frameReads(source)).toHaveLength(3);
  });

  test("layout 1 is unchanged: every method reads the one record frame, and a part is the record", async () => {
    const f = ARCHIVED[4]!;
    const tx = txOf(f, 1);
    for (const [method, params] of [
      ["eth_getBlockByHash", [f.block.hash, true]],
      ["eth_getTransactionByHash", [tx.hash]],
      ["eth_getTransactionReceipt", [tx.hash]],
      ["eth_getBlockReceipts", [f.block.number]],
    ] as [string, unknown[]][]) {
      const { source, call } = await warm(LAYOUT1);
      expect(await call(method, ...params)).toBeTruthy();
      expect(frameReads(source), method).toEqual(["blocks.pack"]);
    }
    const { chain, source } = await warm(LAYOUT1);
    const part = await chain.part(Number(f.block.number));
    expect("receipts" in part!).toBe(true);
    expect(await chain.block(Number(f.block.number))).toBe(part);
    expect(frameReads(source)).toEqual(["blocks.pack"]);
  });

  test("results by hash equal the fixtures in both layouts", async () => {
    for (const objects of [LAYOUT1, LAYOUT2]) {
      const { call } = await open(objects);
      for (const f of ARCHIVED.slice(0, 4)) {
        expect(await call("eth_getBlockByHash", f.block.hash, true)).toEqual(f.block);
        const tx = txOf(f, 0);
        expect(await call("eth_getTransactionByHash", tx.hash)).toEqual(tx);
        expect(await call("eth_getTransactionReceipt", tx.hash)).toEqual(f.receipts[0]);
      }
    }
  });
});
