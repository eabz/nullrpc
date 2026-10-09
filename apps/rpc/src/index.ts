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
import { R2Source } from "./archive/source";
import { ArchiveError } from "./archive/types";
import { Chain } from "./chain";
import { Live, type LiveApi } from "./live";
import { METHODS } from "./methods";
import { pageResponse, statusResponse, usageResponse, type PageConfig } from "./page/page";
import { errorResponse, MAX_BATCH, RpcError, validate, type MethodEnv, type RpcRequest } from "./rpc";
import type { ExecutorApi } from "./executor";

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
  /** The executor Worker (nullrpc-executor, entrypoint Executor): execution and tracing. */
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

function openChain(env: Env): Promise<Chain> {
  const archive = new Archive(new R2Source(env.ARCHIVE), env.ARCHIVE_PREFIX);
  return Chain.open(archive, env.LIVE ? new Live(env.LIVE) : null);
}

// One ledger per isolate (per APP binding object).
const ledgers = new WeakMap<AccessApi, Ledger>();
function ledgerFor(app: AccessApi): Ledger {
  let l = ledgers.get(app);
  if (!l) ledgers.set(app, (l = new Ledger(app)));
  return l;
}

type RpcResponse = { jsonrpc: string; id: RpcRequest["id"]; result?: unknown; error?: { code: number; message: string } };

async function call(chain: Chain, req: RpcRequest, menv: MethodEnv): Promise<RpcResponse> {
  const handler = METHODS[req.method];
  if (!handler) return errorResponse(req.id, new RpcError(-32601, `the method ${req.method} does not exist/is not available`));
  try {
    return { jsonrpc: "2.0", id: req.id, result: await handler(chain, req.params ?? [], menv) };
  } catch (e) {
    if (e instanceof RpcError) return errorResponse(req.id, e);
    console.error(JSON.stringify({ event: "rpc_error", method: req.method, error: e instanceof Error ? e.message : String(e) }));
    return errorResponse(req.id, new RpcError(-32603, e instanceof ArchiveError ? "archive unavailable" : "internal error"));
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
  try {
    const chain = await openChain(env);
    const menv: MethodEnv = { chainId: Number(env.CHAIN_ID), relayUrl: env.RELAY_URL, executor: env.EXECUTOR };
    results = await Promise.all(items.map((item) => {
      const req = validate(item);
      return "error" in req ? (req as RpcResponse) : call(chain, req, menv);
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
  return json(batch ? results : results[0]);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method === "POST") return rpc(request, env, ctx);
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method not allowed" }, 405);
    const cfg = pageConfig(env);
    if (url.pathname === "/status.json") return statusResponse(request, cfg, () => openChain(env), ctx);
    if (url.pathname === "/_status/usage") return usageResponse(request, cfg, ctx);
    if ((url.pathname.startsWith("/_page/") || url.pathname === "/favicon.ico") && env.ASSETS) return env.ASSETS.fetch(request);
    return pageResponse(request, cfg) ?? json({ name: "nullrpc", chain_id: cfg.chainId, protocol: "JSON-RPC 2.0 over HTTPS POST", docs: "https://nullrpc.dev", status: "/status.json" });
  },
} satisfies ExportedHandler<Env>;
