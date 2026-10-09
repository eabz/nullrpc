import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, test } from "vitest";
import { Archive } from "../src/archive/archive";
import { MemorySource } from "../src/archive/source";
import { Chain } from "../src/chain";
import type { BlockId, LiveApi, LiveState, PointerCache } from "../src/live";
import { Live, POINTERS_KEY, POINTERS_MAX_AGE_MS } from "../src/live";
import { METHODS } from "../src/methods";
import { renderPage, statusBody } from "../src/page/page";
import { ChainStateSource } from "../src/state-source";
import { buildArchive, encodeAccount, PREFIX } from "./archive";
import { encodeRecord, fixtures, type Fixture } from "./encode";

const ALL = fixtures();
// The archive holds everything up to 20,000,001 (P); the live window holds the Prague blocks.
const ARCHIVED = ALL.filter((f) => Number(f.block.number) <= 20_000_001);
const WINDOW = ALL.filter((f) => Number(f.block.number) > 20_000_001);
const OBJECTS = buildArchive(ARCHIVED);
const hex = (n: number) => "0x" + n.toString(16);
const id = (f: Fixture): BlockId => ({ number: Number(f.block.number), hash: f.block.hash });
const recHex = (f: Fixture) => Buffer.from(encodeRecord(f)).toString("hex");

/** A fake LiveReads over WINDOW with a scriptable reorg. */
function fakeLive(opts: { promoted?: BlockId; staleOnce?: boolean } = {}) {
  let stale = opts.staleOnce ?? false;
  const head = id(WINDOW.at(-1)!);
  const calls: string[] = [];
  const state: LiveState = { head, safe: head, finalized: id(WINDOW[0]!), promoted: opts.promoted ?? id(ARCHIVED.at(-1)!), generation: 1, shards: 16 };
  const api: LiveApi = {
    async state() {
      calls.push("state");
      return state;
    },
    async block(key, pin) {
      calls.push(`block:${key}`);
      if (stale) {
        stale = false;
        return { stale: true };
      }
      const f = WINDOW.find((w) => (typeof key === "number" ? Number(w.block.number) === key : w.block.hash === key.toLowerCase()));
      if (!f || Number(f.block.number) > pin.number) return null;
      return { stale: false, number: Number(f.block.number), hash: f.block.hash, record: recHex(f) };
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

async function open(api: LiveApi) {
  const archive = new Archive(new MemorySource(OBJECTS), PREFIX);
  // A distinct "now" per call keeps the isolate caches from leaking between tests.
  return Chain.open(archive, new Live(api), Date.now() + Math.random() * 1e12);
}
const call = (chain: Chain, method: string, ...params: unknown[]) => METHODS[method]!(chain, params, { chainId: 1 });

describe("live window", () => {
  test("latest, safe and finalized come from the live pointers", async () => {
    const { api } = fakeLive();
    const chain = await open(api);
    expect(await call(chain, "eth_blockNumber")).toBe(WINDOW.at(-1)!.block.number);
    expect(chain.pointers()).toMatchObject({ archived: 20_000_001, finalized: Number(WINDOW[0]!.block.number) });
  });

  test("blocks above P come from the live window, below from the archive", async () => {
    const { api, calls } = fakeLive();
    const chain = await open(api);
    expect(await call(chain, "eth_getBlockByNumber", "latest", true)).toEqual(WINDOW.at(-1)!.block);
    expect(await call(chain, "eth_getBlockByNumber", hex(20_000_000), true)).toEqual(ARCHIVED.find((f) => Number(f.block.number) === 20_000_000)!.block);
    expect(calls.filter((c) => c === "block:20000000")).toHaveLength(0);
  });

  test("hashes and transactions resolve in the window first, then the archive", async () => {
    const { api } = fakeLive();
    const chain = await open(api);
    const liveTx = WINDOW[0]!.block.transactions[5];
    const oldTx = ARCHIVED[0]!.block.transactions[0];
    expect(await call(chain, "eth_getTransactionByHash", liveTx.hash)).toEqual(liveTx);
    expect(await call(chain, "eth_getTransactionReceipt", liveTx.hash)).toEqual(WINDOW[0]!.receipts[5]);
    expect(await call(chain, "eth_getTransactionByHash", oldTx.hash)).toEqual(oldTx);
    expect(((await call(chain, "eth_getBlockByHash", WINDOW[1]!.block.hash, false)) as { number: string }).number).toBe(WINDOW[1]!.block.number);
  });

  test("a stale pin (reorg) re-reads the live state and retries", async () => {
    const { api, calls } = fakeLive({ staleOnce: true });
    const chain = await open(api);
    expect(((await call(chain, "eth_getBlockByNumber", "latest", false)) as { hash: string }).hash).toBe(WINDOW.at(-1)!.block.hash);
    expect(calls.filter((c) => c === "state").length).toBeGreaterThanOrEqual(2);
  });

  test("a block promoted past the pinned manifest is read from the new generation", async () => {
    // The live window already pruned block 20,000,001, but this request pinned an older manifest
    // ending at 20,000,000; the chain must re-read HEAD.json rather than answer null.
    const older = new Map(OBJECTS);
    const newer = buildArchive(ARCHIVED);
    const olderObjects = buildArchive(ARCHIVED.slice(0, -1));
    for (const [k, v] of olderObjects) older.set(k, v);
    const source = new MemorySource(older);
    const archive = new Archive(source, PREFIX);
    const now = Date.now() + Math.random() * 1e12;
    await archive.pin(now); // caches the older generation
    for (const [k, v] of newer) older.set(k, v);
    const { api } = fakeLive({ promoted: id(ARCHIVED.at(-1)!) });
    const chain = await Chain.open(archive, new Live(api), now + 1);
    expect(chain.archived).toBe(20_000_001);
    expect(((await call(chain, "eth_getBlockByNumber", hex(20_000_001), false)) as { hash: string }).hash).toBe(ARCHIVED.at(-1)!.block.hash);
  });
});

describe("live pointers in R2", () => {
  const encode = (doc: unknown) => new TextEncoder().encode(JSON.stringify(doc));
  /** live/HEAD.json as the daemon writes it, `age` ms before `now`. */
  const pointers = (state: LiveState, now: number, age = 500) =>
    encode({ version: 1, head: state.head, safe: state.safe, finalized: state.finalized, promoted: state.promoted, generation: state.generation, written_at: new Date(now - age).toISOString() });

  /** A stand-in for caches.default: one data center's cache. */
  class FakeCache implements PointerCache {
    readonly store = new Map<string, Response>();
    puts = 0;
    async match(key: string) {
      return this.store.get(key)?.clone();
    }
    async put(key: string, response: Response) {
      this.puts++;
      this.store.set(key, response);
    }
  }

  async function openWith(api: LiveApi, object: Uint8Array | null, cache: PointerCache | null, now: number) {
    const objects = new Map(OBJECTS);
    if (object) objects.set(`${PREFIX}/${POINTERS_KEY}`, object);
    const source = new MemorySource(objects);
    const archive = new Archive(source, PREFIX);
    const chain = await Chain.open(archive, new Live(api, { source, prefix: PREFIX, cache }), now);
    return { chain, source };
  }

  test("the pointers come from live/HEAD.json, shared through the edge cache, not from the live Worker", async () => {
    const { api, calls } = fakeLive();
    const now = Date.now() + Math.random() * 1e12;
    const state = await api.state();
    calls.length = 0;
    const cache = new FakeCache();
    const { chain, source } = await openWith(api, pointers(state, now), cache, now);
    expect(calls).not.toContain("state");
    expect(await call(chain, "eth_blockNumber")).toBe(WINDOW.at(-1)!.block.number);
    expect(chain.pointers()).toMatchObject({ latest: state.head!.number, safe: state.safe!.number, finalized: state.finalized!.number, archived: 20_000_001 });
    expect(source.reads.some((r) => r.key === `${PREFIX}/${POINTERS_KEY}`)).toBe(true);
    // Live reads still carry the pinned head.
    expect(await call(chain, "eth_getBlockByNumber", "latest", false)).toMatchObject({ hash: state.head!.hash });
    expect(calls.filter((c) => c.startsWith("block:"))).toHaveLength(1);
    expect(cache.puts).toBe(1);
    expect(cache.store.get(`https://live-pointers.nullrpc.invalid/${PREFIX}/${POINTERS_KEY}`)).toBeDefined();

    // Another isolate in the same data center: the cache answers, neither R2 nor the DO is asked.
    const other = fakeLive();
    const second = await openWith(other.api, null, cache, now + 1);
    expect(other.calls).not.toContain("state");
    expect(second.source.reads.some((r) => r.key === `${PREFIX}/${POINTERS_KEY}`)).toBe(false);
    expect(second.chain.pointers().latest).toBe(state.head!.number);
    expect(cache.puts).toBe(1);
  });

  test("the service binding answers when the object is missing, malformed or old", async () => {
    const now = Date.now() + Math.random() * 1e12;
    for (const object of [null, encode({ version: 2 }), new TextEncoder().encode("{"), pointers((await fakeLive().api.state()), now, POINTERS_MAX_AGE_MS + 1_000)]) {
      const { api, calls } = fakeLive();
      const { chain } = await openWith(api, object, new FakeCache(), now);
      expect(calls.filter((c) => c === "state")).toHaveLength(1);
      expect(chain.pointers().latest).toBe(Number(WINDOW.at(-1)!.block.number));
    }
    // Just inside the limit the object still counts.
    const { api, calls } = fakeLive();
    const state = await api.state();
    calls.length = 0;
    await openWith(api, pointers(state, now, POINTERS_MAX_AGE_MS - 1_000), null, now);
    expect(calls).not.toContain("state");
  });

  test("a stale pin re-reads the pointers from the live Worker, not from R2", async () => {
    const { api, calls } = fakeLive({ staleOnce: true });
    const now = Date.now() + Math.random() * 1e12;
    const state = await api.state();
    calls.length = 0;
    // R2 still names a head the (scripted) reorg removed.
    const { chain, source } = await openWith(api, pointers(state, now), new FakeCache(), now);
    expect(calls).not.toContain("state");
    const reads = source.reads.length;
    expect(((await call(chain, "eth_getBlockByNumber", "latest", false)) as { hash: string }).hash).toBe(WINDOW.at(-1)!.block.hash);
    // One stale answer, one authoritative state() through the binding, one retry with its head.
    expect(calls).toEqual(["block:latest", "state", "block:latest"].map((c) => c.replace("latest", String(state.head!.number))));
    expect(source.reads.slice(reads).some((r) => r.key === `${PREFIX}/${POINTERS_KEY}`)).toBe(false);
  });
});

describe("state source over the live window", () => {
  const P = 20_000_001;
  const A = Uint8Array.from({ length: 20 }, (_, i) => 0xa0 + i);
  const B = Uint8Array.from({ length: 20 }, (_, i) => 0xb0 + i);
  const SLOT1 = Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 1 : 0));
  const SLOT2 = Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 2 : 0));
  const CODE_OLD = Uint8Array.from([0x60, 0x00]);
  const CODE_NEW = Uint8Array.from([0x60, 0x01]);
  const HASH_OLD = keccak_256(CODE_OLD);
  const HASH_NEW = keccak_256(CODE_NEW);
  const h = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");
  // The archive at P: A and B exist, A has slot 1, B's code is CODE_OLD.
  const ARCHIVE = buildArchive(ARCHIVED, {
    state: {
      entries: [
        { domain: "accounts", key: A, block: 1_000, value: encodeAccount(1, 10n) },
        { domain: "accounts", key: B, block: 2_000, value: encodeAccount(2, 20n, HASH_OLD) },
        { domain: "storage", key: Uint8Array.from([...A, ...SLOT1]), block: 3_000, value: Uint8Array.from([7]) },
        { domain: "code", key: HASH_OLD, block: 2_000, value: CODE_OLD },
      ],
      layers: [[0, P]],
    },
  });

  /** A live window where A changed (nonce 5, now with CODE_NEW), A's slot 2 was written and B is untouched. */
  function liveState(opts: { staleOnce?: boolean } = {}) {
    let stale = opts.staleOnce ?? false;
    const head = id(WINDOW.at(-1)!);
    const calls: { keys: { domain: number; key: string }[]; n: number; pin: BlockId }[] = [];
    let states = 0;
    const window: Record<string, { block: number; value: string }> = {
      [`1:${h(A).slice(2)}`]: { block: head.number - 1, value: Buffer.from(encodeAccount(5, 50n, HASH_NEW)).toString("hex") },
      [`2:${h(A).slice(2)}${h(SLOT2).slice(2)}`]: { block: head.number, value: "09" },
      [`3:${h(HASH_NEW).slice(2)}`]: { block: head.number - 1, value: Buffer.from(CODE_NEW).toString("hex") },
    };
    const state: LiveState = { head, safe: head, finalized: id(WINDOW[0]!), promoted: id(ARCHIVED.at(-1)!), generation: 1, shards: 16 };
    const api: LiveApi = {
      async state() {
        states++;
        return state;
      },
      async block(key, pin) {
        const f = WINDOW.find((w) => (typeof key === "number" ? Number(w.block.number) === key : w.block.hash === key.toLowerCase()));
        if (!f || Number(f.block.number) > pin.number) return null;
        return { stale: false, number: Number(f.block.number), hash: f.block.hash, record: recHex(f) };
      },
      async witness() {
        return null;
      },
      async txBlock() {
        return null;
      },
      async getPinned() {
        throw new Error("the state source must batch its reads");
      },
      async getPinnedMany(keys, n, pin) {
        calls.push({ keys, n, pin });
        if (stale) {
          stale = false;
          return { stale: true };
        }
        return {
          stale: false,
          values: keys.map((k) => {
            const found = window[`${k.domain}:${k.key}`];
            return found && found.block <= Math.min(n, pin.number) ? found : { block: null, value: null };
          }),
        };
      },
      async scanPinned() {
        return { stale: false, slots: {} };
      },
    };
    return { api, calls, head, states: () => states };
  }

  const KEYS = [
    { kind: "account", address: h(A) },
    { kind: "blockHash", number: P },
    { kind: "storage", address: h(A), slot: "0x2" },
    { kind: "account", address: h(B) },
    { kind: "storage", address: h(A), slot: "0x1" },
    { kind: "code", hash: h(HASH_NEW) },
    { kind: "code", hash: h(HASH_OLD) },
    { kind: "account", address: h(Uint8Array.from({ length: 20 }, () => 0xee)) },
  ] as const;
  const AT_HEAD = [
    { kind: "account", nonce: 5, balance: "0x32", codeHash: h(HASH_NEW) },
    { kind: "blockHash", hash: ARCHIVED.at(-1)!.block.hash },
    { kind: "storage", value: "0x9" },
    { kind: "account", nonce: 2, balance: "0x14", codeHash: h(HASH_OLD) },
    { kind: "storage", value: "0x7" },
    { kind: "code", code: h(CODE_NEW) },
    { kind: "code", code: h(CODE_OLD) },
    null,
  ];

  async function source(api: LiveApi) {
    // This archive shares its prefix with the file's other one: pin it fresh so the isolate's
    // HEAD cache does not hand back the other manifest.
    const archive = new Archive(new MemorySource(ARCHIVE), PREFIX);
    const now = Date.now() + Math.random() * 1e12;
    await archive.pin(now, true);
    const chain = await Chain.open(archive, new Live(api), now);
    return new ChainStateSource(chain);
  }

  test("one round is one call to the live window; unchanged keys come from the archive at P", async () => {
    const { api, calls, head } = liveState();
    const src = await source(api);
    expect(await src.read([...KEYS], head.number)).toEqual(AT_HEAD);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ n: head.number, pin: head });
    expect(calls[0]!.keys).toEqual([
      { domain: 1, key: h(A).slice(2) },
      { domain: 2, key: h(A).slice(2) + h(SLOT2).slice(2) },
      { domain: 1, key: h(B).slice(2) },
      { domain: 2, key: h(A).slice(2) + h(SLOT1).slice(2) },
      { domain: 3, key: h(HASH_NEW).slice(2) },
      { domain: 3, key: h(HASH_OLD).slice(2) },
      { domain: 1, key: "ee".repeat(20) },
    ]);
    // Below the newest change, the window answers less and the archive the rest.
    const older = await src.read([KEYS[0], KEYS[2]], head.number - 1);
    expect(older).toEqual([AT_HEAD[0], { kind: "storage", value: "0x0" }]);
    expect(calls[1]).toMatchObject({ n: head.number - 1 });
  });

  test("a stale batch re-pins and retries once, still in one call per round", async () => {
    const { api, calls, head, states } = liveState({ staleOnce: true });
    const src = await source(api);
    expect(await src.read([...KEYS], head.number)).toEqual(AT_HEAD);
    expect(calls).toHaveLength(2);
    expect(states()).toBe(2);
  });

  test("reads at or below P never touch the live window", async () => {
    const { api, calls } = liveState();
    const src = await source(api);
    expect(await src.read([KEYS[0], KEYS[3], KEYS[4], KEYS[6]], P)).toEqual([
      { kind: "account", nonce: 1, balance: "0xa", codeHash: null },
      AT_HEAD[3],
      AT_HEAD[4],
      AT_HEAD[6],
    ]);
    expect(calls).toHaveLength(0);
    await expect(src.read([KEYS[0]], Number(WINDOW.at(-1)!.block.number) + 1)).rejects.toThrow("block out of range");
  });
});

describe("page and status", () => {
  test("status.json reports the live head with its timestamp and the archive tip", async () => {
    const { api } = fakeLive();
    const chain = await open(api);
    const tip = WINDOW.at(-1)!.block;
    const s = await statusBody({ chainId: 1, name: "Ethereum", statusUrl: null, keys: true }, chain, Number(tip.timestamp) * 1000 + 5_000);
    expect(s).toMatchObject({ chain_id: 1, state: "following", archived_through: 20_000_001, latest: { number: Number(tip.number), timestamp: Number(tip.timestamp) } });
    expect(s.window).toBe(Number(tip.number) - 20_000_001);
  });

  test("the page escapes values and points at this origin", () => {
    const html = renderPage({ chainId: 1, name: "Ethereum <x>", statusUrl: "https://status.nullrpc.dev", keys: true }, "https://eth.nullrpc.dev");
    expect(html).toContain("Ethereum &#60;x&#62;");
    expect(html).toContain('data-usage="/_status/usage"');
    expect(html).toContain("https://eth.nullrpc.dev/&lt;key&gt;");
    expect(html).not.toMatch(/\{\{[a-z_]+\}\}/);
  });
});
