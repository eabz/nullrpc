// A per-item response cache in two tiers, stored in the isolate and in the data center's Cache
// API (`caches.default`).
//
// immutable: a successful result whose every block is at or below the pinned archive tip P.
//   Those blocks are final and the archive never rewrites them (docs/storage.md), so the entry
//   lives for a day, keyed by chain id, method and the canonical parameters.
// head: a successful result that depends on blocks above P, up to the pinned head: tags
//   (latest, pending, safe, finalized) and recent numbers, the fee oracle, eth_feeHistory,
//   eth_blockNumber, eth_getLogs ranges ending above P, lookups by hash that land above P, and
//   eth_call / eth_estimateGas at the head. The key adds the pinned head (number and hash): a
//   hash fixes the whole chain below it, so every client pinning that head gets the same
//   answer, and a new head simply misses. Entries live 60 s.
//
// Tags are resolved to numbers against the request's pointers before the lookup, so "latest"
// at P is an immutable entry for block P. Errors are never stored, nor anything whose answer
// depends on the caller (eth_sendRawTransaction, access state); null answers to lookups by
// hash are not stored either (the transaction may be in a block the window just promoted).
// An answer computed while a reorg re-pinned the head (chain.ts, withHead) is not stored.
//
// The archive generation is deliberately not part of any key: an answer at or below P is the
// same in every later generation, and generations advance on every promotion and compaction
// merge.

import { sha256 } from "./archive/archive";
import type { Chain, Pointers } from "./chain";
import { data, parseData, parseQuantity } from "./eth/hex";

/** Seconds an immutable answer stays in the edge cache. */
export const IMMUTABLE_TTL_S = 86_400;
/** Seconds a head answer stays in the edge cache and in the isolate (a new head misses anyway). */
export const HEAD_TTL_S = 60;
/** Bump when a method's JSON changes (a fix in serialization) to drop every stored answer. */
const VERSION = "v2";
/** The isolate's share of answers: total bytes, and the largest answer kept there. */
const MEMORY_BYTES = 8 * 1024 * 1024;
const MEMORY_ENTRY_BYTES = 128 * 1024;

export type CacheStatus = "hit" | "miss" | "bypass";
export type Tier = "immutable" | "head";
/** What happened to one item: `tier` is where a hit came from or where a miss was stored. */
export interface CacheOutcome {
  status: CacheStatus;
  tier?: Tier;
}

/** What a cacheable call looks like before it runs. */
interface Plan {
  /** Canonical parameters; equal calls produce equal plans. */
  params: unknown[];
  /** The newest block the answer depends on, or null when only the result says (lookups by hash). */
  block: number | null;
}

type Classify = (params: unknown[], p: Pointers) => Plan | null;

/** A block parameter as a number against the request's pointers; null for a hash or malformed. */
function blockNumber(v: unknown, p: Pointers): number | null {
  if (v === undefined || v === null || v === "latest" || v === "pending") return p.latest;
  if (v === "safe") return p.safe;
  if (v === "finalized") return p.finalized;
  if (v === "earliest") return p.earliest;
  if (typeof v === "string") return parseQuantity(v);
  if (typeof v === "object") {
    const o = v as { blockHash?: unknown; blockNumber?: unknown };
    if (o.blockHash !== undefined) return null;
    if (o.blockNumber !== undefined) return blockNumber(o.blockNumber, p);
  }
  return null;
}

/** Fixed-length hex data, lowercased, or null when malformed. */
function hex(v: unknown, length: number): string | null {
  const b = parseData(v, length);
  return b ? data(b) : null;
}

function withBlock(block: unknown, p: Pointers, rest: (p: unknown[]) => unknown[] | null, params: unknown[]): Plan | null {
  const n = blockNumber(block, p);
  if (n === null) return null;
  const tail = rest(params);
  return tail ? { params: [n, ...tail], block: n } : null;
}

const none = () => [] as unknown[];
const flag = ([, full]: unknown[]) => (typeof full === "boolean" ? [full] : null);
const idx = ([, i]: unknown[]) => {
  const n = parseQuantity(i);
  return n === null ? null : [n];
};
const addr = (v: unknown) => hex(v, 20);

const byNumber = (rest: (p: unknown[]) => unknown[] | null): Classify => (params, p) => withBlock(params[0], p, rest, params);
const byHash = (rest: (p: unknown[]) => unknown[] | null): Classify => (params) => {
  const h = hex(params[0], 32);
  const tail = rest(params);
  return h && tail ? { params: [h, ...tail], block: null } : null;
};
const state = (at: number): Classify => (params, p) => {
  const a = addr(params[0]);
  const n = blockNumber(params[at], p);
  if (!a || n === null) return null;
  if (at === 1) return { params: [a, n], block: n };
  const slot = params[1];
  if (typeof slot !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(slot)) return null;
  return { params: [a, "0x" + slot.slice(2).toLowerCase().padStart(64, "0"), n], block: n };
};
/** Methods without parameters whose answer is a function of the latest block. */
const atHead: Classify = (params, p) => (params.length === 0 ? { params: [p.latest], block: p.latest } : null);

/** eth_getLogs with a numeric or tagged range (blockHash filters are looked up fresh). */
function logs(params: unknown[], p: Pointers): Plan | null {
  const f = params[0] as { fromBlock?: unknown; toBlock?: unknown; blockHash?: unknown; address?: unknown; topics?: unknown } | null;
  if (!f || typeof f !== "object" || f.blockHash !== undefined) return null;
  const from = blockNumber(f.fromBlock, p);
  const toRaw = blockNumber(f.toBlock, p);
  if (from === null || toRaw === null) return null;
  // The method clamps the range to the latest block.
  const to = Math.min(toRaw, p.latest);
  const list = (v: unknown, length: number): string[] | null => {
    if (v === null || v === undefined) return [];
    const items = (Array.isArray(v) ? v : [v]).map((x) => hex(x, length));
    return items.every((x): x is string => x !== null) ? items : null;
  };
  const address = list(f.address, 20);
  if (!address) return null;
  if (f.topics !== undefined && f.topics !== null && !Array.isArray(f.topics)) return null;
  const topics: (string[] | null)[] = [];
  for (const t of (f.topics as unknown[] | undefined) ?? []) {
    const accepted = t === null || t === undefined ? null : list(t, 32);
    if (accepted === null && t !== null && t !== undefined) return null;
    topics.push(accepted && accepted.length ? accepted : null);
  }
  while (topics.length && topics.at(-1) === null) topics.pop();
  return { params: [{ from, to, address, topics }], block: Math.max(from, to) };
}

/** eth_feeHistory: the answer reads `newest` and, below the latest block, its successor. */
function feeHistory(params: unknown[], p: Pointers): Plan | null {
  const [countRaw, newestRaw, percentilesRaw] = params;
  let count: number | null = null;
  if (typeof countRaw === "number" && Number.isSafeInteger(countRaw) && countRaw >= 0) count = countRaw;
  else if (typeof countRaw === "string") count = /^0x/i.test(countRaw) ? parseQuantity(countRaw.toLowerCase()) : /^\d+$/.test(countRaw) ? Number(countRaw) : null;
  if (count === null || newestRaw === undefined) return null;
  const newest = blockNumber(newestRaw, p);
  if (newest === null) return null;
  const percentiles = percentilesRaw === undefined || percentilesRaw === null ? [] : percentilesRaw;
  if (!Array.isArray(percentiles) || !percentiles.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  return { params: [count, newest, percentiles], block: newest < p.latest ? newest + 1 : newest };
}

/** A call object as sent, with keys sorted and hex strings lowercased; null when not an object. */
function callObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) {
    const x = (v as Record<string, unknown>)[k];
    if (x === undefined) continue;
    out[k] = typeof x === "string" && /^0x[0-9a-fA-F]*$/.test(x) ? x.toLowerCase() : x;
  }
  return out;
}

/** eth_call and eth_estimateGas: the call object at a block; state overrides bypass. */
const execute: Classify = (params, p) => {
  if (params.length > 2) return null;
  const call = callObject(params[0]);
  const n = blockNumber(params[1], p);
  return call && n !== null ? { params: [call, n], block: n } : null;
};

const CLASSIFY: Record<string, Classify> = {
  eth_getBlockByNumber: byNumber(flag),
  eth_getBlockTransactionCountByNumber: byNumber(none),
  eth_getUncleCountByBlockNumber: byNumber(none),
  eth_getUncleByBlockNumberAndIndex: byNumber(idx),
  eth_getTransactionByBlockNumberAndIndex: byNumber(idx),
  eth_getRawTransactionByBlockNumberAndIndex: byNumber(idx),
  eth_getBlockReceipts: byNumber(none),
  debug_getRawBlock: byNumber(none),
  debug_getRawHeader: byNumber(none),
  debug_getRawReceipts: byNumber(none),

  eth_getBlockByHash: byHash(flag),
  eth_getTransactionByBlockHashAndIndex: byHash(idx),
  eth_getTransactionByHash: byHash(none),
  eth_getTransactionReceipt: byHash(none),

  eth_getBalance: state(1),
  eth_getTransactionCount: state(1),
  eth_getCode: state(1),
  eth_getStorageAt: state(2),

  eth_getLogs: logs,

  eth_blockNumber: atHead,
  eth_gasPrice: atHead,
  eth_maxPriorityFeePerGas: atHead,
  eth_feeHistory: feeHistory,

  eth_call: execute,
  eth_estimateGas: execute,
};

/** The block a fresh result places itself at, for lookups by hash; null when it does not say. */
function resultBlock(method: string, result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { number?: unknown; blockNumber?: unknown };
  return parseQuantity(method === "eth_getBlockByHash" ? r.number : r.blockNumber);
}

function hexDigest(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The pinned head a head-tier answer is keyed by: the live head, else the archive tip. */
export function headOf(chain: Chain): { number: number; hash: string } {
  const h = chain.state?.head;
  if (h && h.number > chain.archived) return h;
  const tip = chain.pin.manifest.archived_through;
  return { number: tip.number, hash: tip.hash.toLowerCase() };
}

/** Answers kept in the isolate, bounded by bytes; the least recently used go first. */
class Memory {
  private readonly map = new Map<string, { body: string; expires: number }>();
  private bytes = 0;

  get(key: string, now: number): string | null {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.expires <= now) {
      this.delete(key);
      return null;
    }
    this.map.delete(key);
    this.map.set(key, e);
    return e.body;
  }

  set(key: string, body: string, expires: number): void {
    if (body.length > MEMORY_ENTRY_BYTES) return;
    this.delete(key);
    this.map.set(key, { body, expires });
    this.bytes += body.length;
    while (this.bytes > MEMORY_BYTES) this.delete(this.map.keys().next().value as string);
  }

  private delete(key: string): void {
    const e = this.map.get(key);
    if (!e) return;
    this.map.delete(key);
    this.bytes -= e.body.length;
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.map.size;
  }

  get used(): number {
    return this.bytes;
  }
}

/** One per isolate, shared by every request and both tiers. */
export const memory = new Memory();

/** Misses being computed right now, by their first cache key (per isolate). */
const inflight = new Map<string, Promise<unknown>>();

export class ResponseCache {
  constructor(
    /** `caches.default`, or null to serve everything fresh. */
    private readonly cache: Cache | null,
    private readonly origin: string,
    private readonly chainId: number,
    /** `ctx.waitUntil`: stores run after the response. */
    private readonly defer: (p: Promise<unknown>) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** The key of a tier's entry; a head-tier key carries the pinned head. */
  async key(tier: Tier, method: string, params: unknown[], head?: { number: number; hash: string }): Promise<string> {
    const digest = hexDigest(await sha256(new TextEncoder().encode(JSON.stringify(params))));
    const scope = tier === "head" ? `h/${head!.number}-${head!.hash}` : "i";
    return `${this.origin}/_cache/rpc/${VERSION}/${this.chainId}/${scope}/${method}/${digest}`;
  }

  /**
   * Serves `method(params)` from the cache when it can, else from `run`, storing the result when
   * the answer is fixed by the pinned archive (immutable) or the pinned head (head). `run`
   * returns the method's result or throws its error.
   */
  async serve(chain: Chain, method: string, params: unknown[], run: () => Promise<unknown>): Promise<{ result: unknown; outcome: CacheOutcome }> {
    const classify = CLASSIFY[method];
    const bypass = async () => ({ result: await run(), outcome: { status: "bypass" as const } });
    if (!this.cache || !classify) return bypass();
    const pointers = chain.pointers();
    const plan = safely(() => classify(params, pointers));
    if (!plan) return bypass();
    const first = pointers.earliest;
    const archived = pointers.archived;
    const latest = pointers.latest;
    // A block the archive does not hold (below its first block) may be backfilled later; one
    // above the head does not exist yet.
    if (plan.block !== null && (plan.block > latest || plan.block < first)) return bypass();
    const head = headOf(chain);
    const tierOf = (block: number): Tier => (block <= archived ? "immutable" : "head");

    // Lookups by hash do not know their tier until the answer says: ask both.
    const tiers: Tier[] = plan.block === null ? ["immutable", "head"] : [tierOf(plan.block)];
    const keys = await Promise.all(tiers.map((t) => this.key(t, method, plan.params, head)));
    const now = this.now();
    for (let i = 0; i < tiers.length; i++) {
      const body = memory.get(keys[i]!, now);
      if (body !== null) return { result: JSON.parse(body), outcome: { status: "hit", tier: tiers[i]! } };
    }
    const found = await Promise.all(keys.map((k) => this.cache!.match(k).catch(() => undefined)));
    for (let i = 0; i < tiers.length; i++) {
      const res = found[i];
      if (!res) continue;
      // A damaged entry is a miss and is overwritten below.
      const body = await res.text().catch(() => null);
      if (body === null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        continue;
      }
      memory.set(keys[i]!, body, this.expiry(tiers[i]!, now));
      return { result: parsed, outcome: { status: "hit", tier: tiers[i]! } };
    }

    // Identical misses in flight share one computation: a new head makes every client miss the
    // same keys at once, and one answer serves them all.
    const shared = inflight.get(keys[0]!);
    let result: unknown;
    if (shared) result = await shared;
    else {
      const p = run();
      inflight.set(keys[0]!, p);
      try {
        result = await p;
      } finally {
        if (inflight.get(keys[0]!) === p) inflight.delete(keys[0]!);
      }
    }
    // A reorg re-pinned the head during the call: the answer belongs to a head we cannot name.
    const after = headOf(chain);
    if (after.number !== head.number || after.hash !== head.hash) return { result, outcome: { status: "miss" } };
    const at = plan.block ?? resultBlock(method, result);
    // null answers to lookups by hash may turn into answers later; results pinned by a parameter
    // (a block that exists) are final for their tier either way.
    if (at === null || at > latest || (plan.block === null && result === null)) return { result, outcome: { status: "miss" } };
    const tier = tierOf(at);
    const key = keys[tiers.indexOf(tier)] ?? (await this.key(tier, method, plan.params, head));
    const body = JSON.stringify(result);
    memory.set(key, body, this.expiry(tier, this.now()));
    const ttl = tier === "head" ? HEAD_TTL_S : IMMUTABLE_TTL_S;
    const res = new Response(body, { headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}` } });
    this.defer(this.cache!.put(key, res).catch(() => undefined));
    return { result, outcome: { status: "miss", tier } };
  }

  private expiry(tier: Tier, now: number): number {
    return tier === "head" ? now + HEAD_TTL_S * 1000 : Infinity;
  }
}

function safely<T>(f: () => T | null): T | null {
  try {
    return f();
  } catch {
    return null;
  }
}

/**
 * The response header: `hit immutable`, `miss head`, `miss` (not stored) or `bypass` for a
 * single request; for a batch, status counts followed by per-tier counts of the items a tier
 * answered or stored (`hit=1 miss=1 bypass=2 immutable=1 head=1`).
 */
export function responseCacheHeader(outcomes: CacheOutcome[], batch: boolean): string {
  if (!batch) {
    const o = outcomes[0];
    if (!o) return "bypass";
    return o.tier ? `${o.status} ${o.tier}` : o.status;
  }
  const count = (f: (o: CacheOutcome) => boolean) => outcomes.filter(f).length;
  return `hit=${count((o) => o.status === "hit")} miss=${count((o) => o.status === "miss")} bypass=${count((o) => o.status === "bypass")} immutable=${count((o) => o.tier === "immutable")} head=${count((o) => o.tier === "head")}`;
}
