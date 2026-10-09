import { beforeEach, describe, expect, test } from "vitest";
import { Archive } from "../src/archive/archive";
import { archiveCacheHeader, archiveCacheUrl, CachedSource } from "../src/archive/cached";
import { MemorySource } from "../src/archive/source";
import { ArchiveError } from "../src/archive/types";
import { Chain } from "../src/chain";
import worker from "../src/index";
import type { BlockId, LiveApi, LiveState } from "../src/live";
import { Live } from "../src/live";
import { METHODS } from "../src/methods";
import { headOf, memory, ResponseCache, responseCacheHeader, type CacheOutcome } from "../src/response-cache";
import { buildArchive, PREFIX } from "./archive";
import { FakeCache } from "./caches";
import { encodeRecord, fixtures, type Fixture } from "./encode";

const FIXTURES = fixtures();
const OBJECTS = buildArchive(FIXTURES);
// For the head tier: the archive ends at P = 20,000,001 and the live window holds the rest.
const ARCHIVED = FIXTURES.filter((f) => Number(f.block.number) <= 20_000_001);
const WINDOW = FIXTURES.filter((f) => Number(f.block.number) > 20_000_001);
const SPLIT = buildArchive(ARCHIVED);
const P = 20_000_001;
const ORIGIN = "https://eth.nullrpc.dev";
const hex = (n: number) => "0x" + n.toString(16);
const TIP = Number(FIXTURES.at(-1)!.block.number);

/** A cached source over the generated archive; `waits` collects the deferred fills. */
function cachedSource(cache: FakeCache | null) {
  const inner = new MemorySource(OBJECTS);
  const waits: Promise<unknown>[] = [];
  const source = new CachedSource(inner, cache as unknown as Cache | null, ORIGIN, (p) => waits.push(p));
  return { inner, source, settle: () => Promise.all(waits) };
}

describe("archive edge cache", () => {
  const key = [...OBJECTS.keys()].find((k) => k.endsWith("/blocks.pack"))!;
  const whole = [...OBJECTS.keys()].find((k) => k.endsWith("/meta.json"))!;

  test("a range is read from the bucket once, then from the cache", async () => {
    const cache = new FakeCache();
    const { inner, source, settle } = cachedSource(cache);
    const expected = OBJECTS.get(key)!.slice(10, 30);
    expect(await source.range(key, 10, 20)).toEqual(expected);
    expect(source.counter).toEqual({ hit: 0, miss: 1 });
    expect(inner.reads).toHaveLength(1);
    expect(cache.keys).toEqual([]); // the fill is deferred
    await settle();
    expect(cache.keys).toEqual([archiveCacheUrl(ORIGIN, key, 10, 20)]);
    expect(await source.range(key, 10, 20)).toEqual(expected);
    expect(source.counter).toEqual({ hit: 1, miss: 1 });
    expect(inner.reads).toHaveLength(1);
    // Another range of the same object is another entry.
    expect(await source.range(key, 0, 20)).toEqual(OBJECTS.get(key)!.slice(0, 20));
    expect(source.counter).toEqual({ hit: 1, miss: 2 });
    expect(archiveCacheHeader(source.counter)).toBe("hit=1 miss=2");
  });

  test("whole objects are cached; a missing object is not", async () => {
    const cache = new FakeCache();
    const { inner, source, settle } = cachedSource(cache);
    expect(await source.get(whole)).toEqual(OBJECTS.get(whole));
    await settle();
    expect(cache.keys).toEqual([archiveCacheUrl(ORIGIN, whole)]);
    expect(await source.get(whole)).toEqual(OBJECTS.get(whole));
    expect(inner.reads).toHaveLength(1);
    expect(await source.get(`${PREFIX}/nope.json`)).toBeNull();
    await settle();
    expect(cache.keys).toHaveLength(1);
    expect(source.counter).toEqual({ hit: 1, miss: 2 });
  });

  test("HEAD.json never touches the cache and is not counted", async () => {
    const cache = new FakeCache();
    const { inner, source, settle } = cachedSource(cache);
    const head = `${PREFIX}/HEAD.json`;
    expect(await source.get(head)).toEqual(OBJECTS.get(head));
    expect(await source.get(head)).toEqual(OBJECTS.get(head));
    await settle();
    expect(cache.keys).toEqual([]);
    expect(inner.reads).toHaveLength(2);
    expect(source.counter).toEqual({ hit: 0, miss: 0 });
  });

  test("a damaged entry is a miss and is refilled", async () => {
    const cache = new FakeCache();
    const { source, settle } = cachedSource(cache);
    const url = archiveCacheUrl(ORIGIN, key, 10, 20);
    await cache.put(url, new Response(new Uint8Array(3) as BodyInit));
    expect(await source.range(key, 10, 20)).toEqual(OBJECTS.get(key)!.slice(10, 30));
    expect(source.counter).toEqual({ hit: 0, miss: 1 });
    await settle();
    expect(cache.entries.get(url)!.bytes).toHaveLength(20);
    expect(cache.puts).toBe(2);
  });

  test("without a cache every read goes through and nothing is counted", async () => {
    const { inner, source } = cachedSource(null);
    await source.range(key, 0, 8);
    await source.get(whole);
    expect(inner.reads).toHaveLength(2);
    expect(source.counter).toEqual({ hit: 0, miss: 0 });
    await expect(source.range(`${PREFIX}/nope`, 0, 1)).rejects.toBeInstanceOf(ArchiveError);
  });

  test("entries carry a day-long public max-age under the synthetic URL", async () => {
    const cache = new FakeCache();
    const { source, settle } = cachedSource(cache);
    await source.range(key, 0, 4);
    await settle();
    const e = cache.entries.get(archiveCacheUrl(ORIGIN, key, 0, 4))!;
    expect(Object.fromEntries(e.headers)["cache-control"]).toBe("public, max-age=86400");
    expect(archiveCacheUrl(ORIGIN, key, 0, 4)).toBe(`${ORIGIN}/_cache/archive/v1/${key}?o=0&l=4`);
  });
});

const id = (f: Fixture): BlockId => ({ number: Number(f.block.number), hash: f.block.hash });

/** A fake LiveReads over WINDOW whose head can move between requests and can report a reorg. */
function fakeLive(opts: { head?: Fixture; staleOnce?: boolean; afterStale?: Fixture } = {}) {
  let stale = opts.staleOnce ?? false;
  let head = id(opts.head ?? WINDOW.at(-1)!);
  const state = (): LiveState => ({ head, safe: head, finalized: id(WINDOW[0]!), promoted: id(ARCHIVED.at(-1)!), generation: 1, shards: 16 });
  const api: LiveApi = {
    async state() {
      return state();
    },
    async block(key, pin) {
      if (stale) {
        stale = false;
        if (opts.afterStale) head = id(opts.afterStale);
        return { stale: true };
      }
      const f = WINDOW.find((w) => (typeof key === "number" ? Number(w.block.number) === key : w.block.hash === key.toLowerCase()));
      if (!f || Number(f.block.number) > pin.number) return null;
      return { stale: false, number: Number(f.block.number), hash: f.block.hash, record: Buffer.from(encodeRecord(f)).toString("hex") };
    },
    async witness() {
      return null;
    },
    async txBlock(hash, pin) {
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
  return { api, move: (f: Fixture) => (head = id(f)) };
}

describe("response cache", () => {
  let cache: FakeCache;
  let waits: Promise<unknown>[];
  let clock: number;
  let responses: ResponseCache;
  beforeEach(() => {
    memory.clear();
    cache = new FakeCache();
    waits = [];
    clock = 1_700_000_000_000;
    responses = new ResponseCache(cache as unknown as Cache, ORIGIN, 1, (p) => waits.push(p), () => clock);
  });
  const settle = () => Promise.all(waits);

  // The isolate's HEAD pin is keyed by prefix and expires by "now": each open pins with a later
  // "now" than the last and all of them lie well in the past, so no test (here or in the worker
  // tests below, which pin at the real time) inherits another's archive.
  let clockPin = Date.now() - 1e9;
  /** The archive alone (latest = P), or with a live window above it. */
  async function open(live?: LiveApi): Promise<Chain> {
    const archive = new Archive(new MemorySource(live ? SPLIT : OBJECTS), PREFIX);
    return Chain.open(archive, live ? new Live(live) : null, (clockPin += 60_000));
  }

  /** Serves `method(params)`; `handler` defaults to the real method and counts its calls. */
  async function serve(chain: Chain, method: string, params: unknown[], handler?: () => Promise<unknown>) {
    let calls = 0;
    const run = handler ?? (() => METHODS[method]!(chain, params, { chainId: 1 }));
    const out = await responses.serve(chain, method, params, () => {
      calls++;
      return run();
    });
    await settle();
    return { ...out, calls };
  }
  const stub = async () => "x";
  const immutableKeys = () => cache.keys.filter((k) => k.includes("/i/"));
  const headKeys = () => cache.keys.filter((k) => k.includes("/h/"));

  describe("immutable tier", () => {
    test("a block at or below P is served fresh once, then from the isolate, then from the edge", async () => {
      const chain = await open();
      const f = FIXTURES[3]!;
      const first = await serve(chain, "eth_getBlockByNumber", [f.block.number, true]);
      expect(first).toMatchObject({ outcome: { status: "miss", tier: "immutable" }, calls: 1, result: f.block });
      expect(immutableKeys()).toHaveLength(1);
      expect(await serve(chain, "eth_getBlockByNumber", [f.block.number, true])).toEqual({ result: f.block, outcome: { status: "hit", tier: "immutable" }, calls: 0 });
      memory.clear();
      expect((await serve(chain, "eth_getBlockByNumber", [f.block.number, true])).outcome).toEqual({ status: "hit", tier: "immutable" });
      expect(memory.size).toBe(1); // an edge hit refills the isolate
      // Leading zeros and case do not make a different key; a different `full` flag does.
      expect((await serve(chain, "eth_getBlockByNumber", ["0x000" + f.block.number.slice(2).toUpperCase(), true])).outcome.status).toBe("hit");
      expect((await serve(chain, "eth_getBlockByNumber", [f.block.number, false])).outcome.status).toBe("miss");
    });

    test("tags resolve to numbers: without a live window, latest is the archive tip and immutable", async () => {
      const chain = await open();
      expect((await serve(chain, "eth_getBlockByNumber", ["latest", false], stub)).outcome).toEqual({ status: "miss", tier: "immutable" });
      for (const ref of ["pending", "safe", "finalized", undefined, hex(TIP)]) {
        expect((await serve(chain, "eth_getBlockByNumber", [ref, false], stub)).outcome).toEqual({ status: "hit", tier: "immutable" });
      }
      expect((await serve(chain, "eth_getBlockByNumber", ["earliest", false], stub)).outcome).toEqual({ status: "miss", tier: "immutable" });
      expect((await serve(chain, "eth_getBlockByNumber", [{ blockNumber: hex(TIP) }, false], stub)).outcome.status).toBe("hit");
      expect((await serve(chain, "eth_getBalance", ["0x" + "11".repeat(20), "latest"], stub)).outcome).toEqual({ status: "miss", tier: "immutable" });
      expect((await serve(chain, "eth_getBalance", ["0x" + "11".repeat(20), hex(TIP)], stub)).outcome.status).toBe("hit");
      expect((await serve(chain, "eth_getStorageAt", ["0x" + "11".repeat(20), "0x1", hex(TIP)], stub)).outcome.status).toBe("miss");
      expect((await serve(chain, "eth_getStorageAt", ["0x" + "11".repeat(20), "0x" + "0".repeat(63) + "1", hex(TIP)], stub)).outcome.status).toBe("hit");
    });

    test("blocks above the head, below the first block, hash objects and malformed params bypass", async () => {
      const chain = await open();
      for (const ref of [hex(TIP + 1), hex(chain.pin.manifest.first_block - 1), { blockHash: "0x" + "ab".repeat(32) }, "0xzz"]) {
        expect((await serve(chain, "eth_getBlockByNumber", [ref, false], stub)).outcome).toEqual({ status: "bypass" });
      }
      expect((await serve(chain, "eth_getBlockByNumber", [hex(TIP), "yes"], stub)).outcome).toEqual({ status: "bypass" });
      expect(cache.keys).toEqual([]);
    });

    test("methods that depend on the caller or carry no block are never cached; errors are not stored", async () => {
      const chain = await open();
      for (const method of ["eth_chainId", "eth_sendRawTransaction", "net_version", "debug_codeByHash", "eth_createAccessList", "debug_traceCall", "eth_blobBaseFee"]) {
        expect((await serve(chain, method, [hex(TIP)], stub)).outcome).toEqual({ status: "bypass" });
      }
      await expect(serve(chain, "eth_getBlockByNumber", [hex(TIP)], async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
      expect(cache.keys).toEqual([]);
      expect(memory.size).toBe(0);
    });

    test("lookups by hash are stored once the answer places them at or below P", async () => {
      const chain = await open();
      const f = FIXTURES[2]!;
      const tx = f.block.transactions[0] as { hash: string };
      expect((await serve(chain, "eth_getBlockByHash", [f.block.hash, false])).outcome).toEqual({ status: "miss", tier: "immutable" });
      expect((await serve(chain, "eth_getBlockByHash", [f.block.hash.toUpperCase().replace("0X", "0x"), false])).outcome).toEqual({ status: "hit", tier: "immutable" });
      expect((await serve(chain, "eth_getTransactionByHash", [tx.hash])).outcome.status).toBe("miss");
      expect((await serve(chain, "eth_getTransactionByHash", [tx.hash])).outcome).toEqual({ status: "hit", tier: "immutable" });
      expect((await serve(chain, "eth_getTransactionReceipt", [tx.hash])).result).toEqual(f.receipts[0]);
      expect((await serve(chain, "eth_getTransactionReceipt", [tx.hash])).outcome.status).toBe("hit");
      // Unknown hashes answer null and stay uncached: the transaction may appear later.
      const unknown = "0x" + "77".repeat(32);
      expect(await serve(chain, "eth_getTransactionByHash", [unknown])).toMatchObject({ result: null, outcome: { status: "miss" } });
      expect((await serve(chain, "eth_getTransactionByHash", [unknown])).outcome).toEqual({ status: "miss" });
      expect(cache.keys).toHaveLength(3);
    });

    test("eth_getLogs: numeric ranges below P share a key across equivalent filters", async () => {
      const chain = await open();
      const n = Number(FIXTURES[1]!.block.number);
      const addr = "0x" + "AB".repeat(20);
      const topic = "0x" + "cd".repeat(32);
      const empty = async () => [];
      const a = await serve(chain, "eth_getLogs", [{ fromBlock: hex(n), toBlock: hex(n), address: addr, topics: [topic, null] }], empty);
      expect(a.outcome).toEqual({ status: "miss", tier: "immutable" });
      const b = await serve(chain, "eth_getLogs", [{ fromBlock: hex(n), toBlock: hex(n), address: [addr.toLowerCase()], topics: [[topic]] }], empty);
      expect(b.outcome.status).toBe("hit");
      expect((await serve(chain, "eth_getLogs", [{ blockHash: FIXTURES[1]!.block.hash }], empty)).outcome).toEqual({ status: "bypass" });
      const real = await serve(chain, "eth_getLogs", [{ fromBlock: hex(n), toBlock: hex(n) }]);
      expect(real.outcome.status).toBe("miss");
      expect((await serve(chain, "eth_getLogs", [{ fromBlock: hex(n), toBlock: hex(n) }])).result).toEqual(real.result);
    });

    test("eth_call at an archived block and eth_feeHistory whose successor is archived are immutable", async () => {
      const chain = await open();
      const call = { to: "0x" + "AB".repeat(20), data: "0x70A08231" };
      expect((await serve(chain, "eth_call", [call, hex(TIP - 1)], stub)).outcome).toEqual({ status: "miss", tier: "immutable" });
      expect((await serve(chain, "eth_call", [{ data: "0x70a08231", to: "0x" + "ab".repeat(20) }, hex(TIP - 1)], stub)).outcome).toEqual({ status: "hit", tier: "immutable" });
      expect((await serve(chain, "eth_call", [call, hex(TIP - 1), { ["0x" + "ab".repeat(20)]: { balance: "0x1" } }], stub)).outcome).toEqual({ status: "bypass" });
      expect((await serve(chain, "eth_feeHistory", ["0x2", hex(TIP - 1), [25, 75]], stub)).outcome).toEqual({ status: "miss", tier: "immutable" });
      expect((await serve(chain, "eth_feeHistory", [2, hex(TIP - 1), [25, 75]], stub)).outcome).toEqual({ status: "hit", tier: "immutable" });
    });
  });

  describe("head tier", () => {
    test("latest above P is keyed by the pinned head and misses once the head moves", async () => {
      const { api, move } = fakeLive({ head: WINDOW[0]! });
      let chain = await open(api);
      const head = headOf(chain);
      expect(head).toEqual(id(WINDOW[0]!));
      const first = await serve(chain, "eth_getBlockByNumber", ["latest", false]);
      expect(first.outcome).toEqual({ status: "miss", tier: "head" });
      expect((first.result as { hash: string }).hash).toBe(WINDOW[0]!.block.hash);
      expect(headKeys()).toHaveLength(1);
      expect(headKeys()[0]).toContain(`/h/${head.number}-${head.hash}/eth_getBlockByNumber/`);
      expect((await serve(chain, "eth_getBlockByNumber", ["latest", false])).outcome).toEqual({ status: "hit", tier: "head" });
      // The same block by number is the same entry.
      expect((await serve(chain, "eth_getBlockByNumber", [WINDOW[0]!.block.number, false])).outcome).toEqual({ status: "hit", tier: "head" });
      memory.clear();
      expect((await serve(chain, "eth_getBlockByNumber", ["latest", false])).outcome).toEqual({ status: "hit", tier: "head" });
      // The head moves: a new request pins it and misses; the old entry is untouched.
      move(WINDOW[1]!);
      chain = await open(api);
      const next = await serve(chain, "eth_getBlockByNumber", ["latest", false]);
      expect(next.outcome).toEqual({ status: "miss", tier: "head" });
      expect((next.result as { hash: string }).hash).toBe(WINDOW[1]!.block.hash);
      expect(headKeys()).toHaveLength(2);
      // A recent number below the new head is a head entry too; the archive tip stays immutable.
      expect((await serve(chain, "eth_getBlockByNumber", [WINDOW[0]!.block.number, false])).outcome).toEqual({ status: "miss", tier: "head" });
      expect((await serve(chain, "eth_getBlockByNumber", [hex(P), false])).outcome).toEqual({ status: "miss", tier: "immutable" });
    });

    test("the head-only methods, fee history, state at latest and eth_call at latest", async () => {
      const { api } = fakeLive();
      const chain = await open(api);
      const latest = chain.pointers().latest;
      expect(await serve(chain, "eth_blockNumber", [])).toMatchObject({ result: hex(latest), outcome: { status: "miss", tier: "head" } });
      expect(await serve(chain, "eth_blockNumber", [])).toMatchObject({ result: hex(latest), outcome: { status: "hit", tier: "head" }, calls: 0 });
      for (const method of ["eth_gasPrice", "eth_maxPriorityFeePerGas"]) {
        expect((await serve(chain, method, [], stub)).outcome).toEqual({ status: "miss", tier: "head" });
        expect((await serve(chain, method, [], stub)).outcome).toEqual({ status: "hit", tier: "head" });
        expect((await serve(chain, method, ["0x1"], stub)).outcome).toEqual({ status: "bypass" });
      }
      expect((await serve(chain, "eth_feeHistory", ["0x5", "latest", [10, 50, 90]], stub)).outcome).toEqual({ status: "miss", tier: "head" });
      expect((await serve(chain, "eth_feeHistory", [5, hex(latest), [10, 50, 90]], stub)).outcome).toEqual({ status: "hit", tier: "head" });
      // newest = P reads P + 1 (live) for the next base fee: head tier.
      expect((await serve(chain, "eth_feeHistory", ["0x1", hex(P), []], stub)).outcome).toEqual({ status: "miss", tier: "head" });
      expect((await serve(chain, "eth_feeHistory", ["0x1", hex(P - 1), []], stub)).outcome).toEqual({ status: "miss", tier: "immutable" });
      expect((await serve(chain, "eth_feeHistory", ["0x5", "latest", "x"], stub)).outcome).toEqual({ status: "bypass" });
      const me = "0x" + "11".repeat(20);
      expect((await serve(chain, "eth_getBalance", [me, "latest"], stub)).outcome).toEqual({ status: "miss", tier: "head" });
      expect((await serve(chain, "eth_getTransactionCount", [me, "pending"], stub)).outcome).toEqual({ status: "miss", tier: "head" });
      expect((await serve(chain, "eth_getTransactionCount", [me, "latest"], stub)).outcome).toEqual({ status: "hit", tier: "head" });
      const call = { from: me, to: me, value: "0x1" };
      expect((await serve(chain, "eth_estimateGas", [call, "latest"], stub)).outcome).toEqual({ status: "miss", tier: "head" });
      expect((await serve(chain, "eth_estimateGas", [{ value: "0x1", to: me, from: me.toUpperCase().replace("0X", "0x") }], stub)).outcome).toEqual({ status: "hit", tier: "head" });
      expect((await serve(chain, "eth_call", [call, "latest"], stub)).outcome).toEqual({ status: "miss", tier: "head" });
      expect((await serve(chain, "eth_call", [call], stub)).outcome).toEqual({ status: "hit", tier: "head" });
      expect((await serve(chain, "eth_call", ["0x", "latest"], stub)).outcome).toEqual({ status: "bypass" });
    });

    test("eth_getLogs ending above P and lookups by hash that land in the window are head entries", async () => {
      const { api } = fakeLive();
      const chain = await open(api);
      const latest = chain.pointers().latest;
      const empty = async () => [];
      expect((await serve(chain, "eth_getLogs", [{ fromBlock: hex(latest - 1000), toBlock: "latest" }], empty)).outcome).toEqual({ status: "miss", tier: "head" });
      expect((await serve(chain, "eth_getLogs", [{ fromBlock: hex(latest - 1000), toBlock: hex(latest + 50) }], empty)).outcome).toEqual({ status: "hit", tier: "head" });
      expect((await serve(chain, "eth_getLogs", [{ fromBlock: hex(latest + 1), toBlock: "latest" }], empty)).outcome).toEqual({ status: "bypass" });
      const liveTx = WINDOW[0]!.block.transactions[5] as { hash: string };
      expect((await serve(chain, "eth_getTransactionByHash", [liveTx.hash])).outcome).toEqual({ status: "miss", tier: "head" });
      expect(await serve(chain, "eth_getTransactionByHash", [liveTx.hash])).toMatchObject({ result: liveTx, outcome: { status: "hit", tier: "head" } });
      expect((await serve(chain, "eth_getTransactionReceipt", [liveTx.hash])).outcome).toEqual({ status: "miss", tier: "head" });
      expect((await serve(chain, "eth_getBlockByHash", [WINDOW[1]!.block.hash, false])).outcome).toEqual({ status: "miss", tier: "head" });
      const oldTx = ARCHIVED[0]!.block.transactions[0] as { hash: string };
      expect((await serve(chain, "eth_getTransactionByHash", [oldTx.hash])).outcome).toEqual({ status: "miss", tier: "immutable" });
      expect(headKeys()).toHaveLength(4);
      expect(immutableKeys()).toHaveLength(1);
    });

    test("an answer computed across a reorg that moved the head is not stored", async () => {
      const { api } = fakeLive({ head: WINDOW[0]!, staleOnce: true, afterStale: WINDOW[1]! });
      const chain = await open(api);
      const out = await serve(chain, "eth_getBlockByNumber", ["latest", false]);
      // "latest" was resolved before the reorg; the block is read again under the new head.
      expect(out.outcome).toEqual({ status: "miss" });
      expect((out.result as { hash: string }).hash).toBe(WINDOW[0]!.block.hash);
      expect(headOf(chain)).toEqual(id(WINDOW[1]!));
      expect(cache.keys).toEqual([]);
      expect(memory.size).toBe(0);
    });

    test("head entries expire from the isolate after 60 s; the edge entry carries a 60 s max-age", async () => {
      const { api } = fakeLive();
      const chain = await open(api);
      await serve(chain, "eth_gasPrice", [], stub);
      expect(Object.fromEntries(cache.entries.get(headKeys()[0]!)!.headers)["cache-control"]).toBe("public, max-age=60");
      clock += 59_000;
      expect((await serve(chain, "eth_gasPrice", [], stub)).outcome).toEqual({ status: "hit", tier: "head" });
      clock += 2_000;
      expect(memory.size).toBe(1);
      // Expired in the isolate, gone from the edge: computed again.
      cache.entries.clear();
      expect((await serve(chain, "eth_gasPrice", [], stub)).outcome).toEqual({ status: "miss", tier: "head" });
      expect(memory.size).toBe(1);
    });

    test("the isolate keeps at most 8 MiB and skips answers above 128 KiB; the edge takes them all", async () => {
      const { api } = fakeLive();
      const chain = await open(api);
      const big = "0x" + "ab".repeat(100 * 1024);
      expect((await serve(chain, "eth_call", [{ to: "0x" + "11".repeat(20) }, "latest"], async () => big)).outcome).toEqual({ status: "miss", tier: "head" });
      expect(memory.size).toBe(0);
      expect(headKeys()).toHaveLength(1);
      expect((await serve(chain, "eth_call", [{ to: "0x" + "11".repeat(20) }, "latest"], async () => big)).outcome).toEqual({ status: "hit", tier: "head" });
      const medium = "0x" + "ab".repeat(50 * 1024);
      for (let i = 0; i < 100; i++) await serve(chain, "eth_call", [{ to: "0x" + "11".repeat(20), data: hex(i) }, "latest"], async () => medium);
      expect(memory.used).toBeLessThanOrEqual(8 * 1024 * 1024);
      expect(memory.size).toBeLessThan(100);
      expect(memory.size).toBeGreaterThan(70);
    });
  });

  test("without a cache everything is a bypass", async () => {
    const chain = await open();
    const off = new ResponseCache(null, ORIGIN, 1, () => {});
    let calls = 0;
    const out = await off.serve(chain, "eth_getBlockByNumber", [hex(TIP), false], async () => ++calls);
    expect(out).toEqual({ result: 1, outcome: { status: "bypass" } });
  });

  test("the header names the tier for a single request and counts tiers for a batch", () => {
    expect(responseCacheHeader([{ status: "hit", tier: "head" }], false)).toBe("hit head");
    expect(responseCacheHeader([{ status: "miss", tier: "immutable" }], false)).toBe("miss immutable");
    expect(responseCacheHeader([{ status: "miss" }], false)).toBe("miss");
    expect(responseCacheHeader([], false)).toBe("bypass");
    const s: CacheOutcome[] = [{ status: "hit", tier: "immutable" }, { status: "miss", tier: "head" }, { status: "bypass" }, { status: "hit", tier: "head" }];
    expect(responseCacheHeader(s, true)).toBe("hit=2 miss=1 bypass=1 immutable=1 head=2");
  });
});

describe("worker headers", () => {
  function fakeBucket(objects: Map<string, Uint8Array>): R2Bucket {
    return {
      async get(key: string, opts?: { range?: { offset: number; length: number } }) {
        const o = objects.get(key);
        if (!o) return null;
        const b = opts?.range ? o.slice(opts.range.offset, opts.range.offset + opts.range.length) : o;
        return { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
      },
    } as unknown as R2Bucket;
  }
  const env = { ARCHIVE: fakeBucket(OBJECTS), ARCHIVE_PREFIX: PREFIX, CHAIN_ID: "1" };
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const post = async (body: unknown) => {
    const res = await worker.fetch(new Request(`${ORIGIN}/`, { method: "POST", body: JSON.stringify(body) }), env, ctx);
    await Promise.all(waits.splice(0));
    return { body: (await res.json()) as any, archive: res.headers.get("x-nullrpc-archive-cache")!, response: res.headers.get("x-nullrpc-response-cache")! };
  };
  const counts = (h: string) => Object.fromEntries(h.split(" ").map((kv) => kv.split("=")).map(([k, v]) => [k, Number(v)]));

  test("both caches report per request; HEAD.json is never stored", async () => {
    memory.clear();
    const cache = new FakeCache();
    await cache.install(async () => {
      const f = FIXTURES[4]!;
      // Cold: the manifest, the segment meta, the offsets page and the frame all miss.
      const cold = await post({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [f.block.number, false] });
      expect(cold.response).toBe("miss immutable");
      expect(counts(cold.archive)).toMatchObject({ hit: 0 });
      expect(counts(cold.archive).miss).toBeGreaterThan(0);
      expect(cold.body.result.hash).toBe(f.block.hash);
      // Warm: the answer itself is cached, so the archive is not read beyond the pin.
      const warm = await post({ jsonrpc: "2.0", id: 2, method: "eth_getBlockByNumber", params: [f.block.number, false] });
      expect(warm.response).toBe("hit immutable");
      expect(warm.body.result).toEqual(cold.body.result);
      // Without a live window "latest" is the archive tip, an immutable entry.
      expect((await post({ jsonrpc: "2.0", id: 3, method: "eth_getBlockByNumber", params: ["latest", false] })).response).toBe("miss immutable");
      // A method outside the response cache shows the archive cache working on its reads.
      const g = FIXTURES[5]!;
      const by1 = await post({ jsonrpc: "2.0", id: 4, method: "eth_getUncleCountByBlockHash", params: [g.block.hash] });
      const by2 = await post({ jsonrpc: "2.0", id: 5, method: "eth_getUncleCountByBlockHash", params: [g.block.hash] });
      expect(by1.response).toBe("bypass");
      expect(by2.response).toBe("bypass");
      expect(counts(by1.archive).miss).toBeGreaterThan(0);
      expect(counts(by2.archive).miss).toBe(0);
      expect(counts(by2.archive).hit).toBeGreaterThan(0);
      // A batch reports counts; invalid items and unknown methods are bypasses.
      const batch = await post([
        { jsonrpc: "2.0", id: "a", method: "eth_getBlockByNumber", params: [f.block.number, false] },
        { jsonrpc: "2.0", id: "b", method: "eth_getBlockByNumber", params: [g.block.number, false] },
        { jsonrpc: "2.0", id: "c", method: "eth_nope" },
        { id: 3 },
      ]);
      expect(batch.response).toBe("hit=1 miss=1 bypass=2 immutable=2 head=0");
      expect(batch.body[1].result.hash).toBe(g.block.hash);
      expect(cache.keys.some((k) => k.includes("HEAD.json"))).toBe(false);
      expect(cache.keys.filter((k) => k.includes("/_cache/rpc/")).length).toBe(3);
    });
  });

  test("without caches.default the headers still appear", async () => {
    const out = await post({ jsonrpc: "2.0", id: 1, method: "eth_chainId" });
    expect(out.archive).toBe("hit=0 miss=0");
    expect(out.response).toBe("bypass");
  });
});
