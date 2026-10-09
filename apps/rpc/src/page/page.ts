// The endpoint's public page and its data (GET/HEAD only; POST is JSON-RPC):
//
//   GET /                 the page, when the client accepts text/html
//   GET /status.json      chain status: archive tip, live head and finality, with timestamps;
//                         read by this page, the landing page and the status dashboard
//   GET /_status/usage    this endpoint's traffic from the status dashboard's analytics API
//   GET /_page/*          static assets (Workers assets)

import type { Chain } from "../chain";
import { quantity } from "../eth/hex";
import { TEMPLATE } from "./template";

const STATUS_TTL_S = 5;
const USAGE_TTL_S = 15;
/** The live head is "following" when its block is at most this old. */
const FOLLOWING_MS = 60_000;
const RANGES = new Set(["1h", "24h", "7d"]);

export interface PageConfig {
  chainId: number;
  name: string;
  /** Origin of the status dashboard (its /api/analytics), or null to hide usage. */
  statusUrl: string | null;
  keys: boolean;
}

const ETH_MARK =
  '<svg class="chain-mark" viewBox="0 0 256 417" width="30" height="48" aria-hidden="true" focusable="false"><g fill="currentColor"><path fill-opacity=".8" d="M127.96 0l-2.8 9.5v275.67l2.8 2.79 127.96-75.64z"/><path fill-opacity=".45" d="M127.96 0L0 212.32l127.96 75.64V154.16z"/><path fill-opacity=".8" d="M127.96 312.19l-1.58 1.92v98.2l1.58 4.6L256 236.59z"/><path fill-opacity=".45" d="M127.96 416.9V312.19L0 236.59z"/><path d="M127.96 287.96l127.96-75.64-127.96-58.16z"/><path fill-opacity=".8" d="M0 212.32l127.96 75.64v-133.8z"/></g></svg>';

const TESTNET_MARK =
  '<svg class="chain-mark" viewBox="0 0 32 32" width="48" height="48" aria-hidden="true" focusable="false"><circle cx="16" cy="16" r="14.75" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3.1 2.7" stroke-opacity=".8"/><g fill="currentColor" transform="translate(10.5 6.8) scale(.043)"><path fill-opacity=".8" d="M127.96 0l-2.8 9.5v275.67l2.8 2.79 127.96-75.64z"/><path fill-opacity=".45" d="M127.96 0L0 212.32l127.96 75.64V154.16z"/><path fill-opacity=".8" d="M127.96 312.19l-1.58 1.92v98.2l1.58 4.6L256 236.59z"/><path fill-opacity=".45" d="M127.96 416.9V312.19L0 236.59z"/><path d="M127.96 287.96l127.96-75.64-127.96-58.16z"/><path fill-opacity=".8" d="M0 212.32l127.96 75.64v-133.8z"/></g></svg>';
const TESTNETS = new Set([560048, 11155111, 17000]);

const SECURITY = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function acceptsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").split(",").some((part) => {
    const [type, ...params] = part.trim().split(";");
    const q = params.find((p) => p.trim().startsWith("q="));
    return type?.trim() === "text/html" && (!q || Number(q.trim().slice(2)) > 0);
  });
}

export function renderPage(cfg: PageConfig, origin: string): string {
  const keyNote = cfg.keys
    ? `<p class="note">Requests without a key are rate limited. For production, <a href="https://app.nullrpc.dev">get an API key</a> and append it to the URL (<code>${escape(origin)}/&lt;key&gt;</code>) or send it as the <code>x-api-key</code> header.</p>\n`
    : "";
  const links =
    '<nav class="foot-links" aria-label="More"><a href="https://nullrpc.dev/terms">Terms</a><a href="https://nullrpc.dev/privacy">Privacy</a><a href="https://status.nullrpc.dev">Status</a></nav>\n';
  const values: Record<string, string> = {
    name: escape(cfg.name),
    chain_id: escape(String(cfg.chainId)),
    endpoint: escape(origin),
    example: escape(origin),
    status: "/status.json",
    usage: cfg.statusUrl ? "/_status/usage" : "",
  };
  const trusted: Record<string, string> = { mark: cfg.chainId === 1 ? ETH_MARK : TESTNETS.has(cfg.chainId) ? TESTNET_MARK : "", key_note: keyNote, links };
  return TEMPLATE.replace(/\{\{([a-z_]+)\}\}/g, (m, k: string) => trusted[k] ?? values[k] ?? m);
}

function html(body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache, no-transform", vary: "Accept", "content-security-policy": CSP, ...SECURITY },
  });
}

/** Responses shared per data center for `ttl` seconds (Cache API), when available. */
async function cachedJson(key: string, ttl: number, ctx: ExecutionContext, build: () => Promise<{ body: unknown; status?: number }>): Promise<Response> {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const req = new Request(key);
  const hit = await cache?.match(req);
  if (hit) return hit;
  const { body, status = 200 } = await build();
  const res = new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}`, "access-control-allow-origin": "*", ...SECURITY },
  });
  if (cache && status === 200) ctx.waitUntil(cache.put(req, res.clone()));
  return res;
}

/** /status.json: the shape the landing page and the status dashboard read. */
export async function statusBody(cfg: PageConfig, chain: Chain, now = Date.now()) {
  const p = chain.pointers();
  const stamp = async (n: number) => {
    const rec = await chain.block(n).catch(() => null);
    return rec ? { number: n, hash: `0x${[...rec.block.header.hash].map((b) => b.toString(16).padStart(2, "0")).join("")}`, timestamp: rec.block.header.timestamp } : { number: n, timestamp: null };
  };
  const [latest, finalized] = await Promise.all([stamp(p.latest), stamp(p.finalized)]);
  const live = chain.state?.head ? true : false;
  let state = "archive";
  if (live) state = latest.timestamp !== null && now - latest.timestamp * 1000 <= FOLLOWING_MS ? "following" : "delayed";
  return {
    chain_id: cfg.chainId,
    chain_id_hex: quantity(cfg.chainId),
    name: cfg.name,
    generated_at: now,
    state,
    latest,
    finalized,
    safe: p.safe,
    archived_through: p.archived,
    window: p.latest - p.archived,
    generation: chain.pin.generation,
    peers: null,
  };
}

export async function statusResponse(request: Request, cfg: PageConfig, open: () => Promise<Chain>, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  return cachedJson(`${url.origin}/status.json`, STATUS_TTL_S, ctx, async () => {
    try {
      return { body: await statusBody(cfg, await open()) };
    } catch (e) {
      console.error(JSON.stringify({ event: "status_error", error: e instanceof Error ? e.message : String(e) }));
      return { body: { chain_id: cfg.chainId, name: cfg.name, generated_at: Date.now(), state: "unavailable" }, status: 503 };
    }
  });
}

export async function usageResponse(request: Request, cfg: PageConfig, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const range = url.searchParams.get("range") ?? "1h";
  if (!cfg.statusUrl || !RANGES.has(range)) return new Response("not found", { status: 404, headers: SECURITY });
  const res = await cachedJson(`${url.origin}/_status/usage?range=${range}`, USAGE_TTL_S, ctx, async () => {
    try {
      const upstream = await fetch(`${cfg.statusUrl}/api/analytics?chain=${cfg.chainId}&range=${range}`, { headers: { accept: "application/json" } });
      return { body: await upstream.json(), status: upstream.ok ? 200 : 502 };
    } catch {
      return { body: { configured: false }, status: 502 };
    }
  });
  // The browser always asks again; only the data center caches.
  const out = new Response(res.body, res);
  out.headers.set("cache-control", "no-store");
  return out;
}

export function pageResponse(request: Request, cfg: PageConfig): Response | null {
  return acceptsHtml(request) ? html(renderPage(cfg, new URL(request.url).origin)) : null;
}
