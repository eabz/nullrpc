// eth_getLogs: the log index narrows archived blocks to candidates; live-window blocks are read
// directly. Every candidate block is filtered exactly, so results equal a full scan.

import { logCandidates } from "../archive/logindex";
import type { Chain } from "../chain";
import { equal, parseData } from "../eth/hex";
import { blockLogs, type BlockRecord } from "../eth/record";
import { blockRef, invalidParams, RpcError, type Handler } from "../rpc";

/** The widest block range a query may span (credits.json, eth_getLogs.max_blocks). */
export const MAX_RANGE = 10_000;
/** The most blocks a query may read after narrowing. */
export const MAX_BLOCKS = 1_000;
/** The most logs one response may hold. */
export const MAX_LOGS = 10_000;
const READ_CONCURRENCY = 16;

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
    const rec = await chain.blockByHash(hash);
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

function matches(log: { address: Uint8Array; topics: Uint8Array[] }, f: Filter): boolean {
  if (f.addresses.length && !f.addresses.some((a) => equal(a, log.address))) return false;
  for (let i = 0; i < f.topics.length; i++) {
    const accepted = f.topics[i];
    if (!accepted) continue;
    const t = log.topics[i];
    if (!t || !accepted.some((a) => equal(a, t))) return false;
  }
  return true;
}

async function readAll(chain: Chain, blocks: number[]): Promise<(BlockRecord | null)[]> {
  const out: (BlockRecord | null)[] = new Array(blocks.length).fill(null);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, blocks.length) }, async () => {
      while (next < blocks.length) {
        const i = next++;
        out[i] = await chain.block(blocks[i]!);
      }
    }),
  );
  return out;
}

export const LOG_METHODS: Record<string, Handler> = {
  eth_getLogs: async (chain, [raw]) => {
    const f = await parseFilter(chain, raw);
    if (f.to < f.from) return [];
    if (f.to - f.from + 1 > MAX_RANGE) throw new RpcError(-32005, `query exceeds ${MAX_RANGE} blocks; narrow the range`);
    const archived = chain.pointers().archived;
    const groups = [
      ...(f.addresses.length ? [{ tag: 0, values: f.addresses }] : []),
      ...f.topics.flatMap((t, i) => (t ? [{ tag: 1 + i, values: t }] : [])),
    ];
    const blocks: number[] = [];
    if (f.from <= archived) {
      const end = Math.min(f.to, archived);
      const candidates = await logCandidates(chain.archiveHandle, chain.pin, groups, f.from, end);
      if (candidates) blocks.push(...candidates);
      else for (let n = f.from; n <= end; n++) blocks.push(n);
    }
    for (let n = Math.max(f.from, archived + 1); n <= f.to; n++) blocks.push(n);
    if (blocks.length > MAX_BLOCKS) throw new RpcError(-32005, `query matches more than ${MAX_BLOCKS} blocks; narrow the range or add filters`);
    const out: Record<string, unknown>[] = [];
    for (const rec of await readAll(chain, blocks)) {
      if (!rec) continue;
      for (const log of blockLogs(rec)) {
        if (!matches(log, f)) continue;
        out.push(log.json);
        if (out.length > MAX_LOGS) throw new RpcError(-32005, `query returns more than ${MAX_LOGS} logs; narrow the range or add filters`);
      }
    }
    return out;
  },
};
