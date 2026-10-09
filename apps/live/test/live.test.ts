import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { ChainDO } from "../src/chain";
import { DOMAIN, recordTimestamp, shardOf, unhex, type BlockId } from "../src/codec";
import worker, { LiveReads, LiveStatus } from "../src/index";
import { StateShard } from "../src/shard";
import { chainRow, FakeStorage, hashOf, record, shardRow, testEnv, txOf, wake, type Change } from "./fake";

const id = (n: number, fork = 0): BlockId => ({ number: n, hash: hashOf(n, fork) });
const env0 = { CHAIN_ID: "560048", SHARDS: "4" } as never;

/** Counts full scans of the rows table (index rebuilds). */
function countScans(storage: FakeStorage): () => number {
  let scans = 0;
  const exec = storage.sql.exec;
  storage.sql.exec = (q: string, ...args: unknown[]) => {
    if (/FROM rows\s+ORDER BY/.test(q)) scans++;
    return exec(q, ...args);
  };
  return () => scans;
}

afterEach(() => setSystemTime());

test("recordTimestamp reads the header's timestamp", () => {
  expect(recordTimestamp(record(560_000, 1_760_000_000))).toBe(1_760_000_000);
  expect(recordTimestamp(new Uint8Array([0xc0]))).toBeNull();
  expect(recordTimestamp(new Uint8Array([0xf8]))).toBeNull();
});

describe("ChainDO indexes", () => {
  async function setup() {
    const storage = new FakeStorage();
    const scans = countScans(storage);
    const c = wake(ChainDO, storage, env0);
    await c.init(id(99), 1, 4);
    await c.putRows([chainRow(100, 103), chainRow(104, 105)]);
    await c.setHead(id(105), null, null);
    return { storage, scans, c };
  }

  /** Every lookup of the incremental index matches a fresh object rebuilt from the rows. */
  async function sameAsRebuilt(c: ChainDO, storage: FakeStorage, pin: BlockId, numbers: number[], txs: string[]) {
    const fresh = wake(ChainDO, storage, env0);
    for (const n of numbers) {
      expect(await c.block(n, pin)).toEqual(await fresh.block(n, pin));
      expect(await c.block(hashOf(n), pin)).toEqual(await fresh.block(hashOf(n), pin));
      expect(await c.block(hashOf(n, 1), pin)).toEqual(await fresh.block(hashOf(n, 1), pin));
    }
    for (const t of txs) expect(await c.txBlock(t, pin)).toEqual(await fresh.txBlock(t, pin));
  }

  test("ingest updates the index without rebuilding it", async () => {
    const { storage, scans, c } = await setup();
    expect(scans()).toBe(1);
    // The group 104… grows; a new group starts.
    await c.putRows([chainRow(104, 107), chainRow(108, 108)]);
    await c.setHead(id(108), null, null);
    expect(await c.block(107, id(108))).toMatchObject({ stale: false, number: 107, hash: hashOf(107) });
    expect(await c.block(hashOf(108).toUpperCase().replace("0X", "0x"), id(108))).toMatchObject({ number: 108 });
    expect(await c.txBlock("0x" + txOf(106, 1), id(108))).toEqual({ stale: false, number: 106 });
    expect(await c.block(108, id(107))).toBeNull();
    expect(scans()).toBe(1);
    await sameAsRebuilt(c, storage, id(108), [99, 100, 104, 107, 108, 109], [txOf(100, 0), txOf(107, 1), txOf(108, 0)]);
  });

  test("reorgs and prunes keep the index in step with the rows", async () => {
    const { storage, scans, c } = await setup();
    await c.putRows([chainRow(104, 107)]);
    await c.setHead(id(107), null, null);
    await c.fence([id(106), id(107)]);
    await c.setHead(id(105), null, null);
    await c.truncateAbove(105);
    // The new branch rewrites the group with 104–105 and its own 106.
    const kept = chainRow(104, 105);
    const fork = chainRow(106, 106, 1);
    await c.putRows([{ first: 104, last: 106, data: new Uint8Array([...kept.data, ...rebase(fork.data, 106, 104)]) }]);
    await c.setHead(id(106, 1), null, null);
    expect(await c.block(106, id(106, 1))).toMatchObject({ hash: hashOf(106, 1) });
    expect(await c.block(hashOf(107), id(106, 1))).toBeNull();
    expect(await c.txBlock(txOf(107, 0), id(106, 1))).toBeNull();
    expect(await c.block(106, id(107))).toEqual({ stale: true });
    await c.pruneAtOrBelow(id(103), 2);
    expect(await c.block(101, id(106, 1))).toBeNull();
    expect(await c.txBlock(txOf(101, 0), id(106, 1))).toBeNull();
    expect(await c.block(104, id(106, 1))).toMatchObject({ number: 104 });
    expect(scans()).toBe(1);
    await sameAsRebuilt(c, storage, id(106, 1), [101, 103, 104, 105, 106, 107], [txOf(101, 0), txOf(105, 0), txOf(1_000_106, 0), txOf(106, 0)]);
  });
});

/** Re-keys sections encoded relative to `from` so they decode relative to `to`. */
function rebase(data: Uint8Array, from: number, to: number): Uint8Array {
  // Single-section rows here: the first byte is uvarint(number - first) = 0.
  return new Uint8Array([from - to, ...data.subarray(1)]);
}

describe("StateShard indexes", () => {
  const A = "11".repeat(20);
  const B = "22".repeat(20);
  const slot = (a: string, s: number) => a + s.toString(16).padStart(64, "0");

  test("writes, reorgs and prunes update the index in place", async () => {
    const storage = new FakeStorage();
    const scans = countScans(storage);
    const s = wake(StateShard, storage, env0);
    const blocks: Record<number, Change[]> = {
      100: [{ domain: DOMAIN.accounts, key: A, value: "01" }, { domain: DOMAIN.storage, key: slot(A, 1), value: "aa" }],
      101: [{ domain: DOMAIN.storage, key: slot(A, 2), value: "bb" }],
    };
    await s.applyMany([shardRow(100, blocks)]);
    expect(await s.getPinned(DOMAIN.accounts, A, 101, id(101))).toEqual({ stale: false, block: 100, value: "01" });
    expect(scans()).toBe(1);

    // The group grows: 102 changes A and wipes its storage, 103 writes slot 2 again.
    blocks[102] = [{ domain: DOMAIN.accounts, key: A, value: "02" }, { domain: DOMAIN.wipe, key: A }];
    blocks[103] = [{ domain: DOMAIN.storage, key: slot(A, 2), value: "cc" }, { domain: DOMAIN.accounts, key: B, value: "05" }];
    await s.applyMany([shardRow(100, blocks)]);
    expect(await s.getPinned(DOMAIN.accounts, A, 103, id(103))).toEqual({ stale: false, block: 102, value: "02" });
    expect(await s.getPinned(DOMAIN.storage, slot(A, 1), 103, id(103))).toEqual({ stale: false, block: 102, value: "" });
    expect(await s.getPinned(DOMAIN.storage, slot(A, 2), 103, id(103))).toEqual({ stale: false, block: 103, value: "cc" });
    expect((await s.scanPinned(A, 103, id(103)) as { slots: Record<string, string> }).slots[slot(A, 2).slice(40)]).toBe("cc");
    expect(await s.getPinned(DOMAIN.accounts, A, 101, id(103))).toEqual({ stale: false, block: 100, value: "01" });

    // Reorg to 102: 103 goes away.
    await s.fence([id(103)]);
    await s.truncateAbove(102);
    expect(await s.getPinned(DOMAIN.accounts, B, 103, id(102))).toEqual({ stale: false, block: null, value: null });
    expect(await s.getPinned(DOMAIN.accounts, A, 103, id(103))).toEqual({ stale: true });

    // Next group, then a prune of the first one.
    await s.applyMany([shardRow(104, { 104: [{ domain: DOMAIN.accounts, key: B, value: "06" }] })]);
    await s.pruneAtOrBelow(103);
    expect(await s.getPinned(DOMAIN.accounts, A, 104, id(104))).toEqual({ stale: false, block: null, value: null });
    expect(await s.getPinned(DOMAIN.accounts, B, 104, id(104))).toEqual({ stale: false, block: 104, value: "06" });
    expect(scans()).toBe(1);

    const fresh = wake(StateShard, storage, env0);
    for (const [d, k] of [[1, A], [1, B], [2, slot(A, 1)], [2, slot(A, 2)]] as const) {
      expect(await s.getPinned(d, k, 104, id(104))).toEqual(await fresh.getPinned(d, k, 104, id(104)));
    }
  });
});

describe("LiveReads", () => {
  const A = "ab".repeat(20);

  async function setup() {
    const t = testEnv();
    const reads = new LiveReads({} as never, t.env);
    const chain = t.env.CHAIN.get(t.env.CHAIN.idFromName("x"));
    await chain.init(id(99), 1, 4);
    await chain.putRows([chainRow(100, 101)]);
    await chain.setHead(id(101), null, null);
    const i = shardOf(DOMAIN.accounts, unhex(A), 4);
    await t.env.SHARD.get(t.env.SHARD.idFromName(`560048-${i}`)).applyMany([
      shardRow(100, { 101: [{ domain: DOMAIN.accounts, key: A, value: "07" }, { domain: DOMAIN.storage, key: A + "00".repeat(32), value: "09" }] }),
    ]);
    return reads;
  }

  test("pins are lowercased and validated", async () => {
    const reads = await setup();
    const upper = { number: 101, hash: "0x" + hashOf(101).slice(2).toUpperCase() };
    expect(await reads.block(100, upper)).toMatchObject({ stale: false, number: 100 });
    expect(await reads.txBlock(txOf(100, 0), upper)).toEqual({ stale: false, number: 100 });
    expect(await reads.getPinned(1, A, 101, upper)).toEqual({ stale: false, block: 101, value: "07" });
    await expect(reads.block(100, { number: 101, hash: "0x1234" })).rejects.toThrow("invalid pin");
    await expect(reads.block(100, { number: -1, hash: hashOf(1) })).rejects.toThrow("invalid pin");
    await expect(reads.witness(100, { number: 1.5, hash: hashOf(1) })).rejects.toThrow("invalid pin");
    await expect(reads.getPinned(1, A, 101, null as never)).rejects.toThrow("invalid pin");
  });

  test("keys are normalized and domains checked", async () => {
    const reads = await setup();
    const pin = id(101);
    for (const k of [A, "0x" + A, "0x" + A.toUpperCase(), A.toUpperCase()]) {
      expect(await reads.getPinned(1, k, 101, pin)).toEqual({ stale: false, block: 101, value: "07" });
    }
    expect(await reads.getPinned(2, "0x" + A.toUpperCase() + "00".repeat(32), 101, pin)).toEqual({ stale: false, block: 101, value: "09" });
    expect(await reads.scanPinned("0x" + A.toUpperCase(), 101, pin)).toEqual({ stale: false, slots: { ["00".repeat(32)]: "09" } });
    await expect(reads.getPinned(4, A, 101, pin)).rejects.toThrow("invalid domain");
    await expect(reads.getPinned(0, A, 101, pin)).rejects.toThrow("invalid domain");
    await expect(reads.getPinned(1, A + "00", 101, pin)).rejects.toThrow("invalid key");
    await expect(reads.getPinned(3, A, 101, pin)).rejects.toThrow("invalid key");
    await expect(reads.getPinned(1, "zz".repeat(20), 101, pin)).rejects.toThrow("invalid key");
  });
});

describe("LiveReads.getPinnedMany", () => {
  /** One address per shard, so a batch spans every shard. */
  function perShard(shards: number): string[] {
    const out: string[] = [];
    for (let i = 1; out.length < shards; i++) {
      const a = i.toString(16).padStart(40, "0");
      if (!out.includes(a) && !out.some((o) => shardOf(DOMAIN.accounts, unhex(o), shards) === shardOf(DOMAIN.accounts, unhex(a), shards))) out.push(a);
    }
    return out.sort((a, b) => shardOf(DOMAIN.accounts, unhex(a), shards) - shardOf(DOMAIN.accounts, unhex(b), shards));
  }
  const CODE = "cd".repeat(32);

  async function setup() {
    const t = testEnv();
    const reads = new LiveReads({} as never, t.env);
    const chain = t.env.CHAIN.get(t.env.CHAIN.idFromName("x"));
    await chain.init(id(99), 1, 4);
    await chain.putRows([chainRow(100, 103)]);
    await chain.setHead(id(103), null, null);
    const addrs = perShard(4);
    const shardDO = (i: number) => t.env.SHARD.get(t.env.SHARD.idFromName(`560048-${i}`));
    // Shard i holds account i with value 0i at block 100+i and its slot 1 at the same block.
    for (let i = 0; i < 4; i++) {
      const changes: Change[] = [
        { domain: DOMAIN.accounts, key: addrs[i]!, value: `0${i}` },
        { domain: DOMAIN.storage, key: addrs[i] + "01".padStart(64, "0"), value: `a${i}` },
      ];
      if (shardOf(DOMAIN.code, unhex(CODE), 4) === i) changes.push({ domain: DOMAIN.code, key: CODE, value: "6080" });
      await shardDO(i).applyMany([shardRow(100, { [100 + i]: changes })]);
    }
    return { reads, addrs, shardDO, env: t.env };
  }

  test("answers every key in order, across shards, with missing keys as null", async () => {
    const { reads, addrs } = await setup();
    const keys = [
      { domain: DOMAIN.accounts, key: "0x" + addrs[3]!.toUpperCase() },
      { domain: DOMAIN.storage, key: addrs[1] + "01".padStart(64, "0") },
      { domain: DOMAIN.accounts, key: "ee".repeat(20) }, // never written
      { domain: DOMAIN.code, key: CODE },
      { domain: DOMAIN.accounts, key: addrs[0]! },
      { domain: DOMAIN.storage, key: addrs[2] + "02".padStart(64, "0") }, // another slot
      { domain: DOMAIN.accounts, key: addrs[2]! },
    ];
    const r = await reads.getPinnedMany(keys, 103, id(103));
    expect(r).toEqual({
      stale: false,
      values: [
        { block: 103, value: "03" },
        { block: 101, value: "a1" },
        { block: null, value: null },
        { block: 100 + shardOf(DOMAIN.code, unhex(CODE), 4), value: "6080" },
        { block: 100, value: "00" },
        { block: null, value: null },
        { block: 102, value: "02" },
      ],
    });
    // Each key is answered exactly as getPinned answers it, at a lower n too.
    for (const n of [100, 101, 103]) {
      const many = (await reads.getPinnedMany(keys, n, id(103))) as { values: unknown[] };
      for (let i = 0; i < keys.length; i++) {
        const one = (await reads.getPinned(keys[i]!.domain, keys[i]!.key, n, id(103))) as { block: unknown; value: unknown };
        expect(many.values[i]).toEqual({ block: one.block, value: one.value });
      }
    }
    expect(await reads.getPinnedMany([], 103, id(103))).toEqual({ stale: false, values: [] });
  });

  test("the batch is stale as soon as one of its shards is", async () => {
    const { reads, addrs, shardDO } = await setup();
    const keys = addrs.map((key) => ({ domain: DOMAIN.accounts, key }));
    expect(await reads.getPinnedMany(keys, 103, id(103))).toMatchObject({ stale: false });
    // A reorg fences shard 2 first; readers pinned at 103 see the batch stale wherever it lands.
    await shardDO(2).fence([id(103)]);
    expect(await reads.getPinnedMany(keys, 103, id(103))).toEqual({ stale: true });
    expect(await reads.getPinnedMany([keys[2]!], 103, id(103))).toEqual({ stale: true });
    expect(await reads.getPinnedMany([keys[0]!], 103, id(103))).toMatchObject({ stale: false });
    // A pin on the surviving branch is fine everywhere.
    expect(await reads.getPinnedMany(keys, 102, id(102))).toEqual({
      stale: false,
      values: [{ block: 100, value: "00" }, { block: 101, value: "01" }, { block: 102, value: "02" }, { block: null, value: null }],
    });
  });

  test("keys and pins are validated before any shard is asked", async () => {
    const { reads, addrs } = await setup();
    await expect(reads.getPinnedMany([{ domain: DOMAIN.accounts, key: addrs[0]! }], 103, { number: 103, hash: "0x12" })).rejects.toThrow("invalid pin");
    await expect(reads.getPinnedMany([{ domain: DOMAIN.accounts, key: addrs[0]! }, { domain: 4, key: addrs[1]! }], 103, id(103))).rejects.toThrow("invalid domain");
    await expect(reads.getPinnedMany([{ domain: DOMAIN.storage, key: addrs[0]! }], 103, id(103))).rejects.toThrow("invalid key");
    await expect(reads.getPinnedMany(Array.from({ length: 1025 }, () => ({ domain: DOMAIN.accounts, key: addrs[0]! })), 103, id(103))).rejects.toThrow("at most 1024");
    await expect(reads.getPinnedMany(null as never, 103, id(103))).rejects.toThrow("at most 1024");
  });
});

describe("status routes", () => {
  const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
  const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

  function ingest(env: object, path: string, body: unknown) {
    return worker.fetch(
      new Request(`https://live-560048.nullrpc.dev${path}`, { method: "POST", headers: { authorization: "Bearer tok" }, body: JSON.stringify(body) }),
      env as never,
      { waitUntil: () => {} } as never,
    );
  }

  async function setup() {
    setSystemTime(new Date(T0));
    const t = testEnv();
    Object.assign(t.env, { INGEST_TOKEN: "tok" });
    const status = new LiveStatus({} as never, t.env);
    const get = async (path: string) => {
      const res = await status.fetch(new Request(`https://live${path}`));
      return { status: res.status, body: (await res.json()) as any };
    };
    return { ...t, get };
  }

  test("status before init, then after blocks with a network head", async () => {
    const { env, chainStorage, get } = await setup();
    let r = await get("/internal/status");
    expect(r.status).toBe(200);
    expect(r.body.chain).toMatchObject({ chain_id: "560048", executed_head: null, target: null, lag: null, halted: false, last_error: null });
    expect(chainStorage.alarm).toBeNull();

    expect((await ingest(env, "/ingest/init", { promoted: id(99), generation: 1 })).status).toBe(200);
    expect(chainStorage.alarm).toBe(T0 + 60_000);
    const row = chainRow(100, 103);
    const res = await ingest(env, "/ingest/blocks", {
      rows: [{ first: 100, last: 103, chain: b64(row.data), shards: {} }],
      head: id(103),
      safe: id(101),
      finalized: id(100),
      network_head: { number: 110, hash: hashOf(110).toUpperCase().replace("0X", "0x") },
    });
    expect(res.status).toBe(200);
    r = await get("/internal/status");
    expect(r.body.chain).toMatchObject({
      at: T0,
      executed_head: { ...id(103), timestamp: 1_700_000_000 + 103 * 12 },
      target: id(110),
      lag: 7,
      safe: id(101),
      optimistic: id(101),
      finalized: id(100),
      archived_through: id(99),
      r2_tip: { ...id(99), generation: 1, checked_at: T0 },
      pending_blocks: 4,
      last_progress: T0,
      last_ingest: T0,
      promotion: { last: null },
      counters: { ingest_batches: 1, rows_written: 1, blocks_advanced: 4 },
      shards: 4,
    });

    // Without a network head the target stays the last reported one; a head above it is its own target.
    await ingest(env, "/ingest/blocks", { rows: [{ first: 100, last: 103, chain: b64(row.data), shards: {} }], head: id(103) });
    expect((await get("/internal/status")).body.chain.target).toEqual(id(110));

    // Errors, reorgs and promotions show up.
    expect((await ingest(env, "/ingest/blocks", { rows: [], head: id(103) })).status).toBe(400);
    await ingest(env, "/ingest/reorg", { ancestor: id(102), removed: [id(103)] });
    await ingest(env, "/ingest/prune", { promoted: id(101), generation: 2 });
    r = await get("/internal/status");
    expect(r.body.chain).toMatchObject({
      executed_head: { ...id(102), timestamp: 1_700_000_000 + 102 * 12 },
      lag: 8,
      archived_through: id(101),
      pending_blocks: 1,
      promotion: { last: { archived_through: id(101), generation: 2, at: T0 } },
      counters: { reorgs: 1, reorged_blocks: 1, prunes: 1, ingest_errors: 1 },
      last_error: { message: "/ingest/blocks: rows must hold 1 to 256 groups", at: T0 },
    });
  });

  test("before the daemon reports a network head, the target and lag are unknown", async () => {
    const { env, chainStorage, get } = await setup();
    const chain = env.CHAIN.get("x" as never);
    await chain.init(id(99), 1, 4);
    await chain.putRows([chainRow(100, 159)]);
    // Two minutes without a network head, then one with it.
    for (let m = 0; m < 3; m++) {
      await chain.setHead(id(100 + 5 * m), null, null, m === 2 ? id(150) : null);
      setSystemTime(new Date(chainStorage.alarm!));
      await chain.alarm();
    }
    const points = (await get("/internal/history?range=1h")).body.points;
    expect(points.map((p: { target: number | null; lag: number | null }) => [p.target, p.lag])).toEqual([[null, null], [null, null], [150, 40]]);
    expect((await get("/internal/status")).body.chain).toMatchObject({ target: id(150), lag: 40 });
  });

  test("history samples once a minute and buckets by range", async () => {
    const { env, chainStorage, get } = await setup();
    const chain = env.CHAIN.get("x" as never);
    await chain.init(id(99), 1, 4);
    await chain.putRows([chainRow(100, 159)]);
    // Minute m: head 100 + 5m (5 blocks a minute), network head 10 above it.
    for (let m = 0; m < 10; m++) {
      await chain.setHead(id(100 + 5 * m), null, null, id(110 + 5 * m));
      setSystemTime(new Date(chainStorage.alarm!));
      await chain.alarm();
    }
    let r = await get("/internal/history?range=1h");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ bucket_s: 60, retention_s: 604_800, to: Math.floor(Date.now() / 1000) });
    expect(r.body.to - r.body.from).toBe(3600);
    expect(r.body.points).toHaveLength(10);
    expect(r.body.points[0]).toEqual({ t: T0 / 1000 + 60, executed: 100, target: 110, lag: 10, rate: null });
    expect(r.body.points[9]).toEqual({ t: T0 / 1000 + 600, executed: 145, target: 155, lag: 10, rate: 5 / 60 });

    r = await get("/internal/history?range=24h");
    expect(r.body.bucket_s).toBe(300);
    expect(r.body.points.map((p: { t: number; executed: number }) => [p.t - T0 / 1000, p.executed])).toEqual([[0, 115], [300, 140], [600, 145]]);
    expect(r.body.points[1].rate).toBeCloseTo(5 / 60);

    // Samples older than 7 days are dropped.
    setSystemTime(new Date(T0 + 8 * 86_400_000));
    await chain.alarm();
    r = await get("/internal/history?range=7d");
    expect(r.body.points).toHaveLength(1);
    expect(r.body.points[0].executed).toBe(145);

    expect((await get("/internal/history?range=2h")).status).toBe(400);
    expect((await get("/internal/nope")).status).toBe(404);
  });

  test("internal routes are not served on the public fetch handler", async () => {
    const { env } = await setup();
    const res = await worker.fetch(new Request("https://live-560048.nullrpc.dev/internal/status"), env as never, { waitUntil: () => {} } as never);
    expect(res.status).toBe(404);
    const unauth = await worker.fetch(new Request("https://live-560048.nullrpc.dev/ingest/state"), env as never, { waitUntil: () => {} } as never);
    expect(unauth.status).toBe(401);
  });
});
