// nullrpc-dashboard: public status page for nullrpc.
//
//   /                     static page (public/, Workers static assets)
//   GET /api/chains       configured chains and whether analytics are enabled
//   GET /api/status?chain=ID
//                         live pipeline status via the LIVE_{ID} service binding
//                         (GET /internal/status)
//   GET /api/history?chain=ID&range=1h|24h|7d
//                         lag and block-rate history kept by the chain's ChainDO
//                         (same binding, GET /internal/history)
//   GET /api/analytics?range=1h|24h|7d&chain=ID|all
//                         RPC usage of the Workers nullrpc-rpc-{ID} from the GraphQL Analytics API
//   GET /api/pipeline?chain=ID
//                         public pipeline status from the chain's endpoint (/status.json)
//
// Everything is public and read-only: GET/HEAD (and CORS preflight) only, no cookies, `*` CORS.
// The API token (secret CF_ANALYTICS_TOKEN) is sent only to api.cloudflare.com and never
// appears in a response. Live status is never cached: every call reads the ChainDO. History,
// usage and pipeline responses are cached per colo with the Cache API, so page views do not
// translate 1:1 into upstream calls.
import { analytics, GraphQLApiError, isRange, pipeline, RANGES } from "./analytics";
import { CF_ACCOUNT_ID, chains, endpoint, liveBinding, type Env, type Chain } from "./env";

const ERROR_TTL_S = 15;
/** The endpoint caches its /status.json 5 s per colo; the page polls every 5 s. */
const PIPELINE_TTL_S = 5;
/** The ChainDO samples once a minute; 24 h / 7 d buckets are 5 min / 1 h wide. */
const HISTORY_TTL_S: Record<keyof typeof RANGES, number> = { "1h": 30, "24h": 60, "7d": 300 };

const BASE_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function json(v: unknown, status = 200, ttlS = 0): Response {
  return new Response(JSON.stringify(v), {
    status,
    headers: { ...BASE_HEADERS, "cache-control": ttlS > 0 ? `public, max-age=${ttlS}` : "no-store" },
  });
}

/** Serves `key` from the colo cache, or computes, caches (2xx and 5xx) and returns it. */
async function cached(
  key: string,
  ctx: ExecutionContext,
  compute: () => Promise<Response>,
): Promise<Response> {
  const cache = caches.default;
  const req = new Request(key);
  const hit = await cache.match(req);
  if (hit) {
    // Error responses are stored as 200 (the Cache API does not keep 5xx) with their status aside.
    const status = Number(hit.headers.get("x-stored-status") ?? hit.status);
    const h = new Response(hit.body, { status, headers: hit.headers });
    h.headers.delete("x-stored-status");
    // The zone may rewrite Cache-Control on stored entries (Browser Cache TTL); restore ours.
    const cc = hit.headers.get("x-stored-cache-control");
    if (cc) h.headers.set("cache-control", cc);
    h.headers.delete("x-stored-cache-control");
    h.headers.set("x-cache", "HIT");
    return h;
  }
  const res = await compute();
  if (/max-age=\d+/.test(res.headers.get("cache-control") ?? "")) {
    const stored = new Response(res.clone().body, { status: 200, headers: res.headers });
    stored.headers.set("x-stored-status", String(res.status));
    stored.headers.set("x-stored-cache-control", res.headers.get("cache-control") ?? "");
    ctx.waitUntil(cache.put(req, stored));
  }
  res.headers.set("x-cache", "MISS");
  return res;
}

async function status(url: URL, env: Env): Promise<Response> {
  const id = url.searchParams.get("chain");
  const chain = (await chains(env)).find((c) => c.id === id);
  if (!chain) return json({ error: "unknown chain" }, 400);
  const live = liveBinding(env, chain.id);
  if (!live) return endpointStatus(env, chain);
  try {
    const res = await live.fetch("https://live/internal/status");
    if (!res.ok) {
      console.error(`status ${chain.id}: live HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return json({ error: "live status unavailable", upstream_status: res.status }, 502);
    }
    const body = (await res.json()) as { chain?: unknown };
    return json({ chain_id: chain.id, name: chain.name, fetched_at: Date.now(), status: body.chain ?? null });
  } catch (e) {
    console.error(`status ${chain.id}: ${e instanceof Error ? e.message : String(e)}`);
    return json({ error: "live status unavailable" }, 502);
  }
}

/**
 * Chain status from the RPC endpoint's /status.json (served by the RPC Worker), in the live
 * pipeline's shape: the newest served block is the executed head, and the target is the head
 * the chain should have reached by now at 12-second slots, so lag counts blocks the endpoint is
 * behind (missed slots make it a slight overestimate).
 */
async function endpointStatus(env: Env, chain: Chain): Promise<Response> {
  const origin = endpoint(env, chain);
  if (!origin) return json({ error: "no endpoint for this chain", chain_id: chain.id }, 404);
  try {
    const res = await fetch(`${origin}/status.json`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return json({ error: "endpoint status unavailable", upstream_status: res.status }, 502);
    const s = (await res.json()) as {
      latest?: { number?: number; hash?: string; timestamp?: number | null };
      finalized?: { number?: number; hash?: string; timestamp?: number | null };
      safe?: number;
      archived_through?: number;
      state?: string;
    };
    const now = Date.now();
    const head = s.latest && typeof s.latest.number === "number" ? s.latest : null;
    const age = head && typeof head.timestamp === "number" ? Math.max(0, now / 1000 - head.timestamp) : null;
    const lag = age === null ? null : Math.max(0, Math.floor(age / 12) - 1);
    const block = (b: typeof head) => (b && typeof b.number === "number" ? { number: b.number, hash: b.hash ?? null, timestamp: b.timestamp ?? null } : null);
    return json({
      chain_id: chain.id,
      name: chain.name,
      fetched_at: now,
      source: "endpoint",
      status: {
        at: now,
        executed_head: block(head),
        target: head && lag !== null ? { number: head.number! + lag } : null,
        lag,
        finalized: block(s.finalized ?? null),
        optimistic: typeof s.safe === "number" ? { number: s.safe } : null,
        archived_through: typeof s.archived_through === "number" ? { number: s.archived_through } : null,
        last_progress: head && typeof head.timestamp === "number" ? head.timestamp * 1000 : null,
        halted: s.state === "unavailable",
        last_error: s.state === "delayed" ? "new blocks are delayed" : null,
      },
    });
  } catch (e) {
    console.error(`status ${chain.id}: ${e instanceof Error ? e.message : String(e)}`);
    return json({ error: "endpoint status unavailable" }, 502);
  }
}

/** History of one chain's live pipeline (samples once a minute in its ChainDO). */
async function historyRoute(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const range = url.searchParams.get("range") ?? "1h";
  if (!isRange(range)) return json({ error: "range must be one of 1h, 24h, 7d" }, 400);
  const chain = (await chains(env)).find((c) => c.id === url.searchParams.get("chain"));
  if (!chain) return json({ error: "unknown chain" }, 400);
  const live = liveBinding(env, chain.id);
  // Without a live pipeline there are no per-minute samples yet: an empty history.
  if (!live) return json({ chain_id: chain.id, name: chain.name, range, bucket_s: 60, from: null, to: null, retention_s: 0, generated_at: Date.now(), points: [] });
  // The key holds only validated values, so query strings cannot bust or poison the cache.
  return cached(`${url.origin}/api/history?chain=${chain.id}&range=${range}`, ctx, async () => {
    try {
      const res = await live.fetch(`https://live/internal/history?range=${range}`);
      if (!res.ok) {
        console.error(`history ${chain.id} ${range}: live HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        return json({ error: "live history unavailable", upstream_status: res.status }, 502, ERROR_TTL_S);
      }
      const h = (await res.json()) as { bucket_s?: unknown; from?: unknown; to?: unknown; retention_s?: unknown; points?: unknown };
      if (!Array.isArray(h.points)) throw new Error("malformed history response");
      return json(
        {
          chain_id: chain.id,
          name: chain.name,
          range,
          bucket_s: h.bucket_s,
          from: h.from,
          to: h.to,
          retention_s: h.retention_s,
          generated_at: Date.now(),
          points: h.points,
        },
        200,
        HISTORY_TTL_S[range],
      );
    } catch (e) {
      console.error(`history ${chain.id} ${range}: ${e instanceof Error ? e.message : String(e)}`);
      return json({ error: "live history unavailable" }, 502, ERROR_TTL_S);
    }
  });
}

async function analyticsRoute(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const range = url.searchParams.get("range") ?? "1h";
  if (!isRange(range)) return json({ error: "range must be one of 1h, 24h, 7d" }, 400);
  const all = await chains(env);
  const chainParam = url.searchParams.get("chain") ?? "all";
  const chainIds = chainParam === "all" ? all.map((c) => c.id) : all.filter((c) => c.id === chainParam).map((c) => c.id);
  if (chainIds.length === 0) return json({ error: "unknown chain" }, 400);
  const token = env.CF_ANALYTICS_TOKEN;
  const account = CF_ACCOUNT_ID;
  if (!token || !/^[0-9a-f]{32}$/.test(account)) {
    return json({ configured: false, error: "analytics are not configured on this deployment" }, 503, 60);
  }
  // The key holds only validated values, so query strings cannot bust or poison the cache.
  return cached(`${url.origin}/api/analytics?range=${range}&chain=${chainParam}`, ctx, async () => {
    try {
      const out = await analytics(fetch, { account, token, chain: chainParam, chainIds, range });
      return json(out, 200, RANGES[range].ttlS);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`analytics ${range} ${chainParam}: ${msg.replaceAll(token, "[redacted]")}`);
      const reason = e instanceof GraphQLApiError ? "analytics query failed" : "analytics unavailable";
      return json({ configured: true, error: reason }, 502, ERROR_TTL_S);
    }
  });
}

/** Public pipeline status of one chain, read from its RPC endpoint's /status.json. */
async function pipelineRoute(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const chain = (await chains(env)).find((c) => c.id === url.searchParams.get("chain"));
  if (!chain) return json({ error: "unknown chain" }, 400);
  const origin = endpoint(env, chain);
  if (!origin) return json({ error: "no endpoint configured for this chain", chain_id: chain.id }, 404);
  return cached(`${url.origin}/api/pipeline?chain=${chain.id}`, ctx, async () => {
    try {
      const out = await pipeline(fetch, { chain: chain.id, url: `${origin}/status.json` });
      return json(out, 200, PIPELINE_TTL_S);
    } catch (e) {
      console.error(`pipeline ${chain.id}: ${e instanceof Error ? e.message : String(e)}`);
      return json({ configured: true, error: "pipeline status unavailable" }, 502, ERROR_TTL_S);
    }
  });
}

export async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) {
    // Static assets are served before the Worker; anything reaching here is a miss.
    return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: "not found" }, 404);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...BASE_HEADERS, "access-control-max-age": "86400" } });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { ...BASE_HEADERS, allow: "GET, HEAD, OPTIONS", "cache-control": "no-store" },
    });
  }
  let res: Response;
  switch (url.pathname) {
    case "/api/chains":
      res = json({ chains: await chains(env), analytics: !!env.CF_ANALYTICS_TOKEN }, 200, 60);
      break;
    case "/api/status":
      res = await status(url, env);
      break;
    case "/api/history":
      res = await historyRoute(url, env, ctx);
      break;
    case "/api/analytics":
      res = await analyticsRoute(url, env, ctx);
      break;
    case "/api/pipeline":
      res = await pipelineRoute(url, env, ctx);
      break;
    default:
      res = json({ error: "not found" }, 404);
  }
  return request.method === "HEAD" ? new Response(null, res) : res;
}

export default { fetch: handle } satisfies ExportedHandler<Env>;
