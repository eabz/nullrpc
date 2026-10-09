// nullrpc RPC Worker: one chain's JSON-RPC, answered from the R2 archive (genesis to P) and the
// live window (P+1 to head, LIVE binding). docs/storage.md is the data contract.
//
//   POST /, /<key>     JSON-RPC 2.0, single request or batch (at most MAX_BATCH items)
//   GET  /             the endpoint page (text/html), else a short JSON description
//   GET  /status.json  chain status for the page, the landing page and the status dashboard
//
// Access (ACCESS = "keys"): API keys and keyless clients, credit leases from the account app
// (APP binding, entrypoint `Access`), and per-plan requests per second (src/access).

import { credits, estimate, INVALID } from "./access/credits";
import { INVALID_KEY, KEY_REQUIRED, PUBLIC_RATE_LIMITED, RATE_LIMITED, refusal, TOO_LARGE, type Refusal } from "./access/errors";
import { caller, keyFrom, verifyKey, type Caller } from "./access/identity";
import { Ledger, type AccessApi } from "./access/ledger";
import { limitByPlan, takePublic, takeStrict, type RateLimiter } from "./access/rate";
import { Archive } from "./archive/archive";
import { archiveCacheHeader, CachedSource, type ArchiveCacheCounter } from "./archive/cached";
import { R2Source } from "./archive/source";
import { ArchiveError } from "./archive/types";
import { Chain, type ExecStats } from "./chain";
import { Live, type LiveApi } from "./live";
import { METHODS } from "./methods";
import { pageResponse, statusResponse, usageResponse, type PageConfig } from "./page/page";
import { ResponseCache, responseCacheHeader, type CacheStatus } from "./response-cache";
import { errorResponse, MAX_BATCH, RpcError, validate, type MethodEnv, type RpcRequest } from "./rpc";
import type { ExecutorApi } from "./executor";
import { executor as localExecutor } from "@nullrpc/executor";

export interface Env {
  ARCHIVE: R2Bucket;
  /** `{chain-id}-{genesis-hash}`: the archive's top-level prefix in the bucket. */
  ARCHIVE_PREFIX: string;
  CHAIN_ID: string;
  CHAIN_NAME?: string;
  /** Status dashboard origin for the page's usage charts; "off" hides them. */
  STATUS_URL?: string;
  /** The chain's nullrpc-live-{id} Worker, entrypoint LiveReads; without it only the archive is served. */
  LIVE?: LiveApi;
  /** "keys" enforces API keys, credits and rate limits; anything else serves openly (development). */
  ACCESS?: string;
  /** "off" refuses requests without a key. */
  PUBLIC?: string;
  /** Secret, the same value as the account app's KEY_SECRET. */
  KEY_SECRET?: string;
  /** The account app (nullrpc-app), entrypoint Access: credit leases. */
  APP?: AccessApi;
  /** The account app's RateBudget Durable Object: strict per-second limits for paid plans. */
  RATE_BUDGET?: DurableObjectNamespace;
  RPC_RATE_LIMIT_PUBLIC?: RateLimiter;
  RPC_RATE_LIMIT_FREE?: RateLimiter;
  RPC_RATE_LIMIT_BUILDER?: RateLimiter;
  RPC_RATE_LIMIT_GROWTH?: RateLimiter;
  RPC_RATE_LIMIT_SCALE?: RateLimiter;
  ASSETS?: Fetcher;
  /** Execution and tracing run in-process (@nullrpc/executor); bound, the executor Worker
   *  (nullrpc-executor, entrypoint Executor) runs them instead. */
  EXECUTOR?: ExecutorApi;
  /** HTTPS JSON-RPC endpoint transactions are relayed to (eth_sendRawTransaction). */
  RELAY_URL?: string;
}

const MAX_BODY = 256 * 1024;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-api-key",
  "access-control-max-age": "86400",
  "access-control-expose-headers": "retry-after, x-nullrpc-archive-cache, x-nullrpc-response-cache, x-nullrpc-exec",
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS, ...headers } });
}

function refuse(r: Refusal): Response {
  return json(errorResponse(null, new RpcError(r.code, r.message)), r.http, r.retryAfter ? { "retry-after": String(r.retryAfter) } : {});
}

function pageConfig(env: Env): PageConfig {
  const status = env.STATUS_URL?.trim();
  return {
    chainId: Number(env.CHAIN_ID),
    name: env.CHAIN_NAME?.trim() || (env.CHAIN_ID === "1" ? "Ethereum" : `Chain ${env.CHAIN_ID}`),
    statusUrl: status === "off" ? null : status || "https://status.nullrpc.dev",
    keys: env.ACCESS === "keys",
  };
}

/** The data center's cache, when the runtime has one (not in tests or on workers.dev). */
function edgeCache(): Cache | null {
  return typeof caches !== "undefined" ? caches.default : null;
}

/**
 * The chain for one request, reading the archive through the edge cache (src/archive/cached.ts);
 * `reads` counts this request's cache hits and misses.
 */
async function openChain(env: Env, ctx: ExecutionContext, origin: string): Promise<{ chain: Chain; reads: ArchiveCacheCounter }> {
  const bucket = new R2Source(env.ARCHIVE);
  const source = new CachedSource(bucket, edgeCache(), origin, (p) => ctx.waitUntil(p));
  const archive = new Archive(source, env.ARCHIVE_PREFIX);
  // The live pointers come from live/HEAD.json next to the archive (src/live.ts), read from the
  // bucket and kept 2 s in the edge cache under their own key (not the archive's day-long one);
  // the service binding is the fallback and the authority after a reorg.
  // Live block records and the transaction index are immutable and read like archive objects,
  // through the day-long edge cache.
  const live = env.LIVE ? new Live(env.LIVE, { source: bucket, prefix: env.ARCHIVE_PREFIX, cache: edgeCache(), archive: source }) : null;
  return { chain: await Chain.open(archive, live), reads: source.counter };
}

// One ledger per isolate (per APP binding object).
const ledgers = new WeakMap<AccessApi, Ledger>();
function ledgerFor(app: AccessApi): Ledger {
  let l = ledgers.get(app);
  if (!l) ledgers.set(app, (l = new Ledger(app)));
  return l;
}

type RpcResponse = { jsonrpc: string; id: RpcRequest["id"]; result?: unknown; error?: { code: number; message: string } };

async function call(chain: Chain, req: RpcRequest, menv: MethodEnv, responses: ResponseCache): Promise<RpcResponse & { cache: CacheStatus }> {
  const handler = METHODS[req.method];
  if (!handler) return { ...errorResponse(req.id, new RpcError(-32601, `the method ${req.method} does not exist/is not available`)), cache: "bypass" };
  const params = req.params ?? [];
  try {
    const { result, status } = await responses.serve(chain, req.method, params, () => handler(chain, params, menv));
    return { jsonrpc: "2.0", id: req.id, result, cache: status };
  } catch (e) {
    if (e instanceof RpcError) return { ...errorResponse(req.id, e), cache: "bypass" };
    console.error(JSON.stringify({ event: "rpc_error", method: req.method, error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }));
    return { ...errorResponse(req.id, new RpcError(-32603, e instanceof ArchiveError ? "archive unavailable" : "internal error")), cache: "bypass" };
  }
}

/** Reads the body, refusing anything above MAX_BODY without buffering more than that. */
async function readBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  return new TextDecoder().decode(all);
}

/** Who is calling, or a refusal; null when access control is off. */
async function identify(request: Request, env: Env): Promise<Caller | Refusal | null> {
  if (env.ACCESS !== "keys") return null;
  if (!env.KEY_SECRET || !env.APP) return { http: 503, code: -32603, message: "API keys are not configured" };
  const key = keyFrom(request);
  let keyId: string | null = null;
  if (key) {
    keyId = await verifyKey(env.KEY_SECRET, key);
    if (!keyId) return INVALID_KEY;
  } else if (env.PUBLIC === "off") return KEY_REQUIRED;
  return caller(env.KEY_SECRET, request, keyId);
}

async function rpc(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const who = await identify(request, env);
  if (who && "http" in who) return refuse(who);
  const ledger = who && env.APP ? ledgerFor(env.APP) : null;
  if (who && ledger) {
    // Checks that need neither the body nor any I/O come first.
    if (!who.keyed && !takePublic(who.rateKey)) return refuse(PUBLIC_RATE_LIMITED);
    const cached = ledger.refusal(who);
    if (cached) return refuse(refusal(cached, who.keyed));
  }

  const text = await readBody(request);
  if (text === null) return refuse(TOO_LARGE);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(errorResponse(null, new RpcError(-32700, "parse error")));
  }
  const batch = Array.isArray(body);
  const items = batch ? (body as unknown[]) : [body];
  if (batch && items.length === 0) return json(errorResponse(null, new RpcError(-32600, "empty batch")));
  if (items.length > MAX_BATCH) return json(errorResponse(null, new RpcError(-32600, `batch too large (at most ${MAX_BATCH})`)));

  // Credits: reserve the worst case, serve, then settle the actual cost.
  const worst = estimate(items);
  let admitted: Awaited<ReturnType<Ledger["admit"]>> | null = null;
  if (who && ledger) {
    admitted = await ledger.admit(who, worst);
    if (!admitted.ok) return refuse(refusal(admitted.status, who.keyed));
    const { ent } = admitted;
    const limitKey = ent.account ?? (who.keyed ? who.subject : who.rateKey);
    const allowed =
      (await limitByPlan(env, ent.plan, limitKey)) && (!ent.limiter || !ent.account || (await takeStrict(env.RATE_BUDGET, ent.account, ent.rps)));
    if (!allowed) {
      ledger.release(admitted.line, worst);
      return refuse(RATE_LIMITED);
    }
  }

  let results: RpcResponse[];
  const statuses: CacheStatus[] = [];
  let reads: ArchiveCacheCounter = { hit: 0, miss: 0 };
  let exec: ExecStats | null = null;
  try {
    const origin = new URL(request.url).origin;
    const opened = await openChain(env, ctx, origin);
    reads = opened.reads;
    const chain = opened.chain;
    exec = chain.exec;
    const menv: MethodEnv = { chainId: Number(env.CHAIN_ID), relayUrl: env.RELAY_URL, executor: env.EXECUTOR ?? localExecutor };
    const responses = new ResponseCache(edgeCache(), origin, Number(env.CHAIN_ID), (p) => ctx.waitUntil(p));
    results = await Promise.all(items.map(async (item, i) => {
      const req = validate(item);
      if ("error" in req) {
        statuses[i] = "bypass";
        return req as RpcResponse;
      }
      const { cache, ...res } = await call(chain, req, menv, responses);
      statuses[i] = cache;
      return res;
    }));
  } catch (e) {
    if (admitted?.ok) ledger!.release(admitted.line, worst);
    console.error(JSON.stringify({ event: "pin_error", error: e instanceof Error ? e.message : String(e) }));
    return json(errorResponse(null, new RpcError(-32603, "archive unavailable")), 503);
  }

  if (admitted?.ok && ledger) {
    let cost = 0;
    items.forEach((item, i) => {
      const it = item as { method?: unknown; params?: unknown } | null;
      cost += credits(it?.method, it?.params, results[i]?.error?.code);
    });
    ledger.settle(admitted.line, worst, Math.max(INVALID, cost));
    ctx.waitUntil(ledger.renewDue());
  }
  const headers: Record<string, string> = { "x-nullrpc-archive-cache": archiveCacheHeader(reads), "x-nullrpc-response-cache": responseCacheHeader(statuses, batch) };
  // What the executions of this request read (bench/README.md, "Execution").
  if (exec && (exec.rounds || exec.hints)) headers["x-nullrpc-exec"] = `rounds=${exec.rounds} keys=${exec.keys} hints=${exec.hints} live=${exec.live} archive=${exec.archive}`;
  return json(batch ? results : results[0], 200, headers);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method === "POST") return rpc(request, env, ctx);
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method not allowed" }, 405);
    const cfg = pageConfig(env);
    if (url.pathname === "/status.json") return statusResponse(request, cfg, () => openChain(env, ctx, url.origin).then((o) => o.chain), ctx);
    if (url.pathname === "/_status/usage") return usageResponse(request, cfg, ctx);
    if ((url.pathname.startsWith("/_page/") || url.pathname === "/favicon.ico") && env.ASSETS) return env.ASSETS.fetch(request);
    return pageResponse(request, cfg) ?? json({ name: "nullrpc", chain_id: cfg.chainId, protocol: "JSON-RPC 2.0 over HTTPS POST", docs: "https://nullrpc.dev", status: "/status.json" });
  },
} satisfies ExportedHandler<Env>;
