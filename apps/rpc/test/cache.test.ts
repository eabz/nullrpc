import { beforeEach, describe, expect, test } from "vitest";
import { Archive } from "../src/archive/archive";
import { archiveCacheHeader, archiveCacheUrl, CachedSource } from "../src/archive/cached";
import { MemorySource } from "../src/archive/source";
import { ArchiveError } from "../src/archive/types";
import { Chain } from "../src/chain";
import worker from "../src/index";
import { METHODS } from "../src/methods";
import { ResponseCache, responseCacheHeader, type CacheStatus } from "../src/response-cache";
import { buildArchive, PREFIX } from "./archive";
import { FakeCache } from "./caches";
import { fixtures } from "./encode";

const FIXTURES = fixtures();
const OBJECTS = buildArchive(FIXTURES);
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

describe("response cache", () => {
  let chain: Chain;
  let cache: FakeCache;
  let responses: ResponseCache;
  let waits: Promise<unknown>[];
  beforeEach(async () => {
    const archive = new Archive(new MemorySource(OBJECTS), PREFIX);
    chain = await Chain.open(archive, null, Date.now() + Math.random() * 1e9);
    cache = new FakeCache();
    waits = [];
    responses = new ResponseCache(cache as unknown as Cache, ORIGIN, 1, (p) => waits.push(p));
  });
  const settle = () => Promise.all(waits);

  /** Serves `method(params)`; `handler` defaults to the real method and counts its calls. */
  async function serve(method: string, params: unknown[], handler?: () => Promise<unknown>) {
    let calls = 0;
    const run = handler ?? (() => METHODS[method]!(chain, params, { chainId: 1 }));
    const out = await responses.serve(chain, method, params, () => {
      calls++;
      return run();
    });
    await settle();
    return { ...out, calls };
  }

  test("a block at or below P is served fresh once, then from the cache", async () => {
    const f = FIXTURES[3]!;
    const first = await serve("eth_getBlockByNumber", [f.block.number, true]);
    expect(first.status).toBe("miss");
    expect(first.calls).toBe(1);
    expect(first.result).toEqual(f.block);
    expect(cache.keys).toHaveLength(1);
    const again = await serve("eth_getBlockByNumber", [f.block.number, true]);
    expect(again).toEqual({ result: f.block, status: "hit", calls: 0 });
    // Leading zeros and case do not make a different key; a different `full` flag does.
    const padded = await serve("eth_getBlockByNumber", ["0x000" + f.block.number.slice(2).toUpperCase(), true]);
    expect(padded.status).toBe("hit");
    expect((await serve("eth_getBlockByNumber", [f.block.number, false])).status).toBe("miss");
  });

  test("tags, blocks above P and blocks below the archive's first are not cached", async () => {
    const stub = async () => "x";
    for (const ref of ["latest", "pending", "safe", "finalized", undefined, hex(TIP + 1), hex(chain.pin.manifest.first_block - 1), { blockHash: "0x" + "ab".repeat(32) }]) {
      expect((await serve("eth_getBlockByNumber", [ref, false], stub)).status).toBe("bypass");
    }
    expect((await serve("eth_getBlockByNumber", ["earliest", false], stub)).status).toBe("miss");
    expect((await serve("eth_getBlockByNumber", [{ blockNumber: hex(TIP) }, false], stub)).status).toBe("miss");
    expect((await serve("eth_getBalance", ["0x" + "11".repeat(20), "latest"], stub)).status).toBe("bypass");
    expect((await serve("eth_getBalance", ["0x" + "11".repeat(20), hex(TIP)], stub)).status).toBe("miss");
    expect((await serve("eth_getBalance", ["0x" + "11".repeat(20), hex(TIP)], stub)).status).toBe("hit");
    expect((await serve("eth_getStorageAt", ["0x" + "11".repeat(20), "0x1", hex(TIP)], stub)).status).toBe("miss");
    expect((await serve("eth_getStorageAt", ["0x" + "11".repeat(20), "0x" + "0".repeat(63) + "1", hex(TIP)], stub)).status).toBe("hit");
    expect(cache.keys).toHaveLength(4);
  });

  test("methods that read the head or execute are never cached", async () => {
    const stub = async () => "x";
    for (const method of ["eth_blockNumber", "eth_chainId", "eth_call", "eth_feeHistory", "eth_gasPrice", "debug_codeByHash"]) {
      expect((await serve(method, [hex(TIP)], stub)).status).toBe("bypass");
    }
    expect(cache.keys).toEqual([]);
  });

  test("errors and malformed parameters are not cached", async () => {
    await expect(serve("eth_getBlockByNumber", [hex(TIP)], async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect((await serve("eth_getBlockByNumber", ["0xzz", false], async () => "x")).status).toBe("bypass");
    expect((await serve("eth_getBlockByNumber", [hex(TIP), "yes"], async () => "x")).status).toBe("bypass");
    expect(cache.keys).toEqual([]);
  });

  test("lookups by hash are stored once the answer places them at or below P", async () => {
    const f = FIXTURES[2]!;
    const tx = f.block.transactions[0] as { hash: string };
    expect((await serve("eth_getBlockByHash", [f.block.hash, false])).status).toBe("miss");
    expect((await serve("eth_getBlockByHash", [f.block.hash.toUpperCase().replace("0X", "0x"), false])).status).toBe("hit");
    expect((await serve("eth_getTransactionByHash", [tx.hash])).status).toBe("miss");
    expect((await serve("eth_getTransactionByHash", [tx.hash])).status).toBe("hit");
    expect((await serve("eth_getTransactionReceipt", [tx.hash])).status).toBe("miss");
    expect((await serve("eth_getTransactionReceipt", [tx.hash])).result).toEqual(f.receipts[0]);
    expect((await serve("eth_getTransactionReceipt", [tx.hash])).status).toBe("hit");
    // Unknown hashes answer null and stay uncached: the transaction may appear later.
    const unknown = "0x" + "77".repeat(32);
    expect(await serve("eth_getTransactionByHash", [unknown])).toMatchObject({ result: null, status: "miss" });
    expect((await serve("eth_getTransactionByHash", [unknown])).status).toBe("miss");
    // A result above P (a live block) is not stored.
    expect((await serve("eth_getBlockByHash", [unknown, false], async () => ({ number: hex(TIP + 1) }))).status).toBe("miss");
    expect((await serve("eth_getBlockByHash", [unknown, false], async () => ({ number: hex(TIP + 1) }))).status).toBe("miss");
    expect(cache.keys).toHaveLength(3);
  });

  test("eth_getLogs: numeric ranges below P share a key across equivalent filters", async () => {
    const n = Number(FIXTURES[1]!.block.number);
    const addr = "0x" + "AB".repeat(20);
    const topic = "0x" + "cd".repeat(32);
    const stub = async () => [];
    const a = await serve("eth_getLogs", [{ fromBlock: hex(n), toBlock: hex(n), address: addr, topics: [topic, null] }], stub);
    expect(a.status).toBe("miss");
    const b = await serve("eth_getLogs", [{ fromBlock: hex(n), toBlock: hex(n), address: [addr.toLowerCase()], topics: [[topic]] }], stub);
    expect(b.status).toBe("hit");
    for (const filter of [{ fromBlock: hex(n) }, { fromBlock: hex(n), toBlock: "latest" }, { fromBlock: hex(n), toBlock: hex(TIP + 1) }, { blockHash: FIXTURES[1]!.block.hash }]) {
      expect((await serve("eth_getLogs", [filter], stub)).status).toBe("bypass");
    }
    const real = await serve("eth_getLogs", [{ fromBlock: hex(n), toBlock: hex(n) }]);
    expect(real.status).toBe("miss");
    expect((await serve("eth_getLogs", [{ fromBlock: hex(n), toBlock: hex(n) }])).result).toEqual(real.result);
  });

  test("without a cache everything is a bypass", async () => {
    const off = new ResponseCache(null, ORIGIN, 1, () => {});
    let calls = 0;
    const out = await off.serve(chain, "eth_getBlockByNumber", [hex(TIP), false], async () => ++calls);
    expect(out).toEqual({ result: 1, status: "bypass" });
  });

  test("the header is one word for a single request and counts for a batch", () => {
    expect(responseCacheHeader(["hit"], false)).toBe("hit");
    expect(responseCacheHeader([], false)).toBe("bypass");
    const s: CacheStatus[] = ["hit", "miss", "bypass", "hit"];
    expect(responseCacheHeader(s, true)).toBe("hit=2 miss=1 bypass=1");
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
    const cache = new FakeCache();
    await cache.install(async () => {
      const f = FIXTURES[4]!;
      // Cold: the manifest, the segment meta, the offsets page and the frame all miss.
      const cold = await post({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: [f.block.number, false] });
      expect(cold.response).toBe("miss");
      expect(counts(cold.archive)).toMatchObject({ hit: 0 });
      expect(counts(cold.archive).miss).toBeGreaterThan(0);
      expect(cold.body.result.hash).toBe(f.block.hash);
      // Warm: the answer itself is cached, so the archive is not read beyond the pin.
      const warm = await post({ jsonrpc: "2.0", id: 2, method: "eth_getBlockByNumber", params: [f.block.number, false] });
      expect(warm.response).toBe("hit");
      expect(warm.body.result).toEqual(cold.body.result);
      // "latest" bypasses the response cache, so its frame read shows the archive cache working.
      const latest1 = await post({ jsonrpc: "2.0", id: 3, method: "eth_getBlockByNumber", params: ["latest", false] });
      const latest2 = await post({ jsonrpc: "2.0", id: 4, method: "eth_getBlockByNumber", params: ["latest", false] });
      expect(latest1.response).toBe("bypass");
      expect(latest2.response).toBe("bypass");
      expect(counts(latest1.archive).miss).toBeGreaterThan(0);
      // The segment meta and the offsets page now sit in the isolate; only the block's two
      // frames (layout 2: blocks.pack and receipts.pack) are re-read, from the cache.
      expect(counts(latest2.archive)).toEqual({ hit: 2, miss: 0 });
      // A batch reports counts; invalid items and unknown methods are bypasses.
      const batch = await post([
        { jsonrpc: "2.0", id: "a", method: "eth_getBlockByNumber", params: [f.block.number, false] },
        { jsonrpc: "2.0", id: "b", method: "eth_getBlockByNumber", params: [FIXTURES[5]!.block.number, false] },
        { jsonrpc: "2.0", id: "c", method: "eth_nope" },
        { id: 3 },
      ]);
      expect(batch.response).toBe("hit=1 miss=1 bypass=2");
      expect(batch.body[1].result.hash).toBe(FIXTURES[5]!.block.hash);
      expect(cache.keys.some((k) => k.includes("HEAD.json"))).toBe(false);
      expect(cache.keys.filter((k) => k.includes("/_cache/rpc/")).length).toBe(2);
    });
  });

  test("without caches.default the headers still appear", async () => {
    const out = await post({ jsonrpc: "2.0", id: 1, method: "eth_chainId" });
    expect(out.archive).toBe("hit=0 miss=0");
    expect(out.response).toBe("bypass");
  });
});
