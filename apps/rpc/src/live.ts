// The live window (blocks P+1 to head) through the chain's `nullrpc-live-{id}` Worker, service
// binding with entrypoint `LiveReads` (apps/live/src/index.ts). Every read carries the head pin;
// `{stale: true}` means a reorg removed it, and the caller re-reads state() and retries.
//
// The pointers (head, safe, finalized, P) normally come from `{prefix}/live/HEAD.json` in R2
// (docs/storage.md, "Live pointers"), which the daemon rewrites after every head move: read
// through the ARCHIVE binding, shared per isolate for 2 s and per data center through the edge
// cache for 2 s, so most requests reach no Durable Object. The service binding's state() is the
// authority: it answers when the object is missing, malformed or older than a minute (an older
// daemon, or one that stopped), and always after a stale answer, since a pin a reorg removed must
// be replaced by the head the live Worker has now, not by a copy up to 2 s old.
//
// Block records above P are in R2 too (docs/storage.md, "Live records"): the daemon writes
// `live/records/{number}-{hash}.bin` before it writes the block to the live Worker, and the
// pointers document lists the window's hashes by number and names the transaction index and
// the header logs blooms of the same blocks. A block read with a pin taken from that document
// reads the record through the archive's edge cache (immutable per hash, verified by the caller
// against the hash the document gave); a transaction lookup reads the index; eth_getLogs tests
// the blooms and reads only the admitted records. The service binding answers whatever the
// document and the objects cannot: a pin that came from state() (after a stale answer), a
// block outside the listed range, a missing record, or an index that fails its digest; without
// usable blooms every block of the window is read.

import { sha256 } from "./archive/archive";
import { Lru, SizedLru } from "./archive/lru";
import type { Source } from "./archive/source";
import type { ObjectRef } from "./archive/types";

export interface BlockId {
  number: number;
  /** 0x-prefixed lowercase. */
  hash: string;
}

export interface LiveState {
  head: BlockId | null;
  safe: BlockId | null;
  finalized: BlockId | null;
  promoted: BlockId | null;
  generation: number;
  shards: number | null;
}

type Stale = { stale: true };

/** The LiveReads entrypoint as the RPC Worker calls it (JS RPC over the service binding). */
export interface LiveApi {
  state(): Promise<LiveState>;
  block(numberOrHash: number | string, pin: BlockId): Promise<Stale | { stale: false; number: number; hash: string; record: string } | null>;
  witness(number: number, pin: BlockId): Promise<Stale | { stale: false; witness: string } | null>;
  txBlock(txHash: string, pin: BlockId): Promise<Stale | { stale: false; number: number } | null>;
  getPinned(domain: number, keyHex: string, n: number, pin: BlockId): Promise<Stale | { stale: false; block: number | null; value: string | null }>;
  /** getPinned for many keys in one call (at most 1024), answered in order; stale as a whole. */
  getPinnedMany(keys: { domain: number; key: string }[], n: number, pin: BlockId): Promise<Stale | { stale: false; values: { block: number | null; value: string | null }[] }>;
  scanPinned(addressHex: string, n: number, pin: BlockId): Promise<Stale | { stale: false; slots: Record<string, string> }>;
}

export class StaleError extends Error {
  constructor() {
    super("the pinned head was removed by a reorg");
  }
}

/** The pointers object, under the archive prefix. */
export const POINTERS_KEY = "live/HEAD.json";
/** Pointers from R2 are shared per isolate and per data center (edge cache) this long. */
export const POINTERS_TTL_MS = 2_000;
/** Pointers written longer ago than this are ignored: the daemon writing them has stopped. */
export const POINTERS_MAX_AGE_MS = 60_000;
/** state() from the service binding is shared per isolate for half a block time (storage.md, "ChainDO"). */
const STATE_TTL_MS = 6_000;
const states = new WeakMap<LiveApi, { at: number; ttl: number; state: Promise<LiveState> }>();

/** The edge cache as the pointers use it: `caches.default` in the Worker, a stand-in in tests. */
export interface PointerCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

/** Where live/HEAD.json is read from: the archive bucket and prefix, and the data center's cache. */
export interface PointerSource {
  /** The bucket, uncached: live/HEAD.json changes. */
  source: Source;
  prefix: string;
  cache?: PointerCache | null;
  /** The edge-cached bucket for the immutable records and index objects; `source` when absent. */
  archive?: Source;
}

/** Record keys: `live/records/{number:020}-{hash}.bin` under the archive prefix. */
export function liveRecordKey(prefix: string, number: number, hash: string): string {
  return `${prefix}/live/records/${String(number).padStart(20, "0")}-${hash.replace(/^0x/, "").toLowerCase()}.bin`;
}

/**
 * The window as one pointers document listed it: the hashes of `first` to the head, keyed by
 * the head's hash (a hash fixes the chain below it, so any document with that head agrees).
 * `complete` when the list starts at P+1: a hash or transaction the list lacks is then not in
 * the window, and the service binding is not asked.
 */
export interface LiveIndex {
  first: number;
  /** 0x-prefixed lowercase, `hashes[n - first]`. */
  hashes: string[];
  byHash: Map<string, number>;
  complete: boolean;
  /** The transaction index object of the same blocks, or null when the daemon wrote none. */
  txIndex: ObjectRef | null;
  /** The logs blooms object of the same blocks, or null when the daemon wrote none (an older one). */
  blooms: ObjectRef | null;
}

/** live/HEAD.json as the daemon writes it (services/internal/core/daemon_pointers.go). */
interface PointersDoc {
  version: number;
  head: BlockId | null;
  safe: BlockId | null;
  finalized: BlockId | null;
  promoted: BlockId | null;
  generation: number;
  written_at: string;
  blocks?: { first: number; hashes: string[] } | null;
  tx_index?: ObjectRef | null;
  log_blooms?: ObjectRef | null;
}

function blockId(v: unknown): BlockId | null {
  const b = v as BlockId | null | undefined;
  if (!b || typeof b !== "object" || !Number.isSafeInteger(b.number) || b.number < 0 || typeof b.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(b.hash)) return null;
  return { number: b.number, hash: b.hash.toLowerCase() };
}

/** The pointers in `raw`, or null when they are unusable or written more than a minute before `now`. */
export function parsePointers(raw: Uint8Array, now: number): LiveState | null {
  return parseDoc(raw, now)?.state ?? null;
}

/** The pointers and, when the document lists the window's blocks consistently, their index. */
function parseDoc(raw: Uint8Array, now: number): { state: LiveState; index: LiveIndex | null } | null {
  let doc: PointersDoc;
  try {
    doc = JSON.parse(new TextDecoder().decode(raw)) as PointersDoc;
  } catch {
    return null;
  }
  if (!doc || doc.version !== 1 || !Number.isSafeInteger(doc.generation)) return null;
  const head = blockId(doc.head);
  const promoted = blockId(doc.promoted);
  if (!head || !promoted) return null;
  const at = Date.parse(doc.written_at);
  if (!Number.isFinite(at) || now - at > POINTERS_MAX_AGE_MS) return null;
  const state: LiveState = { head, safe: blockId(doc.safe), finalized: blockId(doc.finalized), promoted, generation: doc.generation, shards: null };
  return { state, index: parseIndex(doc, head, promoted) };
}

function objectRef(v: unknown): ObjectRef | null {
  const r = v as ObjectRef | null | undefined;
  if (!r || typeof r !== "object" || typeof r.key !== "string" || !Number.isSafeInteger(r.bytes) || r.bytes < 0 || typeof r.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.sha256)) return null;
  return { key: r.key, bytes: r.bytes, sha256: r.sha256 };
}

/** The `blocks` list of a document: usable only when it ends at the head and lies above P. */
function parseIndex(doc: PointersDoc, head: BlockId, promoted: BlockId): LiveIndex | null {
  const b = doc.blocks;
  if (!b || typeof b !== "object" || !Number.isSafeInteger(b.first) || b.first <= promoted.number || !Array.isArray(b.hashes)) return null;
  if (b.first + b.hashes.length !== head.number + 1) return null;
  const hashes: string[] = [];
  const byHash = new Map<string, number>();
  for (const h of b.hashes) {
    if (typeof h !== "string" || !/^(0x)?[0-9a-fA-F]{64}$/.test(h)) return null;
    const hash = (h.startsWith("0x") ? h : `0x${h}`).toLowerCase();
    byHash.set(hash, b.first + hashes.length);
    hashes.push(hash);
  }
  if (hashes.length > 0 && hashes[hashes.length - 1] !== head.hash) return null;
  return { first: b.first, hashes, byHash, complete: b.first === promoted.number + 1, txIndex: objectRef(doc.tx_index), blooms: objectRef(doc.log_blooms) };
}

// Records are immutable per block hash, so they are kept with no expiry.
const records = new Lru<string, Uint8Array>(512);
// The window's index per head hash, from the documents this isolate parsed.
const indexes = new Lru<string, LiveIndex>(16);
// Transaction tables and bloom tables by object key (immutable; one of each per head move).
const tables = new Lru<string, Promise<TxTable | null>>(4);
const bloomTables = new Lru<string, Promise<BloomTable | null>>(4);

/** Header of a transaction index object (docs/storage.md, "Live records"). */
const TX_INDEX_MAGIC = "NRPCLIDX";
const TX_INDEX_HEADER = 32;
const TX_INDEX_ENTRY = 12;
/** Transaction index objects larger than this are refused. */
const TX_INDEX_MAX_BYTES = 64 * 1024 * 1024;
/** Header of a logs blooms object (docs/storage.md, "Live records"). */
const BLOOMS_MAGIC = "NRPCLBLM";
const BLOOMS_HEADER = 32;
const BLOOM_BYTES = 256;
/** Blooms objects larger than this are refused (1,024 blocks are 256 KiB). */
const BLOOMS_MAX_BYTES = 4 * 1024 * 1024;

/** A parsed blooms object: the header logs bloom of every block of `first` to `last`, in order. */
export class BloomTable {
  constructor(
    readonly first: number,
    readonly last: number,
    private readonly body: Uint8Array,
  ) {}

  /** The blooms object `raw`, or null when it is not one. */
  static parse(raw: Uint8Array): BloomTable | null {
    if (raw.length < BLOOMS_HEADER || new TextDecoder().decode(raw.subarray(0, 8)) !== BLOOMS_MAGIC) return null;
    const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    if (v.getUint16(8, true) !== 1) return null;
    const first = Number(v.getBigUint64(12, true));
    const last = Number(v.getBigUint64(20, true));
    const count = v.getUint32(28, true);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first || count !== last - first + 1 || raw.length !== BLOOMS_HEADER + count * BLOOM_BYTES) return null;
    return new BloomTable(first, last, raw.subarray(BLOOMS_HEADER));
  }

  /** Block `n`'s bloom (256 bytes), or null when the table does not cover it. */
  bloom(n: number): Uint8Array | null {
    if (n < this.first || n > this.last) return null;
    const at = (n - this.first) * BLOOM_BYTES;
    return this.body.subarray(at, at + BLOOM_BYTES);
  }
}

/** A parsed transaction index: entries of 8 hash bytes and a uint32 block offset, sorted by hash. */
export class TxTable {
  constructor(
    readonly first: number,
    readonly last: number,
    private readonly entries: Uint8Array,
    readonly count: number,
  ) {}

  /** The index object `raw`, or null when it is not one. */
  static parse(raw: Uint8Array): TxTable | null {
    if (raw.length < TX_INDEX_HEADER || new TextDecoder().decode(raw.subarray(0, 8)) !== TX_INDEX_MAGIC) return null;
    const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    if (v.getUint16(8, true) !== 1) return null;
    const first = Number(v.getBigUint64(12, true));
    const last = Number(v.getBigUint64(20, true));
    const count = v.getUint32(28, true);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first || raw.length !== TX_INDEX_HEADER + count * TX_INDEX_ENTRY) return null;
    return new TxTable(first, last, raw.subarray(TX_INDEX_HEADER), count);
  }

  /** The block numbers of the entries whose 8-byte prefix is `hash`'s (several on a collision). */
  blocks(hash: Uint8Array): number[] {
    const e = this.entries;
    const cmp = (i: number): number => {
      const at = i * TX_INDEX_ENTRY;
      for (let k = 0; k < 8; k++) {
        const d = (e[at + k] as number) - (hash[k] as number);
        if (d !== 0) return d;
      }
      return 0;
    };
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cmp(mid) < 0) lo = mid + 1;
      else hi = mid;
    }
    const out: number[] = [];
    for (let i = lo; i < this.count && cmp(i) === 0; i++) {
      const at = i * TX_INDEX_ENTRY + 8;
      const offset = ((e[at] as number) | ((e[at + 1] as number) << 8) | ((e[at + 2] as number) << 16) | ((e[at + 3] as number) << 24)) >>> 0;
      out.push(this.first + offset);
    }
    return out;
  }
}

/** Most keys per getPinnedMany call (apps/live/src/index.ts). */
export const LIVE_BATCH = 1024;

/**
 * The isolate's cache of the window's answers (docs/storage.md, "Reads above P", "Caches"):
 * a value at block n under pin (M, H) is fixed by H (the hash fixes the chain below it), and
 * a "no row" answer stays right across a promotion (the key is then unchanged since the new
 * P too), so both are kept per pin hash, block and key and served without a shard call.
 * Witnesses likewise, per pin hash and block. One cache per service binding object (one per
 * isolate), so tests with their own fakes do not share entries.
 */
export const STATE_CACHE_ENTRIES = 32_768;
/** Values longer than this (code, mostly) are not cached; the executor keeps its own code cache. */
export const STATE_CACHE_MAX_VALUE = 4_096;
export const WITNESS_CACHE_BYTES = 32 * 1024 * 1024;

interface LiveCaches {
  /** `${pin hash}:${n}:${domain}:${key hex}` -> the bytes, or null for "no row in the window". */
  values: Lru<string, Uint8Array | null>;
  /** `${pin hash}:${n}` -> the witness bytes, or null for none. */
  witnesses: SizedLru<string, Uint8Array | null>;
  hits: number;
  misses: number;
}
const liveCaches = new WeakMap<LiveApi, LiveCaches>();

export function cachesFor(api: LiveApi): LiveCaches {
  let c = liveCaches.get(api);
  if (!c) liveCaches.set(api, (c = { values: new Lru(STATE_CACHE_ENTRIES), witnesses: new SizedLru(WITNESS_CACHE_BYTES), hits: 0, misses: 0 }));
  return c;
}

/**
 * The data center's share of the same answers, through the edge cache the pointers use: a
 * batch of at least STATE_EDGE_BATCH_MIN keys (the executor's hints wave, the same thousand
 * keys for every call at one head) is stored whole under the digest of its key list, pin and
 * block, and witnesses under pin and block. Both are fixed by the pin hash, so entries are
 * kept an hour and simply go unused once the head moves. One isolate's shard call then
 * answers every isolate in the data center for that block.
 */
export const STATE_EDGE_BATCH_MIN = 32;
export const STATE_EDGE_TTL_S = 3600;
const EDGE_ORIGIN = "https://live-state.nullrpc.invalid";

async function digest(parts: string[]): Promise<string> {
  return toHex(await sha256(new TextEncoder().encode(parts.join("\n"))));
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function fromHex(hex: string): Uint8Array {
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export class Live {
  /** Without `pointers` every state() read goes through the service binding. */
  constructor(
    private readonly api: LiveApi,
    private readonly pointers: PointerSource | null = null,
  ) {}

  /**
   * The live pointers: from live/HEAD.json in R2 when it is current, else from the service
   * binding. `fresh` bypasses every cache and asks the live Worker (after a stale answer).
   */
  state(fresh = false, now = Date.now()): Promise<LiveState> {
    const cached = states.get(this.api);
    if (!fresh && cached && now - cached.at < cached.ttl) return cached.state;
    const entry = { at: now, ttl: STATE_TTL_MS, state: Promise.resolve<LiveState | null>(null) };
    entry.state =
      fresh || !this.pointers
        ? this.api.state()
        : this.readPointers(this.pointers, now).then((s) => {
            if (!s) return this.api.state();
            entry.ttl = POINTERS_TTL_MS;
            return s;
          });
    states.set(this.api, entry as { at: number; ttl: number; state: Promise<LiveState> });
    entry.state.catch(() => states.get(this.api)?.state === entry.state && states.delete(this.api));
    return entry.state as Promise<LiveState>;
  }

  /** live/HEAD.json from the data center's cache, else from R2 (then cached for 2 s); null when unusable. */
  private async readPointers({ source, prefix, cache }: PointerSource, now: number): Promise<LiveState | null> {
    const key = `${prefix}/${POINTERS_KEY}`;
    // The cache key is a URL; the host never resolves, the entry is only ever this Worker's.
    const url = `https://live-pointers.nullrpc.invalid/${key}`;
    try {
      const hit = cache ? await cache.match(url) : undefined;
      let raw: Uint8Array | null;
      if (hit) raw = new Uint8Array(await hit.arrayBuffer());
      else {
        raw = await source.get(key);
        if (!raw) return null;
        if (cache) {
          const copy = new Response(raw.slice(), { headers: { "content-type": "application/json", "cache-control": `max-age=${POINTERS_TTL_MS / 1000}` } });
          cache.put(url, copy).catch(() => {});
        }
      }
      const parsed = parseDoc(raw, now);
      if (!parsed) return null;
      if (parsed.index) indexes.set(parsed.state.head!.hash, parsed.index);
      return parsed.state;
    } catch (e) {
      console.error(JSON.stringify({ event: "live_pointers_error", error: e instanceof Error ? e.message : String(e) }));
      return null;
    }
  }

  /**
   * A block record in the window at or below the pin, or null. From R2 when the pin's document
   * listed the block (the caller checks the record against the hash); else from the service
   * binding, which throws StaleError through this method.
   */
  async block(numberOrHash: number | string, pin: BlockId): Promise<{ number: number; hash: string; record: Uint8Array } | null> {
    const index = this.pointers ? indexes.get(pin.hash) : undefined;
    if (index) {
      const number = typeof numberOrHash === "number" ? numberOrHash : index.byHash.get(numberOrHash.toLowerCase());
      if (number === undefined) {
        if (index.complete) return null;
      } else if (number >= index.first && number <= pin.number && number < index.first + index.hashes.length) {
        const hash = index.hashes[number - index.first]!;
        const record = await this.readRecord(number, hash);
        if (record) return { number, hash, record };
      } else if (number > pin.number || (number < index.first && index.complete)) {
        return null;
      }
    }
    const r = await this.api.block(numberOrHash, pin);
    if (!r) return null;
    if (r.stale) throw new StaleError();
    let record = records.get(r.hash);
    if (!record) {
      record = fromHex(r.record);
      records.set(r.hash, record);
    }
    return { number: r.number, hash: r.hash, record };
  }

  /** The record at `live/records/…` from the isolate, the edge cache or R2; null when missing. */
  private async readRecord(number: number, hash: string): Promise<Uint8Array | null> {
    const cached = records.get(hash);
    if (cached) return cached;
    const { archive, source, prefix } = this.pointers!;
    try {
      const raw = await (archive ?? source).get(liveRecordKey(prefix, number, hash));
      if (raw) records.set(hash, raw);
      return raw;
    } catch (e) {
      console.error(JSON.stringify({ event: "live_record_error", block: number, error: e instanceof Error ? e.message : String(e) }));
      return null;
    }
  }

  /** The pin's transaction table, parsed once per isolate and checked against its reference; null when unusable. */
  private table(ref: ObjectRef): Promise<TxTable | null> {
    return this.object(ref, tables, TX_INDEX_MAX_BYTES, TxTable.parse, "live_index_error");
  }

  /**
   * An immutable per-head object (the transaction index, the blooms) read once per isolate
   * through `cache`, checked against its reference's size and digest and parsed; null when
   * unusable (not kept, so the next pin that names the object tries again).
   */
  private object<T>(ref: ObjectRef, cache: Lru<string, Promise<T | null>>, maxBytes: number, parse: (raw: Uint8Array) => T | null, event: string): Promise<T | null> {
    let p = cache.get(ref.key);
    if (!p) {
      const { archive, source } = this.pointers!;
      p = (async () => {
        if (ref.bytes > maxBytes) return null;
        const raw = await (archive ?? source).get(ref.key);
        if (!raw || raw.length !== ref.bytes || toHex(await sha256(raw)) !== ref.sha256) return null;
        return parse(raw);
      })().catch((e) => {
        console.error(JSON.stringify({ event, key: ref.key, error: e instanceof Error ? e.message : String(e) }));
        return null;
      });
      cache.set(ref.key, p);
      p.then((t) => t === null && cache.get(ref.key) === p && cache.delete(ref.key));
    }
    return p;
  }

  /**
   * The header logs blooms of the window's listed blocks under `pin`, or null when the pin's
   * document names none (an older daemon), the pin came from state(), or the object is
   * unusable or does not cover the listed blocks: the caller then reads every block.
   */
  async logBlooms(pin: BlockId): Promise<BloomTable | null> {
    const index = this.pointers ? indexes.get(pin.hash) : undefined;
    if (!index?.blooms) return null;
    const table = await this.object(index.blooms, bloomTables, BLOOMS_MAX_BYTES, BloomTable.parse, "live_blooms_error");
    return table && table.first === index.first && table.last === index.first + index.hashes.length - 1 ? table : null;
  }

  /**
   * A state value at the end of block `n` in the window: bytes (empty when absent or zero), or
   * null when the key has not changed since P (read the archive at P). Throws StaleError.
   */
  async stateValue(domain: 1 | 2 | 3, key: Uint8Array, n: number, pin: BlockId): Promise<Uint8Array | null> {
    const caches = cachesFor(this.api);
    const hex = toHex(key);
    const id = `${pin.hash}:${n}:${domain}:${hex}`;
    const cached = caches.values.get(id);
    if (cached !== undefined) {
      caches.hits++;
      return cached;
    }
    caches.misses++;
    const r = await this.api.getPinned(domain, hex, n, pin);
    if (r.stale) throw new StaleError();
    const value = r.block === null || r.value === null ? null : fromHex(r.value);
    if (value === null || value.length <= STATE_CACHE_MAX_VALUE) caches.values.set(id, value);
    return value;
  }

  /**
   * stateValue for many keys in as few calls as possible (one per LIVE_BATCH keys), answered
   * in order. Throws StaleError when any batch is stale.
   */
  async stateValues(keys: { domain: 1 | 2 | 3; key: Uint8Array }[], n: number, pin: BlockId): Promise<(Uint8Array | null)[]> {
    const caches = cachesFor(this.api);
    const hexes = keys.map((k) => toHex(k.key));
    const ids = keys.map((k, i) => `${pin.hash}:${n}:${k.domain}:${hexes[i]}`);
    const remember = (i: number, value: Uint8Array | null) => {
      if (value === null || value.length <= STATE_CACHE_MAX_VALUE) caches.values.set(ids[i]!, value);
    };
    const out: (Uint8Array | null)[] = new Array(keys.length);
    // The keys the isolate's cache lacks (a key asked twice in one call is read once).
    const missing: { domain: number; key: string; at: number[] }[] = [];
    const byId = new Map<string, number>();
    keys.forEach((k, i) => {
      const cached = caches.values.get(ids[i]!);
      if (cached !== undefined) {
        caches.hits++;
        out[i] = cached;
        return;
      }
      const j = byId.get(ids[i]!);
      if (j !== undefined) {
        missing[j]!.at.push(i);
        return;
      }
      byId.set(ids[i]!, missing.length);
      missing.push({ domain: k.domain, key: hexes[i]!, at: [i] });
    });
    if (missing.length === 0) return out;
    // A large batch (the hints wave) the isolate lacks is shared per data center under the digest
    // of its keys: asked after the isolate's own cache, never instead of it.
    const cache = this.pointers?.cache;
    const edgeUrl = cache && keys.length >= STATE_EDGE_BATCH_MIN ? `${EDGE_ORIGIN}/${this.pointers!.prefix}/state/${pin.hash}/${n}/${await digest(ids)}` : null;
    if (edgeUrl) {
      const shared = await this.edgeGet(cache!, edgeUrl);
      if (shared && shared.length === keys.length) {
        for (const m of missing) {
          const stored = shared[m.at[0]!];
          const value = stored == null ? null : fromHex(stored);
          for (const at of m.at) {
            out[at] = value;
            remember(at, value);
          }
        }
        caches.hits += missing.length;
        return out;
      }
    }
    caches.misses += missing.length;
    const batches: Promise<void>[] = [];
    for (let i = 0; i < missing.length; i += LIVE_BATCH) {
      const slice = missing.slice(i, i + LIVE_BATCH);
      batches.push(
        this.api.getPinnedMany(slice.map((k) => ({ domain: k.domain, key: k.key })), n, pin).then((r) => {
          if (r.stale) throw new StaleError();
          if (r.values.length !== slice.length) throw new Error("the live window answered the wrong number of values");
          r.values.forEach((v, j) => {
            const value = v.block === null || v.value === null ? null : fromHex(v.value);
            for (const at of slice[j]!.at) {
              out[at] = value;
              remember(at, value);
            }
          });
        }),
      );
    }
    await Promise.all(batches);
    if (edgeUrl) this.edgePut(cache!, edgeUrl, JSON.stringify(out.map((v) => (v === null ? null : toHex(v)))));
    return out;
  }

  /** A shared answer from the edge cache: the stored JSON array, or null when absent or damaged. */
  private async edgeGet(cache: PointerCache, url: string): Promise<(string | null)[] | null> {
    try {
      const hit = await cache.match(url);
      if (!hit) return null;
      const v = (await hit.json()) as unknown;
      return Array.isArray(v) && v.every((x) => x === null || typeof x === "string") ? (v as (string | null)[]) : null;
    } catch {
      return null;
    }
  }

  private edgePut(cache: PointerCache, url: string, body: string): void {
    cache.put(url, new Response(body, { headers: { "content-type": "application/json", "cache-control": `public, max-age=${STATE_EDGE_TTL_S}` } })).catch(() => {});
  }

  /** A block's witness bytes in the window, or null; from the isolate's cache after the first read under a pin. Throws StaleError. */
  async witness(n: number, pin: BlockId): Promise<Uint8Array | null> {
    const caches = cachesFor(this.api);
    const id = `${pin.hash}:${n}`;
    const cached = caches.witnesses.get(id);
    if (cached !== undefined) {
      caches.hits++;
      return cached;
    }
    caches.misses++;
    // The data center may have it from another isolate (fixed by the pin hash, like the values).
    const cache = this.pointers?.cache;
    const edgeUrl = cache ? `${EDGE_ORIGIN}/${this.pointers!.prefix}/witness/${pin.hash}/${n}` : null;
    if (edgeUrl) {
      const shared = await this.edgeGet(cache!, edgeUrl);
      if (shared && shared.length === 1) {
        const stored = shared[0];
        const witness = stored == null ? null : fromHex(stored);
        caches.witnesses.set(id, witness, witness ? witness.length : 0);
        return witness;
      }
    }
    const r = await this.api.witness(n, pin);
    if (r?.stale) throw new StaleError();
    const witness = r ? fromHex(r.witness) : null;
    caches.witnesses.set(id, witness, witness ? witness.length : 0);
    if (edgeUrl) this.edgePut(cache!, edgeUrl, JSON.stringify([r ? r.witness : null]));
    return witness;
  }

  /**
   * The block number of a transaction in the window, or null. From the pin's transaction index
   * when its document names one (a miss there is final when the index covers the whole
   * window); else from the service binding. Throws StaleError.
   */
  async txBlock(hash: string, pin: BlockId): Promise<number | null> {
    const index = this.pointers ? indexes.get(pin.hash) : undefined;
    if (index?.txIndex && /^(0x)?[0-9a-fA-F]{64}$/.test(hash)) {
      const table = await this.table(index.txIndex);
      if (table && table.first === index.first && table.last === index.first + index.hashes.length - 1) {
        const found = table.blocks(fromHex(hash).subarray(0, 8)).filter((n) => n <= pin.number);
        // Two transactions sharing a prefix: let the live Worker tell them apart.
        if (found.length === 1) return found[0]!;
        if (found.length === 0 && index.complete) return null;
      }
    }
    const r = await this.api.txBlock(hash, pin);
    if (!r) return null;
    if (r.stale) throw new StaleError();
    return r.number;
  }
}
