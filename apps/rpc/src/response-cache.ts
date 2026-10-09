// A per-item response cache for answers that cannot change. A successful result of a block,
// transaction, receipt, raw-encoding, log or state method is stored in the data center's Cache
// API (`caches.default`) when every block it depends on is at or below the pinned archive tip
// P: those blocks are final and the archive never rewrites them (docs/storage.md). Anything
// that resolves a tag (latest, pending, safe, finalized), reads the live window, errors, or
// depends on a block above P is served fresh.
//
// The block a request depends on is known either from its parameters (a number, "earliest", or
// an EIP-1898 blockNumber object) or, for lookups by hash, from the result (`number` or
// `blockNumber`): those are only stored after a fresh answer placed them at or below P.
//
// Keys: the chain id, a format version, the method and a digest of the canonical parameters,
// under the Worker's own origin. The archive generation is deliberately not part of the key:
// an answer at or below P is the same in every later generation, and generations advance on
// every promotion and compaction merge.

import { sha256 } from "./archive/archive";
import type { Chain } from "./chain";
import { data, parseData, parseQuantity } from "./eth/hex";

/** Seconds an answer stays in the edge cache. */
export const RESPONSE_CACHE_TTL_S = 86_400;
/** Bump when a method's JSON changes (a fix in serialization) to drop every stored answer. */
const VERSION = "v1";

export type CacheStatus = "hit" | "miss" | "bypass";

/** What a cacheable call looks like before it runs. */
interface Plan {
  /** Canonical parameters; equal calls produce equal plans. */
  params: unknown[];
  /** The block the answer depends on, or null when only the result says (lookups by hash). */
  block: number | null;
}

/** `earliest` is the archive's first block, what the "earliest" tag names. */
type Classify = (params: unknown[], earliest: number) => Plan | null;

const TAGS = new Set(["latest", "pending", "safe", "finalized"]);

/** A block parameter as a number, or null when it names a tag or a hash (not cacheable here). */
function blockNumber(v: unknown, earliest: number): number | null {
  if (v === undefined || v === null) return null;
  if (v === "earliest") return earliest;
  if (typeof v === "string") return TAGS.has(v) ? null : parseQuantity(v);
  if (typeof v === "object") {
    const o = v as { blockHash?: unknown; blockNumber?: unknown };
    if (o.blockHash !== undefined) return null;
    if (o.blockNumber !== undefined) return blockNumber(o.blockNumber, earliest);
  }
  return null;
}

/** Fixed-length hex data, lowercased, or null when malformed. */
function hex(v: unknown, length: number): string | null {
  const b = parseData(v, length);
  return b ? data(b) : null;
}

function withBlock(block: unknown, earliest: number, rest: (p: unknown[]) => unknown[] | null, params: unknown[]): Plan | null {
  const n = blockNumber(block, earliest);
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

const byNumber = (rest: (p: unknown[]) => unknown[] | null): Classify => (params, earliest) => withBlock(params[0], earliest, rest, params);
const byHash = (rest: (p: unknown[]) => unknown[] | null): Classify => (params) => {
  const h = hex(params[0], 32);
  const tail = rest(params);
  return h && tail ? { params: [h, ...tail], block: null } : null;
};
const state = (at: number): Classify => (params, earliest) => {
  const a = addr(params[0]);
  const n = blockNumber(params[at], earliest);
  if (!a || n === null) return null;
  if (at === 1) return { params: [a, n], block: n };
  const slot = params[1];
  if (typeof slot !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(slot)) return null;
  return { params: [a, "0x" + slot.slice(2).toLowerCase().padStart(64, "0"), n], block: n };
};

/** eth_getLogs with a numeric range (blockHash filters are looked up fresh). */
function logs(params: unknown[], earliest: number): Plan | null {
  const f = params[0] as { fromBlock?: unknown; toBlock?: unknown; blockHash?: unknown; address?: unknown; topics?: unknown } | null;
  if (!f || typeof f !== "object" || f.blockHash !== undefined) return null;
  const from = blockNumber(f.fromBlock, earliest);
  const to = blockNumber(f.toBlock, earliest);
  if (from === null || to === null) return null;
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

export class ResponseCache {
  constructor(
    /** `caches.default`, or null to serve everything fresh. */
    private readonly cache: Cache | null,
    private readonly origin: string,
    private readonly chainId: number,
    /** `ctx.waitUntil`: stores run after the response. */
    private readonly defer: (p: Promise<unknown>) => void,
  ) {}

  async key(method: string, params: unknown[]): Promise<string> {
    const digest = hexDigest(await sha256(new TextEncoder().encode(JSON.stringify(params))));
    return `${this.origin}/_cache/rpc/${VERSION}/${this.chainId}/${method}/${digest}`;
  }

  /**
   * Serves `method(params)` from the cache when it can, else from `run`, storing the result when
   * the answer is immutable. `run` returns the method's result or throws its error.
   */
  async serve(chain: Chain, method: string, params: unknown[], run: () => Promise<unknown>): Promise<{ result: unknown; status: CacheStatus }> {
    const classify = CLASSIFY[method];
    const first = chain.pin.manifest.first_block;
    const archived = chain.archived;
    const plan = this.cache && classify ? safely(() => classify(params, first)) : null;
    // A block the archive does not hold (below its first block) may be backfilled later.
    if (!plan || (plan.block !== null && (plan.block > archived || plan.block < first))) return { result: await run(), status: "bypass" };

    const url = await this.key(method, plan.params);
    const hit = await this.cache!.match(url).catch(() => undefined);
    if (hit) {
      // A damaged entry is a miss and is overwritten below.
      const cached = await hit.text().then((t) => ({ ok: true, result: JSON.parse(t) as unknown }), () => ({ ok: false, result: null }));
      if (cached.ok) return { result: cached.result, status: "hit" };
    }

    const result = await run();
    const at = plan.block ?? resultBlock(method, result);
    // null results of lookups by hash may turn into answers later; results pinned by a parameter
    // (a block that exists) are final either way.
    if (at !== null && at <= archived && (plan.block !== null || result !== null)) {
      const res = new Response(JSON.stringify(result), {
        headers: { "content-type": "application/json", "cache-control": `public, max-age=${RESPONSE_CACHE_TTL_S}` },
      });
      this.defer(this.cache!.put(url, res).catch(() => undefined));
    }
    return { result, status: "miss" };
  }
}

function safely<T>(f: () => T | null): T | null {
  try {
    return f();
  } catch {
    return null;
  }
}

/** The response header: one status for a single request, counts for a batch. */
export function responseCacheHeader(statuses: CacheStatus[], batch: boolean): string {
  if (!batch) return statuses[0] ?? "bypass";
  const count = (s: CacheStatus) => statuses.filter((x) => x === s).length;
  return `hit=${count("hit")} miss=${count("miss")} bypass=${count("bypass")}`;
}
