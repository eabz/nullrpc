// RPC usage from the Cloudflare GraphQL Analytics API.
//
// Source: dataset `workersInvocationsAdaptive` of the RPC Worker `nullrpc-rpc-{chainId}`, which
// Cloudflare records for every Worker at no cost, with history since the Worker was deployed
// (lookback 3 months, at most 1 week per query, so 7 d is the longest range). One invocation
// is one HTTP request (a JSON-RPC batch counts once). Adaptive sampling: Cloudflare returns
// sums already extrapolated from the sample, and quantiles from a reservoir sample.
//
// Not available from this source (they lived in the removed Analytics Engine dataset): per
// JSON-RPC method, error code, colo, cache status and block tier. `response_bytes` is the
// dataset's `responseBodySize` (bytes of response bodies the Worker returned: data egress). `errors`
// here are Worker invocation errors (exceptions, exceeded limits), not JSON-RPC error objects.
//
// One POST https://api.cloudflare.com/client/v4/graphql per response, `Authorization: Bearer
// <token>` (permission "Account Analytics: Read"). The token is used only in that request.

export type Range = "1h" | "24h" | "7d";

export const RANGES: Record<Range, { dimension: string; bucketS: number; spanS: number; ttlS: number }> = {
  "1h": { dimension: "datetimeMinute", bucketS: 60, spanS: 3600, ttlS: 30 },
  "24h": { dimension: "datetimeFifteenMinutes", bucketS: 900, spanS: 86400, ttlS: 60 },
  "7d": { dimension: "datetimeHour", bucketS: 3600, spanS: 7 * 86400, ttlS: 300 },
};

export function isRange(v: string | null): v is Range {
  return v !== null && Object.hasOwn(RANGES, v);
}

export const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

/** The RPC Worker script of a chain. */
export const scriptName = (chainId: string) => `nullrpc-rpc-${chainId}`;

/**
 * The GraphQL query of one range: per-bucket series plus range totals (an aggregation without
 * dimensions), both per script so `all` gets a per-chain breakdown from the same request.
 * Everything variable is passed as GraphQL variables; the query text is constant per range.
 */
export function buildQuery(range: Range): string {
  const d = RANGES[range].dimension;
  return `query Usage($account: string!, $scripts: [string!], $from: Time!, $to: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      series: workersInvocationsAdaptive(
        limit: 10000
        filter: { scriptName_in: $scripts, datetime_geq: $from, datetime_lt: $to }
        orderBy: [${d}_ASC]
      ) {
        dimensions { t: ${d} scriptName }
        sum { requests errors subrequests responseBodySize }
        quantiles { wallTimeP95 }
      }
      totals: workersInvocationsAdaptive(
        limit: 100
        filter: { scriptName_in: $scripts, datetime_geq: $from, datetime_lt: $to }
      ) {
        dimensions { scriptName }
        sum { requests errors subrequests responseBodySize }
        quantiles { wallTimeP50 wallTimeP95 wallTimeP99 cpuTimeP50 cpuTimeP99 }
      }
    }
  }
}`;
}

/** Thrown for GraphQL API failures; the message is safe to log (it never holds the token). */
export class GraphQLApiError extends Error {}

type Row = {
  dimensions?: Record<string, unknown>;
  sum?: Record<string, unknown>;
  quantiles?: Record<string, unknown>;
};

/** Runs one query; returns the account node of the response. */
export async function runQuery(
  fetcher: typeof fetch,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ series: Row[]; totals: Row[] }> {
  const res = await fetcher(GRAPHQL_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text().catch(() => "");
  const redact = (s: string) => s.slice(0, 500).replaceAll(token, "[redacted]");
  if (!res.ok) throw new GraphQLApiError(`GraphQL API HTTP ${res.status}: ${redact(text)}`);
  let body: { data?: { viewer?: { accounts?: { series?: Row[]; totals?: Row[] }[] } }; errors?: { message?: string }[] | null };
  try {
    body = JSON.parse(text);
  } catch {
    throw new GraphQLApiError(`GraphQL API: invalid JSON: ${redact(text)}`);
  }
  if (body.errors && body.errors.length > 0) {
    throw new GraphQLApiError(`GraphQL API: ${redact(body.errors.map((e) => e.message ?? "").join("; "))}`);
  }
  const acct = body.data?.viewer?.accounts?.[0];
  if (!acct) throw new GraphQLApiError("GraphQL API: response without account data");
  return { series: acct.series ?? [], totals: acct.totals ?? [] };
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};
/** wallTime/cpuTime quantiles are microseconds (verified against live data); responses use ms. */
const ms = (v: unknown): number => Math.round(num(v) / 10) / 100;

export interface Analytics {
  configured: true;
  source: "workers-graphql";
  chain: string;
  chains: string[];
  range: Range;
  bucket_s: number;
  from: number;
  to: number;
  generated_at: number;
  totals: { requests: number; errors: number; subrequests: number; response_bytes: number; p50_ms: number; p95_ms: number; p99_ms: number; cpu_p50_ms: number; cpu_p99_ms: number };
  series: { t: number; requests: number; errors: number; subrequests: number; response_bytes: number; p95_ms: number }[];
  per_chain?: { chain: string; requests: number; errors: number; subrequests: number; response_bytes: number; p50_ms: number; p95_ms: number }[];
}

/** Runs the query of a range and shapes the response. */
export async function analytics(
  fetcher: typeof fetch,
  opts: { account: string; token: string; chain: string; chainIds: string[]; range: Range; now?: number },
): Promise<Analytics> {
  if (!/^[0-9a-f]{32}$/.test(opts.account)) throw new Error("bad account");
  if (opts.chainIds.length === 0 || !opts.chainIds.every((id) => /^[1-9][0-9]*$/.test(id))) throw new Error("bad chain ids");
  const r = RANGES[opts.range];
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const to = Math.floor(now / r.bucketS) * r.bucketS; // start of the current bucket
  const from = to - r.spanS;
  const scripts = opts.chainIds.map(scriptName);
  const iso = (s: number) => new Date(s * 1000).toISOString().replace(/\.000Z$/, "Z");
  // The current, partial bucket is included (`to + bucket`) so the newest minute shows up.
  const rows = await runQuery(fetcher, opts.token, buildQuery(opts.range), {
    account: opts.account,
    scripts,
    from: iso(from),
    to: iso(to + r.bucketS),
  });

  // Several scripts (chain=all) share a bucket: sum counts, take the max p95 (an upper bound).
  const byT = new Map<number, { requests: number; errors: number; subrequests: number; response_bytes: number; p95_ms: number }>();
  for (const x of rows.series) {
    const t = Math.floor(Date.parse(String(x.dimensions?.t ?? "")) / 1000);
    if (!Number.isFinite(t)) continue;
    const b = byT.get(t) ?? { requests: 0, errors: 0, subrequests: 0, response_bytes: 0, p95_ms: 0 };
    b.requests += num(x.sum?.requests);
    b.errors += num(x.sum?.errors);
    b.subrequests += num(x.sum?.subrequests);
    b.response_bytes += num(x.sum?.responseBodySize);
    b.p95_ms = Math.max(b.p95_ms, ms(x.quantiles?.wallTimeP95));
    byT.set(t, b);
  }
  const series: Analytics["series"] = [];
  for (let t = from; t <= to; t += r.bucketS) {
    series.push({ t, ...(byT.get(t) ?? { requests: 0, errors: 0, subrequests: 0, response_bytes: 0, p95_ms: 0 }) });
  }

  const perScript = rows.totals.map((x) => ({
    chain: String(x.dimensions?.scriptName ?? "").replace(/^nullrpc-rpc-/, ""),
    requests: num(x.sum?.requests),
    errors: num(x.sum?.errors),
    subrequests: num(x.sum?.subrequests),
    response_bytes: num(x.sum?.responseBodySize),
    p50_ms: ms(x.quantiles?.wallTimeP50),
    p95_ms: ms(x.quantiles?.wallTimeP95),
    p99_ms: ms(x.quantiles?.wallTimeP99),
    cpu_p50_ms: ms(x.quantiles?.cpuTimeP50),
    cpu_p99_ms: ms(x.quantiles?.cpuTimeP99),
  }));
  // Quantiles of several scripts: request-weighted mean (exact for one chain, the common case).
  const total = perScript.reduce((s, x) => s + x.requests, 0);
  const wq = (k: "p50_ms" | "p95_ms" | "p99_ms" | "cpu_p50_ms" | "cpu_p99_ms") =>
    total > 0 ? perScript.reduce((s, x) => s + x[k] * x.requests, 0) / total : 0;
  const totals: Analytics["totals"] = {
    requests: total,
    errors: perScript.reduce((s, x) => s + x.errors, 0),
    subrequests: perScript.reduce((s, x) => s + x.subrequests, 0),
    response_bytes: perScript.reduce((s, x) => s + x.response_bytes, 0),
    p50_ms: wq("p50_ms"),
    p95_ms: wq("p95_ms"),
    p99_ms: wq("p99_ms"),
    cpu_p50_ms: wq("cpu_p50_ms"),
    cpu_p99_ms: wq("cpu_p99_ms"),
  };

  const out: Analytics = {
    configured: true,
    source: "workers-graphql",
    chain: opts.chain,
    chains: opts.chainIds,
    range: opts.range,
    bucket_s: r.bucketS,
    from,
    to: to + r.bucketS,
    generated_at: Date.now(),
    totals,
    series,
  };
  if (opts.chainIds.length > 1) {
    out.per_chain = opts.chainIds
      .map((id) => perScript.find((x) => x.chain === id) ?? { chain: id, requests: 0, errors: 0, subrequests: 0, response_bytes: 0, p50_ms: 0, p95_ms: 0 })
      .map(({ chain, requests, errors, subrequests, response_bytes, p50_ms, p95_ms }) => ({ chain, requests, errors, subrequests, response_bytes, p50_ms, p95_ms }))
      .sort((a, b) => b.requests - a.requests);
  }
  return out;
}

// ---- live pipeline status
//
// Read from each chain's RPC endpoint: GET https://{host}/status.json, served by the RPC Worker
// from its cached ChainDO head, cached 5 s per colo there. Only public numbers.

export interface PipelinePoint {
  at: number;
  executed: number | null;
  finalized: number | null;
  archived_through: number | null;
  network_head: number | null;
  network_timestamp: number | null;
  finalized_timestamp: number | null;
  peers: number | null;
  lag: number | null;
  halted: boolean;
  backoff: boolean;
  state: string | null;
}

export interface Pipeline {
  configured: true;
  chain: string;
  generated_at: number;
  latest: PipelinePoint | null;
}

/** Thrown when an endpoint's /status.json cannot be read. */
export class StatusError extends Error {}

const known = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const blockNum = (v: unknown): number | null =>
  v && typeof v === "object" ? known((v as { number?: unknown }).number) : known(v);
const blockTs = (v: unknown): number | null =>
  v && typeof v === "object" ? known((v as { timestamp?: unknown }).timestamp) : null;

/** Maps a `/status.json` body (crate::page::public_status) to a pipeline point. */
export function pointFromStatus(s: Record<string, unknown>): PipelinePoint {
  const state = typeof s.state === "string" ? s.state.slice(0, 32) : null;
  return {
    at: known(s.generated_at) ?? Date.now(),
    executed: blockNum(s.latest),
    finalized: blockNum(s.finalized),
    archived_through: known(s.archived_through),
    network_head: blockNum(s.network_head),
    network_timestamp: blockTs(s.network_head),
    finalized_timestamp: blockTs(s.finalized),
    peers: known(s.peers),
    lag: known(s.behind),
    halted: false,
    backoff: state === "delayed",
    state,
  };
}

export async function pipeline(fetcher: typeof fetch, opts: { chain: string; url: string }): Promise<Pipeline> {
  const res = await fetcher(opts.url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new StatusError(`${opts.url}: HTTP ${res.status}`);
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") throw new StatusError(`${opts.url}: not JSON`);
  if (body.chain_id != null && String(body.chain_id) !== opts.chain) throw new StatusError(`${opts.url}: chain mismatch`);
  const latest = body.latest == null && body.archived_through == null ? null : pointFromStatus(body);
  return { configured: true, chain: opts.chain, generated_at: Date.now(), latest };
}
