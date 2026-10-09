// nullrpc-landing: the nullrpc landing page at https://nullrpc.dev.
//
// public/ is served by Workers static assets; this Worker runs first for every request
// (`run_worker_first: true`) only to
//   - redirect www.{domain} to the apex with a 301 (path and query kept),
//   - allow GET and HEAD only,
//   - serve the page's same-origin data routes /api/networks and /api/usage (src/api.ts),
//   - set the security headers on every response (strict CSP, nosniff, no-referrer), and
//     `Cache-Control: no-transform` so Cloudflare does not rewrite the HTML (for example by
//     injecting the Web Analytics beacon).
// No cookies, no storage; the browser makes no third-party request.

import { api } from "./api";
import { SECURITY_HEADERS } from "./headers";

export interface Env {
  ASSETS: Fetcher;
  /** Secret: API token with "Account Analytics: Read" only. Without it /api/usage is unavailable. */
  CF_ANALYTICS_TOKEN?: string;
  /** Runtime configuration (KV): the `networks` list, see apps/networks.ts. */
  CONFIG?: KVNamespace;
}

/** Old legal URLs → their place in the bilingual pages. */
const LEGAL_REDIRECTS: Record<string, string> = {
  "/terminos": "/terms#es",
  "/aviso-de-privacidad": "/privacy#es",
};

/** HTML revalidates on every load; other assets may be cached for an hour. */
const HTML_CACHE = "public, max-age=0, must-revalidate, no-transform";
const ASSET_CACHE = "public, max-age=3600, no-transform";

function withHeaders(res: Response, extra: Record<string, string> = {}): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) out.headers.set(k, v);
  const type = out.headers.get("content-type") ?? "";
  if (!out.headers.has("cache-control") || type.startsWith("text/html")) {
    out.headers.set("cache-control", type.startsWith("text/html") ? HTML_CACHE : ASSET_CACHE);
  } else if (!/no-transform/.test(out.headers.get("cache-control") ?? "")) {
    out.headers.set("cache-control", `${out.headers.get("cache-control")}, no-transform`);
  }
  return out;
}

function plain(status: number, text: string, extra: Record<string, string> = {}): Response {
  return withHeaders(
    new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store, no-transform" } }),
    extra,
  );
}

export async function handle(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname.startsWith("www.")) {
    const target = new URL(url.pathname + url.search, `https://${url.hostname.slice(4)}`);
    return withHeaders(
      new Response(null, { status: 301, headers: { location: target.toString(), "cache-control": "public, max-age=86400" } }),
    );
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return plain(405, "Method not allowed.\n", { allow: "GET, HEAD" });
  }
  // The Spanish legal pages moved into the bilingual /terms and /privacy.
  const moved = LEGAL_REDIRECTS[url.pathname.replace(/(\.html|\/)$/, "")];
  if (moved) {
    return withHeaders(new Response(null, { status: 301, headers: { location: moved, "cache-control": "public, max-age=86400" } }));
  }
  const data = await api(url, env, ctx);
  if (data) return withHeaders(data);
  const res = await env.ASSETS.fetch(request);
  return withHeaders(res);
}

export default { fetch: (request, env, ctx) => handle(request, env, ctx) } satisfies ExportedHandler<Env>;
