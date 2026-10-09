// eth_getLogs: the log index narrows archived blocks to candidates; live-window blocks are read
// directly. Every candidate block is filtered exactly, so results equal a full scan.
//
// Every query runs under a read budget (READ_BUDGET archive reads per request, well inside the
// Worker's per-request Cache API limit): the index reads are costed from the manifest before any
// is issued, candidate blocks are fetched in coalesced range reads (src/archive/archive.ts,
// planBlockRuns) WAVE at a time and decoded only as far as their logs need (of a layout-2
// segment only the receipts frames are read and decoded at all), and a query that
// would exceed the budget, the block or the log limit is refused with -32005 and the range that
// would fit, before the expensive reads start. Live-window blocks are one live call each (no
// Cache API), bounded by MAX_BLOCKS with the candidates.

import { logCandidates, logIndexCost, logIndexRangeFor, type Group } from "../archive/logindex";
import type { Chain } from "../chain";
import { parseData } from "../eth/hex";
import { blockLogs, frameLogs, logMatches, receiptsLogs, type BlockRecord } from "../eth/record";
import { blockRef, invalidParams, RpcError, type Handler } from "../rpc";

/** The widest block range a query may span (credits.json, eth_getLogs.max_blocks). */
export const MAX_RANGE = 10_000;
/** The most blocks a query may read after narrowing. */
export const MAX_BLOCKS = 1_000;
/** The most logs one response may hold. */
export const MAX_LOGS = 10_000;
/** Archive reads per query: index records and frames, offsets pages, block runs. */
export const READ_BUDGET = 256;
/** Archive reads in flight at once (a Worker waits on at most six connections). */
const WAVE = 6;
/** Live-window block reads in flight at once. */
const LIVE_WAVE = 16;

interface Filter {
  from: number;
  to: number;
  addresses: Uint8Array[];
  /** Per position: null (any) or the accepted values. */
  topics: (Uint8Array[] | null)[];
}

function values(v: unknown, length: number, name: string): Uint8Array[] | null {
  if (v === null || v === undefined) return null;
  const list = Array.isArray(v) ? v : [v];
  if (list.length === 0) return null;
  return list.map((x) => {
    const b = parseData(x, length);
    if (!b) throw invalidParams(`${name} must be ${length}-byte hex`);
    return b;
  });
}

async function parseFilter(chain: Chain, raw: unknown): Promise<Filter> {
  if (!raw || typeof raw !== "object") throw invalidParams("filter object required");
  const f = raw as { fromBlock?: unknown; toBlock?: unknown; blockHash?: unknown; address?: unknown; topics?: unknown };
  const addresses = values(f.address, 20, "address") ?? [];
  if (f.topics !== undefined && f.topics !== null && !Array.isArray(f.topics)) throw invalidParams("topics must be an array");
  const topics = ((f.topics as unknown[] | undefined) ?? []).map((t, i) => values(t, 32, `topics[${i}]`));
  if (topics.length > 4) throw invalidParams("at most 4 topic positions");
  if (f.blockHash !== undefined) {
    if (f.fromBlock !== undefined || f.toBlock !== undefined) throw invalidParams("blockHash cannot be combined with fromBlock or toBlock");
    const hash = parseData(f.blockHash, 32);
    if (!hash) throw invalidParams("blockHash must be a 32-byte hex string");
    // Only the block's number is needed here: its logs are read by number below.
    const rec = await chain.blockByHash(hash, "block");
    if (!rec) throw new RpcError(-32000, "unknown block");
    return { from: rec.block.header.number, to: rec.block.header.number, addresses, topics };
  }
  const resolve = (v: unknown) => {
    const ref = blockRef(chain, v ?? "latest");
    if (!("number" in ref)) throw invalidParams("fromBlock and toBlock must be numbers or tags");
    return ref.number;
  };
  const latest = chain.pointers().latest;
  const from = resolve(f.fromBlock);
  const to = Math.min(resolve(f.toBlock), latest);
  if (from > to) return { from, to: from - 1, addresses, topics };
  return { from, to, addresses, topics };
}

const hex = (n: number) => `0x${n.toString(16)}`;

/**
 * The -32005 refusal: `why`, then the range that would fit (null when nothing of the query
 * fits, e.g. too many field values for the index), also in `data`.
 */
function refuse(why: string, fit: { from: number; to: number } | null): RpcError {
  if (!fit || fit.to < fit.from) return new RpcError(-32005, `${why}; narrow the range or add filters`);
  return new RpcError(-32005, `${why}; narrow the range to ${hex(fit.from)}-${hex(fit.to)}`, { fromBlock: hex(fit.from), toBlock: hex(fit.to) });
}

/**
 * The range [from, to'] that fits `remaining` reads: `items` are the blocks the query reads in
 * order, each with the reads it adds; to' is the block before the first that does not fit.
 */
function fitting(from: number, items: { block: number; cost: number }[], remaining: number): { from: number; to: number } | null {
  let used = 0;
  for (const it of items) {
    used += it.cost;
    if (used > remaining) return it.block > from ? { from, to: it.block - 1 } : null;
  }
  return null;
}

/** eth_getLogs for one filter under `budget` reads (the handler uses READ_BUDGET). */
export async function getLogs(chain: Chain, raw: unknown, budget = READ_BUDGET): Promise<Record<string, unknown>[]> {
  const f = await parseFilter(chain, raw);
  if (f.to < f.from) return [];
  if (f.to - f.from + 1 > MAX_RANGE) throw refuse(`query spans more than ${MAX_RANGE} blocks`, { from: f.from, to: f.from + MAX_RANGE - 1 });
  const archived = chain.pointers().archived;
  const groups: Group[] = [
    ...(f.addresses.length ? [{ tag: 0, values: f.addresses }] : []),
    ...f.topics.flatMap((t, i) => (t ? [{ tag: 1 + i, values: t }] : [])),
  ];
  const archiveEnd = Math.min(f.to, archived);
  const liveFrom = Math.max(f.from, archived + 1);
  const live: number[] = [];
  for (let n = liveFrom; n <= f.to; n++) live.push(n);
  let spent = 0;

  // 1. The index: costed from the manifest; the oldest objects are the expensive ones.
  let candidates: number[] = [];
  if (f.from <= archiveEnd) {
    const cost = logIndexCost(chain.pin, groups, f.from, archiveEnd);
    if (cost > budget) throw refuse(`query needs more than ${budget} reads`, logIndexRangeFor(chain.pin, groups, f.from, archiveEnd, budget));
    const found = await logCandidates(chain.archiveHandle, chain.pin, groups, f.from, archiveEnd);
    spent += found.reads;
    if (found.blocks) candidates = found.blocks;
    else for (let n = f.from; n <= archiveEnd; n++) candidates.push(n);
  }
  const all = [...candidates, ...live];
  if (all.length > MAX_BLOCKS) throw refuse(`query matches more than ${MAX_BLOCKS} blocks`, { from: f.from, to: all[MAX_BLOCKS]! - 1 });

  // 2. Offsets pages (one read per page), before any is read.
  const newPage = chain.offsetsPages(candidates);
  const pages = newPage.filter(Boolean).length;
  if (spent + pages > budget) {
    throw refuse(`query needs more than ${budget} reads`, fitting(f.from, candidates.map((n, i) => ({ block: n, cost: newPage[i] ? 1 : 0 })), budget - spent));
  }

  // 3. Block runs (one range read each), known once the offsets are read.
  const runs = await chain.planArchived(candidates);
  spent += pages;
  if (spent + runs.length > budget) {
    throw refuse(`query needs more than ${budget} reads`, fitting(f.from, runs.map((r) => ({ block: r.blocks[0]!.n, cost: 1 })), budget - spent));
  }

  // 4. Read, WAVE at a time, in block order; stop at the log limit.
  const out: Record<string, unknown>[] = [];
  const state: { overflow: number | null } = { overflow: null };
  const take = (n: number, logs: Record<string, unknown>[]): boolean => {
    out.push(...logs);
    if (out.length <= MAX_LOGS) return true;
    state.overflow = n;
    return false;
  };
  await chain.readArchived(runs, WAVE, (b) => take(b.n, b.kind === "receipts" ? receiptsLogs(b.frame, b.hash, b.n, f) : frameLogs(b.frame, b.hash, f)));
  if (state.overflow === null) {
    await chain.readBlocks(live, LIVE_WAVE, (rec: BlockRecord) => take(rec.block.header.number, blockLogs(rec).filter((l) => logMatches(l.address, l.topics, f)).map((l) => l.json)));
  }
  if (state.overflow !== null) throw refuse(`query returns more than ${MAX_LOGS} logs`, { from: f.from, to: state.overflow - 1 });
  return out;
}

export const LOG_METHODS: Record<string, Handler> = {
  eth_getLogs: (chain, [raw]) => getLogs(chain, raw),
};
