// The fee methods on a chain shaped like mainnet: a live window of large blocks listed by
// live/HEAD.json, where the gas price oracle's window of 20 records would otherwise be read and
// decoded for every new head. The per-block fee inputs (src/methods/fees.ts) are kept by hash
// in the isolate and at the edge, so a request at a new head reads one record: the head's.
// This file has its own module instances (vitest isolates files): the caches start empty.

import { beforeEach, describe, expect, test } from "vitest";
import { Archive } from "../src/archive/archive";
import { MemorySource } from "../src/archive/source";
import { Chain } from "../src/chain";
import { data } from "../src/eth/hex";
import { decodeRecord } from "../src/eth/record";
import type { BlockId, LiveApi, LiveState } from "../src/live";
import { Live, liveRecordKey, POINTERS_KEY } from "../src/live";
import { METHODS } from "../src/methods";
import { FEE_INPUTS_TTL_S, feeInputs, feeInputsUrl } from "../src/methods/fees";
import type { MethodEnv } from "../src/rpc";
import { buildArchive, PREFIX } from "./archive";
import { FakeCache } from "./caches";
import { encodeRecord, fixtures, type Fixture } from "./encode";

const ALL = fixtures();
const ARCHIVED = ALL.filter((f) => Number(f.block.number) <= 20_000_001);
const OBJECTS = buildArchive(ARCHIVED);
const P: BlockId = { number: Number(ARCHIVED.at(-1)!.block.number), hash: ARCHIVED.at(-1)!.block.hash };
/** Two recent mainnet blocks (hundreds of transactions each) stand in for every block of the window. */
const TEMPLATES = ALL.filter((f) => Number(f.block.number) > 20_000_001);
const ORIGIN = "https://eth.nullrpc.dev";
const hex = (n: number) => "0x" + n.toString(16);

interface Synth {
  number: number;
  hash: string;
  record: Uint8Array;
}

/**
 * Block `n` of a window: a template re-numbered, with the hash its header then has. `salt`
 * (in mixHash) gives each test blocks of its own: the live module keeps records by hash per
 * isolate, so a block one test read would cost the next no read.
 */
function synth(n: number, salt: number): Synth {
  const template = TEMPLATES[n % TEMPLATES.length]!;
  const f: Fixture = { ...template, block: { ...template.block, number: hex(n), mixHash: "0x" + salt.toString(16).padStart(64, "0") } };
  const record = encodeRecord(f);
  return { number: n, hash: data(decodeRecord(record).block.header.hash), record };
}

/** The window P+1 .. P+23; a document lists its first `count` blocks and names the last as the head. */
let WINDOW: Synth[] = [];
let salt = 0;
const at = (n: number) => WINDOW[n - P.number - 1]!;

/** A LiveReads that must not be asked: the document and the records answer everything. */
function silentLive(head: BlockId): { api: LiveApi; calls: string[] } {
  const calls: string[] = [];
  const refuse = (what: string) => {
    calls.push(what);
    throw new Error(`the live Worker was asked: ${what}`);
  };
  const api: LiveApi = {
    async state() {
      return { head, safe: head, finalized: head, promoted: P, generation: 1, shards: 16 } satisfies LiveState;
    },
    async block(key) {
      return refuse(`block:${key}`);
    },
    async witness() {
      return null;
    },
    async txBlock(hash) {
      return refuse(`tx:${hash}`);
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

let waits: Promise<unknown>[];
const settle = () => Promise.all(waits);

/** One request at a head of `count` listed blocks, reading records from `source`; `edge` is the data center's cache, or none. */
async function open(count: number, edge: FakeCache | null) {
  const now = Date.now() + Math.random() * 1e12;
  const listed = WINDOW.slice(0, count);
  const head: BlockId = { number: listed.at(-1)!.number, hash: listed.at(-1)!.hash };
  const objects = new Map(OBJECTS);
  for (const b of listed) objects.set(liveRecordKey(PREFIX, b.number, b.hash), b.record);
  const doc = { version: 1, head, safe: head, finalized: head, promoted: P, generation: 1, written_at: new Date(now - 500).toISOString(), blocks: { first: P.number + 1, hashes: listed.map((b) => b.hash) } };
  objects.set(`${PREFIX}/${POINTERS_KEY}`, new TextEncoder().encode(JSON.stringify(doc)));
  const source = new MemorySource(objects);
  const { api, calls } = silentLive(head);
  const chain = await Chain.open(new Archive(source, PREFIX), new Live(api, { source, prefix: PREFIX, archive: source }), now);
  const env: MethodEnv = { chainId: 1, edge: edge ? { cache: edge as unknown as Cache, origin: ORIGIN, defer: (p) => waits.push(p) } : undefined };
  const call = async (method: string, ...params: unknown[]) => {
    const out = await METHODS[method]!(chain, params, env);
    await settle();
    return out;
  };
  /** The window blocks whose records this request read, by number, ascending. */
  const read = () => source.reads.filter((r) => r.key.includes("/live/records/")).map((r) => Number(r.key.split("/live/records/")[1]!.split("-")[0])).sort((a, b) => a - b);
  return { chain, call, read, calls, head };
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("fee inputs on a mainnet-shaped window", () => {
  beforeEach(() => {
    WINDOW = Array.from({ length: 23 }, (_, i) => synth(P.number + 1 + i, ++salt));
    feeInputs.clear();
    waits = [];
  });

  test("the oracle reads its window once; a new head then costs one record, the head's", async () => {
    const edge = new FakeCache();
    const first = await open(22, edge);
    const price22 = await first.call("eth_gasPrice");
    expect(first.read()).toEqual(range(P.number + 3, P.number + 22));
    expect(first.calls).toEqual([]);
    // Every block's inputs are at the edge, immutable per hash, for a day.
    expect(edge.keys.sort()).toEqual(range(P.number + 3, P.number + 22).map((n) => feeInputsUrl(ORIGIN, 1, at(n).hash)).sort());
    expect(Object.fromEntries(edge.entries.get(edge.keys[0]!)!.headers)["cache-control"]).toBe(`public, max-age=${FEE_INPUTS_TTL_S}`);

    // The head moves: the listing names the new block's hash, the isolate has the other 19.
    const second = await open(23, edge);
    const price23 = await second.call("eth_gasPrice");
    expect(second.read()).toEqual([P.number + 23]);
    expect(await second.call("eth_maxPriorityFeePerGas")).toMatch(/^0x[0-9a-f]+$/);
    expect(second.read()).toEqual([P.number + 23]);
    expect(edge.keys).toHaveLength(21);

    // Computed again from the records alone (the isolate keeps those by hash), the answers are the same.
    feeInputs.clear();
    expect(await (await open(23, null)).call("eth_gasPrice")).toBe(price23);
    feeInputs.clear();
    expect(await (await open(22, null)).call("eth_gasPrice")).toBe(price22);
    expect(price22).not.toBe(price23); // the base fee differs between the two templates
  });

  test("another isolate in the data center reads nothing: the edge answers every block", async () => {
    const edge = new FakeCache();
    const warm = await open(23, edge);
    const expected = await warm.call("eth_gasPrice");
    expect(warm.read()).toHaveLength(20);
    feeInputs.clear();
    const cold = await open(23, edge);
    expect(await cold.call("eth_gasPrice")).toBe(expected);
    expect(cold.read()).toEqual([]);
    expect(feeInputs.size).toBe(20); // an edge hit refills the isolate
    expect(edge.puts).toBe(20);

    // A damaged entry is a miss: that block alone is computed again (from the isolate's copy of
    // its record) and the entry rewritten.
    const url = feeInputsUrl(ORIGIN, 1, at(P.number + 10).hash);
    const good = edge.entries.get(url)!.bytes;
    edge.entries.set(url, { bytes: new TextEncoder().encode('{"n":1}'), headers: [] });
    feeInputs.clear();
    const damaged = await open(23, edge);
    expect(await damaged.call("eth_gasPrice")).toBe(expected);
    expect(edge.puts).toBe(21);
    expect(edge.entries.get(url)!.bytes).toEqual(good);
  });

  test("eth_feeHistory and eth_blobBaseFee read the same inputs", async () => {
    const edge = new FakeCache();
    const fresh = await open(23, null);
    const history = await fresh.call("eth_feeHistory", "0x4", "latest", [25, 75]);
    const older = await fresh.call("eth_feeHistory", 3, hex(P.number + 20), [50]);
    const blob = await fresh.call("eth_blobBaseFee");
    expect(fresh.read()).toEqual(range(P.number + 18, P.number + 23));
    expect(history).toMatchObject({ oldestBlock: hex(P.number + 20) });
    expect((history as { reward: string[][] }).reward).toHaveLength(4);
    expect((history as { baseFeePerGas: string[] }).baseFeePerGas).toHaveLength(5);

    // The inputs in the isolate answer every call at the head without a record.
    const warm = await open(23, edge);
    expect(await warm.call("eth_feeHistory", "0x4", "latest", [25, 75])).toEqual(history);
    expect(await warm.call("eth_feeHistory", 3, hex(P.number + 20), [50])).toEqual(older);
    expect(await warm.call("eth_blobBaseFee")).toBe(blob);
    expect(warm.read()).toEqual([]);
    expect(edge.puts).toBe(0); // nothing was computed, so nothing was stored

    // A wider range over blocks the isolate has: still no record.
    const wider = await warm.call("eth_feeHistory", 6, "latest", []);
    expect(warm.read()).toEqual([]);
    expect((wider as { baseFeePerGas: string[] }).baseFeePerGas).toHaveLength(7);
    // One block further back is one record.
    await warm.call("eth_feeHistory", 7, "latest", []);
    expect(warm.read()).toEqual([P.number + 17]);
  });

  test("without a listing the record is read, as before, and its inputs are kept by hash", async () => {
    // A pin from state() (the service binding): the block's hash is unknown until the record is read.
    const now = Date.now() + Math.random() * 1e12;
    const head: BlockId = { number: at(P.number + 2).number, hash: at(P.number + 2).hash };
    const calls: string[] = [];
    const api: LiveApi = {
      ...silentLive(head).api,
      async block(key) {
        calls.push(`block:${key}`);
        const b = typeof key === "number" ? at(key) : WINDOW.find((w) => w.hash === key);
        return b ? { stale: false, number: b.number, hash: b.hash, record: Buffer.from(b.record).toString("hex") } : null;
      },
    };
    const chain = await Chain.open(new Archive(new MemorySource(OBJECTS), PREFIX), new Live(api), now);
    // The head's hash is the pin's; the archive's offsets name P's; the block between is unknown.
    expect(await chain.hashOf(P.number + 2)).toBe(head.hash);
    expect(await chain.hashOf(P.number + 1)).toBeNull();
    expect(await chain.hashOf(P.number)).toBe(P.hash);
    expect(await chain.hashOf(P.number + 3)).toBeNull();
    const env: MethodEnv = { chainId: 1 };
    const out = await METHODS.eth_feeHistory!(chain, ["0x2", "latest", [50]], env);
    expect(out).toMatchObject({ oldestBlock: hex(P.number + 1) });
    expect(calls).toEqual([`block:${P.number + 1}`, `block:${P.number + 2}`]);
    expect(feeInputs.get(head.hash)).toMatchObject({ number: P.number + 2, hash: head.hash });
    expect(feeInputs.get(at(P.number + 1).hash)).toMatchObject({ number: P.number + 1 });
    // The next request finds the head's inputs in the isolate (its hash is known) and asks the
    // binding for the other block alone.
    calls.length = 0;
    const next = await Chain.open(new Archive(new MemorySource(OBJECTS), PREFIX), new Live(api), now + 60_000);
    expect(await METHODS.eth_feeHistory!(next, ["0x2", "latest", [50]], env)).toEqual(out);
    expect(calls).toEqual([`block:${P.number + 1}`]);
  });
});
