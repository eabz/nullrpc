// eth_getLogs over the live window (docs/storage.md, "Live records"): the blooms object the
// daemon names in live/HEAD.json narrows the window to the blocks whose header bloom admits
// the filter, only those records are read (raw, through the frame extraction), and a document
// without usable blooms (an older daemon, a bad digest, a pin from the live Worker) reads every
// block as before. This file keeps its own module instance of src/live.ts (vitest isolates
// files), so the isolate's record cache starts empty here and record reads are observable in
// the first test; later tests observe the candidates through Chain.liveLogBlocks.

import { describe, expect, test } from "vitest";
import { Archive, sha256 } from "../src/archive/archive";
import { MemorySource } from "../src/archive/source";
import { Chain } from "../src/chain";
import { bloomAdmits } from "../src/eth/bloom";
import { parseData } from "../src/eth/hex";
import type { BlockId, LiveApi, LiveState } from "../src/live";
import { BloomTable, Live, liveRecordKey, POINTERS_KEY } from "../src/live";
import { METHODS } from "../src/methods";
import { buildArchive, logIndex, PREFIX } from "./archive";
import { encodeRecord, fixtures, type Fixture } from "./encode";

const ALL = fixtures();
const ARCHIVED = ALL.filter((f) => Number(f.block.number) <= 20_000_001);
const WINDOW = ALL.filter((f) => Number(f.block.number) > 20_000_001);
const OBJECTS = buildArchive(ARCHIVED, { extra: (b) => ({ log_index: logIndex(b, ARCHIVED) }) });
const P = id(ARCHIVED.at(-1)!);
const HEAD = id(WINDOW.at(-1)!);
const FIRST = Number(WINDOW[0]!.block.number);
const JUST_BELOW: BlockId = { number: FIRST - 1, hash: `0x${"ab".repeat(32)}` };
const hex = (n: number) => "0x" + n.toString(16);
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => parseData(s)!;
function id(f: Fixture): BlockId {
  return { number: Number(f.block.number), hash: f.block.hash };
}
const call = (chain: Chain, method: string, ...params: unknown[]) => METHODS[method]!(chain, params, { chainId: 1 });
type Log = { address: string; topics: string[]; blockNumber: string };
const WINDOW_LOGS: Log[] = WINDOW.flatMap((f) => f.receipts.flatMap((r) => r.logs as Log[]));
const logsOf = (f: Fixture) => f.receipts.flatMap((r) => r.logs as Log[]);
/** An address with logs in WINDOW[0] and none in WINDOW[1]. */
const ONLY_FIRST = logsOf(WINDOW[0]!)
  .map((l) => l.address)
  .find((a) => !logsOf(WINDOW[1]!).some((l) => l.address === a))!;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function fakeLive(opts: { staleOnce?: boolean; reorgedHead?: BlockId } = {}) {
  let stale = opts.staleOnce ?? false;
  const calls: string[] = [];
  let head = HEAD;
  const api = {
    async state() {
      calls.push("state");
      if (opts.reorgedHead) head = opts.reorgedHead;
      return { head, safe: head, finalized: head, promoted: P, generation: 1, shards: 16 } satisfies LiveState;
    },
    async block(key: number | string, pin: BlockId) {
      calls.push(`block:${key}`);
      if (stale) {
        stale = false;
        return { stale: true as const };
      }
      const f = WINDOW.find((w) => (typeof key === "number" ? Number(w.block.number) === key : w.block.hash === key));
      if (!f || Number(f.block.number) > pin.number) return null;
      return { stale: false as const, number: Number(f.block.number), hash: f.block.hash, record: Buffer.from(encodeRecord(f)).toString("hex") };
    },
    async txBlock() {
      return null;
    },
    async witness() {
      return null;
    },
    async getPinned() {
      return { stale: false as const, block: null, value: null };
    },
    async getPinnedMany(keys: unknown[]) {
      return { stale: false as const, values: keys.map(() => ({ block: null, value: null })) };
    },
    async scanPinned() {
      return { stale: false as const, slots: {} };
    },
  } as LiveApi;
  return { api, calls };
}

/** The blooms object as the daemon encodes it (services/internal/core/daemon_records.go encodeLiveBlooms). */
function encodeBlooms(first: number, last: number, blooms: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(32 + blooms.length * 256);
  const v = new DataView(out.buffer);
  out.set(new TextEncoder().encode("NRPCLBLM"), 0);
  v.setUint16(8, 1, true);
  v.setBigUint64(12, BigInt(first), true);
  v.setBigUint64(20, BigInt(last), true);
  v.setUint32(28, blooms.length, true);
  blooms.forEach((b, i) => out.set(b, 32 + i * 256));
  return out;
}

interface DocOptions {
  /** The blooms object: as the daemon writes it, with a wrong digest, covering the wrong blocks, or none (an older daemon). */
  blooms?: "ok" | "bad-digest" | "short" | "none";
  /** null leaves the block list out (a document from an older daemon, under its own head hash:
   * a list parsed earlier for the window's head would still apply to it). */
  listed?: Fixture[] | null;
}
/** The head an older daemon's document names: the same block under a hash no list was parsed for. */
const OLDER_HEAD: BlockId = { number: HEAD.number, hash: `0x${"ee".repeat(32)}` };

async function bucket(now: number, opts: DocOptions) {
  const objects = new Map(OBJECTS);
  for (const f of WINDOW) objects.set(liveRecordKey(PREFIX, Number(f.block.number), f.block.hash), encodeRecord(f));
  const listed = opts.listed === undefined ? WINDOW : opts.listed;
  const head = listed ? HEAD : OLDER_HEAD;
  const doc: Record<string, unknown> = { version: 1, head, safe: head, finalized: head, promoted: JUST_BELOW, generation: 1, written_at: new Date(now - 500).toISOString() };
  if (listed) {
    doc.blocks = { first: FIRST, hashes: listed.map((f) => f.block.hash) };
    const mode = opts.blooms ?? "ok";
    if (mode !== "none") {
      const blooms = listed.map((f) => unhex(f.block.logsBloom));
      const bytes = mode === "short" ? encodeBlooms(FIRST, FIRST, blooms.slice(0, 1)) : encodeBlooms(FIRST, HEAD.number, blooms);
      const key = `${PREFIX}/live/blooms/${String(FIRST).padStart(20, "0")}-${String(HEAD.number).padStart(20, "0")}-${HEAD.hash.slice(2)}-${mode}.bin`;
      objects.set(key, bytes);
      doc.log_blooms = { key, bytes: bytes.length, sha256: mode === "bad-digest" ? "00".repeat(32) : toHex(await sha256(bytes)) };
    }
  }
  objects.set(`${PREFIX}/${POINTERS_KEY}`, new TextEncoder().encode(JSON.stringify(doc)));
  return new MemorySource(objects);
}

async function open(api: LiveApi, opts: DocOptions = {}) {
  const now = Date.now() + Math.random() * 1e12;
  const source = await bucket(now, opts);
  const chain = await Chain.open(new Archive(source, PREFIX), new Live(api, { source, prefix: PREFIX, archive: source }), now);
  return { chain, source };
}
const recordReads = (source: MemorySource) => source.reads.filter((r) => r.key.includes("/live/records/")).map((r) => r.key);
const bloomReads = (source: MemorySource) => source.reads.filter((r) => r.key.includes("/live/blooms/")).length;
const scan = (pred: (l: Log) => boolean) => WINDOW_LOGS.filter(pred);

describe("eth_getLogs over the live window", () => {
  test("the blooms admit only the blocks that may match, and only those records are read", async () => {
    const { api, calls } = fakeLive();
    const { chain, source } = await open(api);
    const got = await call(chain, "eth_getLogs", { fromBlock: hex(FIRST), toBlock: "latest", address: ONLY_FIRST });
    expect(got).toEqual(scan((l) => l.address === ONLY_FIRST));
    expect(got.length).toBeGreaterThan(0);
    expect(recordReads(source)).toEqual([liveRecordKey(PREFIX, FIRST, WINDOW[0]!.block.hash)]);
    expect(bloomReads(source)).toBe(1);
    expect(calls).toEqual([]);
    // A second query at the same head: the blooms object is kept per isolate.
    const again = await open(api);
    expect(await call(again.chain, "eth_getLogs", { fromBlock: hex(FIRST), toBlock: "latest", address: ONLY_FIRST })).toEqual(got);
    expect(bloomReads(again.source)).toBe(0);
    expect(recordReads(again.source)).toEqual([]);
    // An address nowhere in the window reads nothing at all.
    expect(await call(again.chain, "eth_getLogs", { fromBlock: hex(FIRST), toBlock: "latest", address: `0x${"11".repeat(20)}` })).toEqual([]);
    expect(recordReads(again.source)).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("results equal a full scan for topic and combined filters, across the archive boundary", async () => {
    const { api, calls } = fakeLive();
    const { chain } = await open(api);
    expect(await call(chain, "eth_getLogs", { fromBlock: hex(FIRST), toBlock: "latest", topics: [TRANSFER] })).toEqual(scan((l) => l.topics[0] === TRANSFER));
    const some = [...new Set(WINDOW_LOGS.map((l) => l.address))].slice(0, 3);
    expect(await call(chain, "eth_getLogs", { fromBlock: hex(FIRST), toBlock: "latest", address: some, topics: [TRANSFER] })).toEqual(scan((l) => some.includes(l.address) && l.topics[0] === TRANSFER));
    expect(await call(chain, "eth_getLogs", { fromBlock: hex(FIRST), toBlock: "latest" })).toEqual(WINDOW_LOGS);
    expect(calls).toEqual([]);
  });

  test("candidates: the blooms narrow; a missing, wrong or short blooms object admits every block", async () => {
    const admits = bloomAdmits([{ values: [unhex(ONLY_FIRST)] }]);
    const all = WINDOW.map((f) => Number(f.block.number));
    const { chain } = await open(fakeLive().api);
    expect(await chain.liveLogBlocks(FIRST, HEAD.number, admits)).toEqual([FIRST]);
    expect(await chain.liveLogBlocks(FIRST, HEAD.number, bloomAdmits([]))).toEqual(all);
    expect(await chain.liveLogBlocks(FIRST, HEAD.number + 5, admits)).toEqual([FIRST]);
    expect(await chain.liveLogBlocks(HEAD.number + 1, HEAD.number + 5, admits)).toEqual([]);
    for (const blooms of ["none", "bad-digest", "short"] as const) {
      const { chain } = await open(fakeLive().api, { blooms });
      expect(await chain.liveLogBlocks(FIRST, HEAD.number, admits)).toEqual(all);
    }
    // A document without the list at all (an older daemon): every block, through the binding.
    const { api, calls } = fakeLive();
    const older = await open(api, { listed: null });
    expect(await older.chain.liveLogBlocks(FIRST, HEAD.number, admits)).toEqual(all);
    expect(await call(older.chain, "eth_getLogs", { fromBlock: hex(FIRST), toBlock: "latest", address: ONLY_FIRST })).toEqual(scan((l) => l.address === ONLY_FIRST));
    expect(calls).toEqual(all.map((n) => `block:${n}`));
  });

  test("a stale pin is replaced once and the rest of the window is read under the new head", async () => {
    // No list: reads go to the binding, which says stale once; state() then names the same head.
    const { api, calls } = fakeLive({ staleOnce: true });
    const { chain } = await open(api, { listed: null });
    expect(await call(chain, "eth_getLogs", { fromBlock: hex(FIRST), toBlock: "latest", topics: [TRANSFER] })).toEqual(scan((l) => l.topics[0] === TRANSFER));
    // After state() the head is the window's real one, whose list this isolate parsed in an earlier
    // test: the retry reads the records, so the binding sees no further block call.
    expect(calls).toEqual([`block:${FIRST}`, `block:${HEAD.number}`, "state"]);
    // A reorg to a head below the window's last block drops that block from the answer.
    const reorged: BlockId = { number: FIRST, hash: WINDOW[0]!.block.hash };
    const r = fakeLive({ staleOnce: true, reorgedHead: reorged });
    const second = await open(r.api, { listed: null });
    expect(await call(second.chain, "eth_getLogs", { fromBlock: hex(FIRST), toBlock: "latest" })).toEqual(logsOf(WINDOW[0]!));
    expect(second.chain.state?.head).toEqual(reorged);
    // A second stale answer is an error, as for any live read (the re-pinned head has no list here).
    const twice = fakeLive({ staleOnce: true, reorgedHead: { number: HEAD.number, hash: `0x${"cd".repeat(32)}` } });
    let stales = 2;
    const block = twice.api.block.bind(twice.api);
    twice.api.block = async (key, pin) => (stales-- > 0 ? { stale: true } : block(key, pin));
    const third = await open(twice.api, { listed: null });
    await expect(call(third.chain, "eth_getLogs", { fromBlock: hex(FIRST), toBlock: "latest" })).rejects.toThrow(/reorg/);
  });
});

describe("blooms objects", () => {
  test("parse checks the header, the count and the length; blooms are addressed by block", () => {
    const blooms = WINDOW.map((f) => unhex(f.block.logsBloom));
    const table = BloomTable.parse(encodeBlooms(FIRST, HEAD.number, blooms))!;
    expect(table).not.toBeNull();
    expect([table.first, table.last]).toEqual([FIRST, HEAD.number]);
    WINDOW.forEach((f, i) => expect(table.bloom(Number(f.block.number))).toEqual(blooms[i]));
    expect(table.bloom(FIRST - 1)).toBeNull();
    expect(table.bloom(HEAD.number + 1)).toBeNull();
    const bytes = encodeBlooms(FIRST, HEAD.number, blooms);
    expect(BloomTable.parse(bytes.subarray(0, bytes.length - 1))).toBeNull();
    expect(BloomTable.parse(encodeBlooms(FIRST, HEAD.number + 1, blooms))).toBeNull();
    expect(BloomTable.parse(new Uint8Array(10))).toBeNull();
    const wrongMagic = bytes.slice();
    wrongMagic[0] = 0x58;
    expect(BloomTable.parse(wrongMagic)).toBeNull();
    const v2 = bytes.slice();
    v2[8] = 2;
    expect(BloomTable.parse(v2)).toBeNull();
  });
});
