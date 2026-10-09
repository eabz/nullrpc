// nullrpc-live-{chain-id}: the live window of one chain (docs/storage.md, "Durable Objects").
//
//   /ingest/*  the nullrpc daemon's writes, with `Authorization: Bearer INGEST_TOKEN`:
//     GET  /ingest/state     ChainDO pointers
//     POST /ingest/init      {promoted, generation}: first start after the backfill
//     POST /ingest/blocks    {rows: [{first, last, chain, shards: {i: data}}], head, safe, finalized,
//                            network_head?}
//                            one row per group of blocks (base64, sections per block): shard rows
//                            first, then ChainDO rows, then the head; network_head is the node's
//                            head, the status page's target
//     POST /ingest/reorg     {ancestor, removed: [{number, hash}]}: fence, lower the head, truncate
//     POST /ingest/prune     {promoted, generation}: after a promotion
//   LiveReads  the entrypoint the RPC Worker binds to read the live window.
//   LiveStatus the entrypoint the status dashboard binds to (service bindings only; no public route):
//     GET  /internal/status                 {chain: ChainStatus}
//     GET  /internal/history?range=1h|24h|7d  {bucket_s, from, to, retention_s, points}

import { WorkerEntrypoint } from "cloudflare:workers";
import { fromBase64, normalizeBlockId, normalizeKey, shardOf, unhex, DOMAIN, type BlockId } from "./codec";
import { HISTORY_RANGES, type ChainDO, type HistoryRange } from "./chain";
import type { Env } from "./env";
import type { PinnedManyResult, PinnedValue, StateShard } from "./shard";

export { ChainDO } from "./chain";
export { StateShard } from "./shard";

const chain = (env: Env): DurableObjectStub<ChainDO> => env.CHAIN.get(env.CHAIN.idFromName(env.CHAIN_ID));
const shard = (env: Env, i: number): DurableObjectStub<StateShard> => env.SHARD.get(env.SHARD.idFromName(`${env.CHAIN_ID}-${i}`));
const shardCount = (env: Env): number => {
  const n = Number(env.SHARDS);
  if (!Number.isInteger(n) || n < 1 || n > 256) throw new Error("SHARDS must be an integer from 1 to 256");
  return n;
};

function json(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function authorized(request: Request, env: Env): boolean {
  const token = env.INGEST_TOKEN;
  const got = request.headers.get("authorization") ?? "";
  if (!token || !got.startsWith("Bearer ")) return false;
  const a = new TextEncoder().encode(got.slice(7));
  const b = new TextEncoder().encode(token);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

const blockId = normalizeBlockId;

/** Most keys per getPinnedMany call (the RPC Worker's StateSource reads at most 256 per round). */
const MAX_BATCH = 1024;

interface IngestRow {
  first: number;
  last: number;
  chain: string;
  shards: Record<string, string>;
}

async function ingest(request: Request, env: Env, path: string): Promise<Response> {
  const n = shardCount(env);
  const all = Array.from({ length: n }, (_, i) => i);
  if (path === "/ingest/state" && request.method === "GET") {
    return json({ chain_id: env.CHAIN_ID, ...(await chain(env).state()), shards: n });
  }
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const body = (await request.json()) as Record<string, unknown>;
  switch (path) {
    case "/ingest/init": {
      const st = await chain(env).init(blockId(body.promoted, "promoted"), Number(body.generation), n);
      return json(st);
    }
    case "/ingest/blocks": {
      const rows = body.rows as IngestRow[];
      if (!Array.isArray(rows) || rows.length === 0 || rows.length > 256) throw new Error("rows must hold 1 to 256 groups");
      const perShard = new Map<number, { first: number; last: number; data: Uint8Array }[]>();
      const chainRows = rows.map((r) => {
        if (!Number.isSafeInteger(r.first) || !Number.isSafeInteger(r.last) || r.first > r.last || r.first < 0) throw new Error("invalid row range");
        for (const [i, data] of Object.entries(r.shards ?? {})) {
          const s = Number(i);
          if (!Number.isInteger(s) || s < 0 || s >= n) throw new Error(`invalid shard ${i}`);
          let list = perShard.get(s);
          if (!list) perShard.set(s, (list = []));
          list.push({ first: r.first, last: r.last, data: fromBase64(data) });
        }
        return { first: r.first, last: r.last, data: fromBase64(r.chain) };
      });
      // Shards first, then the block rows, then the head: a block is visible only complete.
      await Promise.all([...perShard].map(([s, list]) => shard(env, s).applyMany(list)));
      await chain(env).putRows(chainRows);
      const head = blockId(body.head, "head");
      await chain(env).setHead(
        head,
        body.safe ? blockId(body.safe, "safe") : null,
        body.finalized ? blockId(body.finalized, "finalized") : null,
        body.network_head ? blockId(body.network_head, "network_head") : null,
      );
      return json({ head });
    }
    case "/ingest/reorg": {
      const ancestor = blockId(body.ancestor, "ancestor");
      const removed = (body.removed as unknown[]).map((b) => blockId(b, "removed block"));
      // Fence, lower the head, then truncate: a pinned reader is told it is stale before any row changes.
      await Promise.all([...all.map((i) => shard(env, i).fence(removed)), chain(env).fence(removed)]);
      await chain(env).setHead(ancestor, null, null);
      await Promise.all([...all.map((i) => shard(env, i).truncateAbove(ancestor.number)), chain(env).truncateAbove(ancestor.number)]);
      return json({ head: ancestor });
    }
    case "/ingest/prune": {
      const promoted = blockId(body.promoted, "promoted");
      const generation = Number(body.generation);
      if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("invalid generation");
      await Promise.all(all.map((i) => shard(env, i).pruneAtOrBelow(promoted.number)));
      await chain(env).pruneAtOrBelow(promoted, generation);
      return json({ promoted, generation });
    }
  }
  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/ingest/")) return json({ error: "not found" }, 404);
    if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
    try {
      return await ingest(request, env, url.pathname);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`${request.method} ${url.pathname}: ${message}`);
      ctx.waitUntil(chain(env).noteError(`${url.pathname}: ${message}`).catch(() => {}));
      return json({ error: message }, 400);
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Reads of the live window for the RPC Worker (service binding with entrypoint LiveReads). Pins
 * are validated and their hashes lowercased; keys may carry 0x and any case.
 */
export class LiveReads extends WorkerEntrypoint<Env> {
  async state() {
    return chain(this.env).state();
  }
  async block(numberOrHash: number | string, pin: BlockId) {
    return chain(this.env).block(numberOrHash, normalizeBlockId(pin, "pin"));
  }
  async witness(number: number, pin: BlockId) {
    return chain(this.env).witness(number, normalizeBlockId(pin, "pin"));
  }
  async txBlock(txHash: string, pin: BlockId) {
    return chain(this.env).txBlock(txHash, normalizeBlockId(pin, "pin"));
  }
  /** domain: 1 accounts, 2 storage, 3 code; keyHex with or without 0x. */
  async getPinned(domain: number, keyHex: string, n: number, pin: BlockId) {
    const key = normalizeKey(domain, keyHex);
    const s = shardOf(domain, unhex(key), shardCount(this.env));
    return shard(this.env, s).getPinned(domain, key, n, normalizeBlockId(pin, "pin"));
  }
  /**
   * getPinned for many keys in one service call: `{domain, key}` per key, grouped by shard
   * here and answered in order. Stale when any shard says the pin is (a reorg fences the shards
   * one by one, so the first to know makes the whole batch stale and the caller re-pins).
   */
  async getPinnedMany(keys: { domain: number; key: string }[], n: number, pin: BlockId): Promise<PinnedManyResult> {
    if (!Array.isArray(keys) || keys.length > MAX_BATCH) throw new TypeError(`at most ${MAX_BATCH} keys per batch`);
    const shards = shardCount(this.env);
    const at = normalizeBlockId(pin, "pin");
    const groups = new Map<number, { domain: number; key: string; index: number }[]>();
    keys.forEach((k, index) => {
      const domain = Number(k?.domain);
      const key = normalizeKey(domain, k?.key);
      const s = shardOf(domain, unhex(key), shards);
      let group = groups.get(s);
      if (!group) groups.set(s, (group = []));
      group.push({ domain, key, index });
    });
    const values: PinnedValue[] = new Array(keys.length);
    const answers = await Promise.all([...groups].map(async ([s, group]) => {
      const r = await shard(this.env, s).getPinnedMany(group.map(({ domain, key }) => ({ domain, key })), n, at);
      if (r.stale) return true;
      group.forEach((g, i) => (values[g.index] = r.values[i]!));
      return false;
    }));
    if (answers.some((stale) => stale)) return { stale: true };
    return { stale: false, values };
  }
  async scanPinned(addressHex: string, n: number, pin: BlockId) {
    const address = normalizeKey(DOMAIN.accounts, addressHex);
    const s = shardOf(DOMAIN.storage, unhex(address), shardCount(this.env));
    return shard(this.env, s).scanPinned(address, n, normalizeBlockId(pin, "pin"));
  }
}

/** Pipeline status for the status dashboard (service binding with entrypoint LiveStatus). */
export class LiveStatus extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
    switch (url.pathname) {
      case "/internal/status":
        return json({ chain: { chain_id: this.env.CHAIN_ID, ...(await chain(this.env).status()) } });
      case "/internal/history": {
        const range = url.searchParams.get("range") ?? "1h";
        if (!Object.hasOwn(HISTORY_RANGES, range)) return json({ error: "range must be one of 1h, 24h, 7d" }, 400);
        return json(await chain(this.env).history(range as HistoryRange));
      }
    }
    return json({ error: "not found" }, 404);
  }
}
