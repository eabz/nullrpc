// Same-origin data for the landing page's endpoints section.
// The page's CSP keeps `connect-src 'self'`: the browser only talks to nullrpc.dev, and this
// Worker reads the public sources server-side:
//   GET /api/networks         each endpoint's GET /status.json (the RPC Worker's public status)
//   GET /api/usage?chain=ID&range=R  requests and data egress of nullrpc-rpc-{ID} (one listed endpoint),
//                             from the Cloudflare GraphQL Analytics API (secret CF_ANALYTICS_TOKEN)
// Both are cached per data center (Cache API) so page views do not multiply upstream reads.
// Only numbers and fixed words are copied from upstream responses.

/** The Cloudflare account of the RPC Worker (GraphQL accountTag). */
export const CF_ACCOUNT_ID = "60401d41768f5312f816303569019bb5";

/** The endpoints the page lists. Keep in sync with public/index.html. */
export const NETWORKS = [
  { chain_id: 1, name: "Ethereum mainnet", url: "https://eth.nullrpc.dev" },
] as const;

/** Bucket, span and cache lifetime per range (GraphQL allows at most a week per query). */
export const RANGES = {
  "1h": { dimension: "datetimeMinute", bucketS: 60, spanS: 3600, ttlS: 30 },
  "24h": { dimension: "datetimeFifteenMinutes", bucketS: 900, spanS: 86400, ttlS: 60 },
  "7d": { dimension: "datetimeHour", bucketS: 3600, spanS: 7 * 86400, ttlS: 300 },
} as const;
export type Range = keyof typeof RANGES;
export const isRange = (v: string | null): v is Range => v !== null && Object.hasOwn(RANGES, v);

const NETWORKS_TTL_S = 5;
const STATES = new Set(["following", "catching_up", "delayed", "archive", "serving", "unavailable"]);

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const block = (v: unknown) =>
  v && typeof v === "object"
    ? { number: count((v as { number?: unknown }).number), timestamp: count((v as { timestamp?: unknown }).timestamp) }
    : { number: count(v), timestamp: null };

export interface NetworkStatus {
  chain_id: number;
  name: string;
  url: string;
  state: string;
  latest: { number: number | null; timestamp: number | null };
  finalized: number | null;
  archived_through: number | null;
  peers: number | null;
}

/** One endpoint's public status; `unavailable` when it cannot be read or is another chain. */
export async function networkStatus(fetcher: Fetcher, n: (typeof NETWORKS)[number]): Promise<NetworkStatus> {
  const down: NetworkStatus = {
    chain_id: n.chain_id, name: n.name, url: n.url, state: "unavailable",
    latest: { number: null, timestamp: null }, finalized: null, archived_through: null, peers: null,
  };
  try {
    const res = await fetcher(`${n.url}/status.json`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return (await res.body?.cancel(), down);
    const s = (await res.json()) as Record<string, unknown>;
    if (!s || typeof s !== "object" || Number(s.chain_id) !== n.chain_id) return down;
    return {
      ...down,
      state: typeof s.state === "string" && STATES.has(s.state) ? s.state : "unavailable",
      latest: block(s.latest),
      finalized: block(s.finalized).number,
      archived_through: count(s.archived_through),
      peers: count(s.peers),
    };
  } catch {
    return down;
  }
}

export async function networks(fetcher: Fetcher, now = Date.now()) {
  return { generated_at: now, networks: await Promise.all(NETWORKS.map((n) => networkStatus(fetcher, n))) };
}

export interface Usage {
  available: boolean;
  chain_id: number;
  range: Range;
  bucket_s: number;
  from: number;
  to: number;
  totals: { requests: number; response_bytes: number };
  /** [t (unix s), requests, response bytes] per bucket, oldest first, no gaps. */
  series: [number, number, number][];
}

export const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

/** The GraphQL query of a range: requests and response body bytes per bucket of one script. */
export function usageQuery(range: Range): string {
  const d = RANGES[range].dimension;
  return `query Usage($account: string!, $scripts: [string!], $from: Time!, $to: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      series: workersInvocationsAdaptive(
        limit: 10000
        filter: { scriptName_in: $scripts, datetime_geq: $from, datetime_lt: $to }
        orderBy: [${d}_ASC]
      ) {
        dimensions { t: ${d} }
        sum { requests responseBodySize }
      }
    }
  }
}`;
}

/**
 * Requests and data egress of one listed endpoint's RPC Worker (`nullrpc-rpc-{chain_id}`), from
 * the Workers dataset of the GraphQL Analytics API. `responseBodySize` is the bytes of the
 * response bodies the Workers returned. The token (Account Analytics: Read) only goes to
 * api.cloudflare.com and is never echoed.
 */
export async function usage(
  fetcher: Fetcher,
  opts: { account: string; token: string; chainId: number; range: Range; now?: number },
): Promise<Usage> {
  const r = RANGES[opts.range];
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const last = Math.floor(now / r.bucketS) * r.bucketS; // start of the current, partial bucket
  const from = last - r.spanS + r.bucketS;
  const none: Usage = { available: false, chain_id: opts.chainId, range: opts.range, bucket_s: r.bucketS, from, to: last + r.bucketS, totals: { requests: 0, response_bytes: 0 }, series: [] };
  if (!/^[0-9a-f]{32}$/.test(opts.account) || !opts.token) return none;
  const iso = (t: number) => new Date(t * 1000).toISOString().replace(/\.000Z$/, "Z");
  let rows: { dimensions?: { t?: unknown }; sum?: { requests?: unknown; responseBodySize?: unknown } }[];
  try {
    const res = await fetcher(GRAPHQL_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: usageQuery(opts.range),
        variables: { account: opts.account, scripts: [`nullrpc-rpc-${opts.chainId}`], from: iso(from), to: iso(last + r.bucketS) },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as {
      data?: { viewer?: { accounts?: { series?: typeof rows }[] } };
      errors?: { message?: string }[] | null;
    } | null;
    if (!res.ok || !body || (body.errors && body.errors.length > 0)) {
      const why = body?.errors?.map((e) => e.message ?? "").join("; ") ?? `HTTP ${res.status}`;
      console.error(`usage ${opts.range}: ${why.slice(0, 300).replaceAll(opts.token, "[redacted]")}`);
      return none;
    }
    rows = body.data?.viewer?.accounts?.[0]?.series ?? [];
  } catch (e) {
    console.error(`usage ${opts.range}: ${String(e).slice(0, 300)}`);
    return none;
  }
  const byT = new Map<number, [number, number]>();
  for (const x of rows) {
    const t = Math.floor(Date.parse(String(x.dimensions?.t ?? "")) / 1000);
    if (!Number.isFinite(t)) continue;
    const b = byT.get(t) ?? [0, 0];
    b[0] += count(x.sum?.requests) ?? 0;
    b[1] += count(x.sum?.responseBodySize) ?? 0;
    byT.set(t, b);
  }
  const series: Usage["series"] = [];
  for (let t = from; t <= last; t += r.bucketS) series.push([t, ...(byT.get(t) ?? [0, 0])]);
  return {
    ...none,
    available: true,
    totals: {
      requests: series.reduce((s, x) => s + x[1], 0),
      response_bytes: series.reduce((s, x) => s + x[2], 0),
    },
    series,
  };
}

const json = (data: unknown, maxAge: number) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${maxAge}` },
  });

/** A failed upstream read is kept only briefly, so a short outage does not blank the page. */
const FAILURE_TTL_S = 10;

/** Serves a JSON route through the data center cache; `make` runs on a miss. */
async function cached(
  key: string,
  ctx: ExecutionContext | undefined,
  maxAge: number,
  make: () => Promise<object>,
): Promise<Response> {
  const cache = typeof caches !== "undefined" ? caches.default : undefined;
  const hit = await cache?.match(key).catch(() => undefined);
  if (hit) return hit;
  const data = await make();
  const failed = "available" in data && data.available === false;
  const res = json(data, failed ? Math.min(maxAge, FAILURE_TTL_S) : maxAge);
  if (cache) {
    const put = cache.put(key, res.clone()).catch(() => {});
    if (ctx) ctx.waitUntil(put);
    else await put;
  }
  return res;
}

/** Routes /api/*; null for any other path. */
export async function api(
  url: URL,
  env: { CF_ANALYTICS_TOKEN?: string },
  ctx: ExecutionContext | undefined,
  fetcher: Fetcher = fetch,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/")) return null;
  const err = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  if (url.pathname === "/api/networks") {
    return cached(`${url.origin}/api/networks`, ctx, NETWORKS_TTL_S, () => networks(fetcher));
  }
  if (url.pathname === "/api/usage") {
    const range = url.searchParams.get("range") ?? "24h";
    if (!isRange(range)) return err(400, "range must be one of 1h, 24h, 7d");
    const chainId = Number(url.searchParams.get("chain") ?? NETWORKS[0].chain_id);
    if (!NETWORKS.some((n) => n.chain_id === chainId)) return err(400, "unknown chain");
    const opts = { account: CF_ACCOUNT_ID, token: env.CF_ANALYTICS_TOKEN ?? "", chainId, range };
    return cached(`${url.origin}/api/usage?chain=${chainId}&range=${range}`, ctx, RANGES[range].ttlS, () => usage(fetcher, opts));
  }
  return err(404, "not found");
}
