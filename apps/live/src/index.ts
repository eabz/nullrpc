// nullrpc-live-{chain-id}: the live window of one chain (docs/storage.md, "Durable Objects").
//
//   /ingest/*  the nullrpc daemon's writes, with `Authorization: Bearer INGEST_TOKEN`:
//     GET  /ingest/state     ChainDO pointers
//     POST /ingest/init      {promoted, generation}: first start after the backfill
//     POST /ingest/blocks    {rows: [{first, last, chain, shards: {i: data}}], head, safe, finalized}
//                            one row per group of blocks (base64, sections per block): shard rows
//                            first, then ChainDO rows, then the head
//     POST /ingest/reorg     {ancestor, removed: [{number, hash}]}: fence, lower the head, truncate
//     POST /ingest/prune     {promoted, generation}: after a promotion
//   LiveReads  the entrypoint the RPC Worker binds to read the live window.

import { WorkerEntrypoint } from "cloudflare:workers";
import type { ChainDO } from "./chain";
import { fromBase64, unhex, shardOf, DOMAIN, type BlockId } from "./codec";
import type { Env } from "./env";
import type { StateShard } from "./shard";

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

function blockId(v: unknown, what: string): BlockId {
  const b = v as BlockId;
  if (!b || !Number.isSafeInteger(b.number) || b.number < 0 || typeof b.hash !== "string" || !/^0x[0-9a-f]{64}$/.test(b.hash)) {
    throw new Error(`invalid ${what}`);
  }
  return { number: b.number, hash: b.hash };
}

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
      await chain(env).setHead(head, body.safe ? blockId(body.safe, "safe") : null, body.finalized ? blockId(body.finalized, "finalized") : null);
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
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/ingest/")) return json({ error: "not found" }, 404);
    if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
    try {
      return await ingest(request, env, url.pathname);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`${request.method} ${url.pathname}: ${message}`);
      return json({ error: message }, 400);
    }
  },
} satisfies ExportedHandler<Env>;

/** Reads of the live window for the RPC Worker (service binding with entrypoint LiveReads). */
export class LiveReads extends WorkerEntrypoint<Env> {
  async state() {
    return chain(this.env).state();
  }
  async block(numberOrHash: number | string, pin: BlockId) {
    return chain(this.env).block(numberOrHash, pin);
  }
  async witness(number: number, pin: BlockId) {
    return chain(this.env).witness(number, pin);
  }
  async txBlock(txHash: string, pin: BlockId) {
    return chain(this.env).txBlock(txHash, pin);
  }
  /** domain: 1 accounts, 2 storage, 3 code; keyHex without 0x. */
  async getPinned(domain: number, keyHex: string, n: number, pin: BlockId) {
    const s = shardOf(domain, unhex(keyHex), shardCount(this.env));
    return shard(this.env, s).getPinned(domain, keyHex.toLowerCase(), n, pin);
  }
  async scanPinned(addressHex: string, n: number, pin: BlockId) {
    const s = shardOf(DOMAIN.storage, unhex(addressHex), shardCount(this.env));
    return shard(this.env, s).scanPinned(addressHex.toLowerCase(), n, pin);
  }
}
