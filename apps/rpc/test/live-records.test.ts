// Live block records and the transaction index in R2 (docs/storage.md, "Live records"): a
// request pinned from live/HEAD.json reads the window's blocks and transactions from the
// bucket, and the service binding only answers what the document and the objects cannot.
// This file keeps its own module instance of src/live.ts (vitest isolates files), so the
// isolate caches start empty here; the first test reads block 23,000,001 from the bucket, and
// the second has block 23,000,000, which no earlier test touched, missing from it.

import { beforeEach, describe, expect, test } from "vitest";
import { Archive, sha256 } from "../src/archive/archive";
import { MemorySource } from "../src/archive/source";
import { Chain, hashLocations } from "../src/chain";
import type { BlockId, LiveApi, LiveState } from "../src/live";
import { Live, liveRecordKey, POINTERS_KEY, TxTable } from "../src/live";
import { METHODS } from "../src/methods";
import { buildArchive, PREFIX } from "./archive";
import { encodeRecord, fixtures, type Fixture } from "./encode";

const ALL = fixtures();
const ARCHIVED = ALL.filter((f) => Number(f.block.number) <= 20_000_001);
const WINDOW = ALL.filter((f) => Number(f.block.number) > 20_000_001);
const OBJECTS = buildArchive(ARCHIVED);
const P = id(ARCHIVED.at(-1)!);
const HEAD = id(WINDOW.at(-1)!);
const FIRST = Number(WINDOW[0]!.block.number);
/** A promoted pointer just below the window, so the document's list is complete (starts at P+1). */
const JUST_BELOW: BlockId = { number: FIRST - 1, hash: `0x${"ab".repeat(32)}` };
const hex = (n: number) => "0x" + n.toString(16);
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(Buffer.from(s.replace(/^0x/, ""), "hex"));
function id(f: Fixture): BlockId {
  return { number: Number(f.block.number), hash: f.block.hash };
}
const call = (chain: Chain, method: string, ...params: unknown[]) => METHODS[method]!(chain, params, { chainId: 1 });

/** A fake LiveReads: answers WINDOW, records every call, and can answer stale once. */
function fakeLive(opts: { promoted?: BlockId; staleOnce?: "block" | "tx"; reorgedHead?: BlockId } = {}) {
  let stale = opts.staleOnce;
  const calls: string[] = [];
  let head = HEAD;
  const api: LiveApi = {
    async state() {
      calls.push("state");
      if (opts.reorgedHead) head = opts.reorgedHead;
      return { head, safe: head, finalized: head, promoted: opts.promoted ?? P, generation: 1, shards: 16 } satisfies LiveState;
    },
    async block(key, pin) {
      calls.push(`block:${key}`);
      if (stale === "block") {
        stale = undefined;
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
      calls.push(`tx:${hash}`);
      if (stale === "tx") {
        stale = undefined;
        return { stale: true };
      }
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

/** The transaction index object as the daemon encodes it (services/internal/core/daemon_records.go). */
function encodeIndex(first: number, last: number, entries: { prefix: Uint8Array; offset: number }[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => Buffer.compare(a.prefix, b.prefix) || a.offset - b.offset);
  const out = new Uint8Array(32 + sorted.length * 12);
  const v = new DataView(out.buffer);
  out.set(new TextEncoder().encode("NRPCLIDX"), 0);
  v.setUint16(8, 1, true);
  v.setBigUint64(12, BigInt(first), true);
  v.setBigUint64(20, BigInt(last), true);
  v.setUint32(28, sorted.length, true);
  sorted.forEach((e, i) => {
    out.set(e.prefix.subarray(0, 8), 32 + i * 12);
    v.setUint32(40 + i * 12, e.offset, true);
  });
  return out;
}

function windowEntries(blocks: Fixture[], first: number) {
  return blocks.flatMap((f) => f.block.transactions.map((t: { hash: string }) => ({ prefix: unhex(t.hash), offset: Number(f.block.number) - first })));
}

interface DocOptions {
  /** The head the document names (the window's by default). */
  head?: BlockId;
  /** The promoted pointer the document names (P by default: the list is then incomplete). */
  promoted?: BlockId;
  /** Blocks the document lists (the whole window by default); null leaves `blocks` out. */
  listed?: Fixture[] | null;
  /** Records written to the bucket (the whole window by default). */
  records?: Fixture[];
  /** The index object: as the daemon writes it, with a wrong digest, or none. */
  index?: "ok" | "bad-digest" | "collision" | "none";
}

/** The bucket: the archive, the records, the index object and live/HEAD.json. */
async function bucket(now: number, opts: DocOptions = {}) {
  const objects = new Map(OBJECTS);
  for (const f of opts.records ?? WINDOW) objects.set(liveRecordKey(PREFIX, Number(f.block.number), f.block.hash), encodeRecord(f));
  const listed = opts.listed === undefined ? WINDOW : opts.listed;
  const promoted = opts.promoted ?? P;
  const head = opts.head ?? HEAD;
  const doc: Record<string, unknown> = { version: 1, head, safe: head, finalized: head, promoted, generation: 1, written_at: new Date(now - 500).toISOString() };
  if (listed) {
    const first = Number(listed[0]!.block.number);
    doc.blocks = { first, hashes: listed.map((f) => f.block.hash) };
    const mode = opts.index ?? "ok";
    if (mode !== "none") {
      const entries = windowEntries(listed, first);
      if (mode === "collision") entries.push({ prefix: entries[0]!.prefix, offset: 1 });
      const bytes = encodeIndex(first, HEAD.number, entries);
      const key = `${PREFIX}/live/index/${String(first).padStart(20, "0")}-${String(HEAD.number).padStart(20, "0")}-${HEAD.hash.slice(2)}-${mode}.bin`;
      objects.set(key, bytes);
      doc.tx_index = { key, bytes: bytes.length, sha256: mode === "bad-digest" ? "00".repeat(32) : toHex(await sha256(bytes)) };
    }
  }
  objects.set(`${PREFIX}/${POINTERS_KEY}`, new TextEncoder().encode(JSON.stringify(doc)));
  return new MemorySource(objects);
}

async function open(api: LiveApi, opts: DocOptions = {}) {
  const now = Date.now() + Math.random() * 1e12;
  const source = await bucket(now, opts);
  const archive = new Archive(source, PREFIX);
  const chain = await Chain.open(archive, new Live(api, { source, prefix: PREFIX, archive: source }), now);
  return { chain, source };
}
const recordReads = (source: MemorySource) => source.reads.filter((r) => r.key.includes("/live/records/")).map((r) => r.key);
const liveTx = (f: Fixture, i: number) => f.block.transactions[i] as { hash: string };

// These tests count the binding's calls for archived hashes, which the isolate's verified
// locations (src/chain.ts) would otherwise answer after the first test.
beforeEach(() => hashLocations.clear());

describe("live records in R2", () => {
  test("blocks by number and by hash come from the records, not from the live Worker", async () => {
    const { api, calls } = fakeLive({ promoted: JUST_BELOW });
    const { chain, source } = await open(api, { promoted: JUST_BELOW });
    expect(await call(chain, "eth_getBlockByNumber", "latest", true)).toEqual(WINDOW[1]!.block);
    expect(await call(chain, "eth_getBlockByHash", WINDOW[1]!.block.hash, false)).toMatchObject({ number: WINDOW[1]!.block.number });
    expect(await call(chain, "eth_getBlockReceipts", "latest")).toEqual(WINDOW[1]!.receipts);
    expect(calls).toEqual([]);
    const key = liveRecordKey(PREFIX, HEAD.number, HEAD.hash);
    expect(recordReads(source)).toEqual([key]);
    // Another request: the isolate keeps the record; nothing is read again.
    const second = await open(api, { promoted: JUST_BELOW });
    expect(await call(second.chain, "eth_getBlockByNumber", "latest", false)).toMatchObject({ hash: HEAD.hash });
    expect(recordReads(second.source)).toEqual([]);
    expect(calls).toEqual([]);
    // A hash the complete list lacks is not in the window: the archive answers, the binding is not asked.
    expect(await call(chain, "eth_getBlockByHash", ARCHIVED[0]!.block.hash, false)).toMatchObject({ number: ARCHIVED[0]!.block.number });
    expect(await call(chain, "eth_getBlockByHash", `0x${"77".repeat(32)}`, false)).toBeNull();
    expect(calls).toEqual([]);
  });

  test("a missing record and a bad index fall back to the service binding", async () => {
    // Block 23,000,000 has no record in the bucket: the binding answers it (and only it).
    const { api, calls } = fakeLive({ promoted: JUST_BELOW });
    const { chain, source } = await open(api, { promoted: JUST_BELOW, records: [WINDOW[1]!], index: "bad-digest" });
    expect(await call(chain, "eth_getBlockByNumber", hex(FIRST), false)).toMatchObject({ hash: WINDOW[0]!.block.hash });
    expect(calls).toEqual([`block:${FIRST}`]);
    expect(recordReads(source)).toEqual([]);
    // The index object does not match its digest: transaction lookups ask the binding.
    const tx = liveTx(WINDOW[1]!, 3);
    expect(await call(chain, "eth_getTransactionByHash", tx.hash)).toEqual(tx);
    expect(calls).toContain(`tx:${tx.hash}`);
  });

  test("transactions by hash resolve through the index", async () => {
    const { api, calls } = fakeLive({ promoted: JUST_BELOW });
    const { chain } = await open(api, { promoted: JUST_BELOW });
    const tx = liveTx(WINDOW[1]!, 7);
    expect(await call(chain, "eth_getTransactionByHash", tx.hash)).toEqual(tx);
    expect(await call(chain, "eth_getTransactionReceipt", tx.hash)).toEqual(WINDOW[1]!.receipts[7]);
    // An archived transaction and an unknown one are not in the window: no binding call either.
    const old = liveTx(ARCHIVED[0]!, 0);
    expect(await call(chain, "eth_getTransactionByHash", old.hash)).toEqual(old);
    expect(await call(chain, "eth_getTransactionByHash", `0x${"66".repeat(32)}`)).toBeNull();
    expect(calls).toEqual([]);
  });

  test("a list that does not reach P+1 answers its blocks and leaves the rest to the binding", async () => {
    // The daemon caps the list; here P is far below the window, so the list is incomplete.
    const { api, calls } = fakeLive();
    const { chain } = await open(api);
    expect(await call(chain, "eth_getBlockByNumber", "latest", false)).toMatchObject({ hash: HEAD.hash });
    expect(calls).toEqual([]);
    expect(await call(chain, "eth_getBlockByNumber", hex(FIRST - 1), false)).toBeNull();
    expect(calls).toEqual([`block:${FIRST - 1}`]);
    const tx = liveTx(WINDOW[1]!, 1);
    expect(await call(chain, "eth_getTransactionByHash", tx.hash)).toEqual(tx);
    const old = liveTx(ARCHIVED[0]!, 0);
    expect(await call(chain, "eth_getTransactionByHash", old.hash)).toEqual(old);
    expect(calls).toEqual([`block:${FIRST - 1}`, `tx:${old.hash}`]);
  });

  test("two transactions sharing an index prefix are told apart by the live Worker", async () => {
    const { api, calls } = fakeLive({ promoted: JUST_BELOW });
    const { chain } = await open(api, { promoted: JUST_BELOW, index: "collision" });
    const tx = liveTx(WINDOW[0]!, 0);
    expect(await call(chain, "eth_getTransactionByHash", tx.hash)).toEqual(tx);
    expect(calls).toEqual([`tx:${tx.hash}`]);
  });

  test("a document without the list (an older daemon) keeps every read on the binding", async () => {
    // A head hash this isolate has no list for (a list parsed earlier for the same head would
    // still apply: the hash fixes the chain below it).
    const { api, calls } = fakeLive();
    const { chain, source } = await open(api, { listed: null, head: { number: HEAD.number, hash: `0x${"ee".repeat(32)}` } });
    expect(await call(chain, "eth_getBlockByNumber", "latest", false)).toMatchObject({ hash: HEAD.hash });
    const tx = liveTx(WINDOW[1]!, 2);
    expect(await call(chain, "eth_getTransactionByHash", tx.hash)).toEqual(tx);
    expect(calls).toEqual([`block:${HEAD.number}`, `tx:${tx.hash}`]);
    expect(recordReads(source)).toEqual([]);
  });

  test("a reorg: the stale pin is replaced through the binding, and the new pin reads through it", async () => {
    // The document (and its list) still name the removed head; the binding knows the new one.
    const reorged: BlockId = { number: HEAD.number, hash: `0x${"cd".repeat(32)}` };
    const { api, calls } = fakeLive({ staleOnce: "tx", reorgedHead: reorged });
    const { chain } = await open(api);
    expect(chain.pointers().latest).toBe(HEAD.number);
    const old = liveTx(ARCHIVED[0]!, 0);
    // Incomplete list: the lookup asks the binding, which says stale; state() then names the new head.
    expect(await call(chain, "eth_getTransactionByHash", old.hash)).toEqual(old);
    expect(calls).toEqual([`tx:${old.hash}`, "state", `tx:${old.hash}`]);
    expect(chain.state?.head).toEqual(reorged);
    // The new head came from state(), not from a document: the listed records are not used for it.
    expect(await call(chain, "eth_getBlockByNumber", hex(FIRST), false)).toMatchObject({ hash: WINDOW[0]!.block.hash });
    expect(calls.at(-1)).toBe(`block:${FIRST}`);
  });
});

describe("transaction index objects", () => {
  test("parse checks the header and the length; lookups find every entry and only those", () => {
    const entries = windowEntries(WINDOW, FIRST);
    const table = TxTable.parse(encodeIndex(FIRST, HEAD.number, entries))!;
    expect(table).not.toBeNull();
    expect([table.first, table.last, table.count]).toEqual([FIRST, HEAD.number, entries.length]);
    for (const f of WINDOW) for (const t of f.block.transactions as { hash: string }[]) expect(table.blocks(unhex(t.hash))).toEqual([Number(f.block.number)]);
    expect(table.blocks(unhex(`0x${"00".repeat(32)}`))).toEqual([]);
    expect(table.blocks(unhex(`0x${"ff".repeat(32)}`))).toEqual([]);
    const empty = TxTable.parse(encodeIndex(5, 5, []))!;
    expect(empty.count).toBe(0);
    expect(empty.blocks(unhex(`0x${"11".repeat(32)}`))).toEqual([]);
    const bytes = encodeIndex(FIRST, HEAD.number, entries);
    expect(TxTable.parse(bytes.subarray(0, bytes.length - 1))).toBeNull();
    expect(TxTable.parse(new Uint8Array(10))).toBeNull();
    const wrongMagic = bytes.slice();
    wrongMagic[0] = 0x58;
    expect(TxTable.parse(wrongMagic)).toBeNull();
  });
});
