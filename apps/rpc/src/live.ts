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

import { Lru } from "./archive/lru";
import type { Source } from "./archive/source";

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
  source: Source;
  prefix: string;
  cache?: PointerCache | null;
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
}

function blockId(v: unknown): BlockId | null {
  const b = v as BlockId | null | undefined;
  if (!b || typeof b !== "object" || !Number.isSafeInteger(b.number) || b.number < 0 || typeof b.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(b.hash)) return null;
  return { number: b.number, hash: b.hash.toLowerCase() };
}

/** The pointers in `raw`, or null when they are unusable or written more than a minute before `now`. */
export function parsePointers(raw: Uint8Array, now: number): LiveState | null {
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
  return { head, safe: blockId(doc.safe), finalized: blockId(doc.finalized), promoted, generation: doc.generation, shards: null };
}
// Records are immutable per block hash, so they are kept with no expiry.
const records = new Lru<string, Uint8Array>(512);

/** Most keys per getPinnedMany call (apps/live/src/index.ts). */
export const LIVE_BATCH = 1024;

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
      if (hit) return parsePointers(new Uint8Array(await hit.arrayBuffer()), now);
      const raw = await source.get(key);
      if (!raw) return null;
      if (cache) {
        const copy = new Response(raw.slice(), { headers: { "content-type": "application/json", "cache-control": `max-age=${POINTERS_TTL_MS / 1000}` } });
        cache.put(url, copy).catch(() => {});
      }
      return parsePointers(raw, now);
    } catch (e) {
      console.error(JSON.stringify({ event: "live_pointers_error", error: e instanceof Error ? e.message : String(e) }));
      return null;
    }
  }

  /** A block record in the window at or below the pin, or null. Throws StaleError. */
  async block(numberOrHash: number | string, pin: BlockId): Promise<{ number: number; hash: string; record: Uint8Array } | null> {
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

  /**
   * A state value at the end of block `n` in the window: bytes (empty when absent or zero), or
   * null when the key has not changed since P (read the archive at P). Throws StaleError.
   */
  async stateValue(domain: 1 | 2 | 3, key: Uint8Array, n: number, pin: BlockId): Promise<Uint8Array | null> {
    const r = await this.api.getPinned(domain, toHex(key), n, pin);
    if (r.stale) throw new StaleError();
    if (r.block === null || r.value === null) return null;
    return fromHex(r.value);
  }

  /**
   * stateValue for many keys in as few calls as possible (one per LIVE_BATCH keys), answered
   * in order. Throws StaleError when any batch is stale.
   */
  async stateValues(keys: { domain: 1 | 2 | 3; key: Uint8Array }[], n: number, pin: BlockId): Promise<(Uint8Array | null)[]> {
    const batches: Promise<(Uint8Array | null)[]>[] = [];
    for (let i = 0; i < keys.length; i += LIVE_BATCH) {
      const slice = keys.slice(i, i + LIVE_BATCH);
      batches.push(
        this.api.getPinnedMany(slice.map((k) => ({ domain: k.domain, key: toHex(k.key) })), n, pin).then((r) => {
          if (r.stale) throw new StaleError();
          if (r.values.length !== slice.length) throw new Error("the live window answered the wrong number of values");
          return r.values.map((v) => (v.block === null || v.value === null ? null : fromHex(v.value)));
        }),
      );
    }
    return (await Promise.all(batches)).flat();
  }

  /** A block's witness bytes in the window, or null. Throws StaleError. */
  async witness(n: number, pin: BlockId): Promise<Uint8Array | null> {
    const r = await this.api.witness(n, pin);
    if (!r) return null;
    if (r.stale) throw new StaleError();
    return fromHex(r.witness);
  }

  /** The block number of a transaction in the window, or null. Throws StaleError. */
  async txBlock(hash: string, pin: BlockId): Promise<number | null> {
    const r = await this.api.txBlock(hash, pin);
    if (!r) return null;
    if (r.stale) throw new StaleError();
    return r.number;
  }
}
