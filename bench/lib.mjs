// Shared pieces of the bench scripts: argument parsing, the networks table, a JSON-RPC client
// that times every call, hex normalization, deep diffs and percentiles. No dependencies; runs
// under Bun or Node 20+.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** `--flag value` and `--flag` (true) into an object; bare words into `_`. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[name] = true;
    else out[name] = argv[++i];
  }
  return out;
}

/** apps/networks.json: the chains nullrpc serves. */
export function networks() {
  return JSON.parse(readFileSync(join(HERE, "..", "apps", "networks.json"), "utf8")).networks;
}

/** Public reference nodes per chain, for correctness comparisons. */
export const REFERENCES = {
  560048: ["https://rpc.hoodi.ethpandaops.io", "https://ethereum-hoodi-rpc.publicnode.com"],
  1: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"],
};

/** The target of a run: `--url`, or the chain's nullrpc endpoint from networks.json. */
export function target(args) {
  const chainId = Number(args.chain ?? 560048);
  const net = networks().find((n) => n.chain_id === chainId);
  if (!net && !args.url) throw new Error(`unknown chain ${chainId}; pass --url`);
  const url = args.url ?? net.url;
  const key = args.key ?? process.env.NULLRPC_KEY ?? null;
  return { chainId, name: net?.name ?? `chain ${chainId}`, url, key, ref: args.ref ?? REFERENCES[chainId]?.[0] ?? null };
}

/** The endpoint URL with the key on the path, the form the Worker prefers. */
export function endpoint(url, key) {
  return key ? `${url.replace(/\/$/, "")}/${key}` : url;
}

let nextId = 1;

/**
 * One JSON-RPC call. Resolves to {result, error, ms, http, ok}; never throws (transport failures
 * become an error with code 0).
 */
export async function rpc(url, method, params = [], { timeoutMs = 30_000 } = {}) {
  const id = nextId++;
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const ms = performance.now() - t0;
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { error: { code: 0, message: `non-JSON response (${res.status}): ${text.slice(0, 120)}` }, ms, http: res.status, ok: false };
    }
    if (body.error) return { error: body.error, ms, http: res.status, ok: false, retryAfter: res.headers.get("retry-after") };
    return { result: body.result, ms, http: res.status, ok: true };
  } catch (e) {
    return { error: { code: 0, message: e.name === "TimeoutError" ? "timeout" : String(e.message ?? e) }, ms: performance.now() - t0, http: 0, ok: false };
  }
}

/** A JSON-RPC batch: `items` is [[method, params], ...]. Resolves to an array of per-item results. */
export async function batch(url, items, { timeoutMs = 60_000 } = {}) {
  const base = nextId;
  nextId += items.length;
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(items.map(([method, params], i) => ({ jsonrpc: "2.0", id: base + i, method, params: params ?? [] }))),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = performance.now() - t0;
    const body = await res.json();
    if (!Array.isArray(body)) return items.map(() => ({ error: body.error ?? { code: 0, message: "batch refused" }, ms, http: res.status, ok: false }));
    const byId = new Map(body.map((r) => [r.id, r]));
    return items.map((_, i) => {
      const r = byId.get(base + i);
      if (!r) return { error: { code: 0, message: "missing from batch" }, ms, http: res.status, ok: false };
      return r.error ? { error: r.error, ms, http: res.status, ok: false } : { result: r.result, ms, http: res.status, ok: true };
    });
  } catch (e) {
    const ms = performance.now() - t0;
    return items.map(() => ({ error: { code: 0, message: String(e.message ?? e) }, ms, http: 0, ok: false }));
  }
}

export const hex = (n) => "0x" + BigInt(n).toString(16);
export const num = (q) => (q == null ? null : Number(BigInt(q)));

/** Lowercases every hex string in a value and sorts object keys, so two clients' JSON compare. */
export function normalize(v) {
  if (typeof v === "string") return /^0x[0-9a-fA-F]*$/.test(v) ? v.toLowerCase() : v;
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = normalize(v[k]);
    return out;
  }
  return v;
}

/**
 * Differences between two normalized values as [{path, a, b}]. `ignore` holds dotted paths
 * (array indexes written as `*`) to skip, for fields that legitimately differ between clients.
 */
export function diff(a, b, ignore = [], path = "", out = []) {
  const key = path.replace(/\[\d+\]/g, "[*]");
  if (ignore.some((p) => key === p || key.endsWith("." + p) || key.endsWith("]." + p))) return out;
  if (a === b) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push({ path: path + ".length", a: a.length, b: b.length });
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) diff(a[i], b[i], ignore, `${path}[${i}]`, out);
    return out;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], ignore, path ? `${path}.${k}` : k, out);
    return out;
  }
  out.push({ path: path || "$", a, b });
  return out;
}

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export const fmtMs = (ms) => (ms == null ? "-" : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`);

/** A fixed-width text table from rows of strings; the first row is the header. */
export function table(rows) {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i] ?? "").length)));
  return rows.map((r, ri) => r.map((c, i) => (i === 0 ? String(c ?? "").padEnd(w[i]) : String(c ?? "").padStart(w[i]))).join("  ") + (ri === 0 ? "\n" + w.map((x) => "-".repeat(x)).join("  ") : "")).join("\n");
}

/** Deterministic pseudo-random numbers from a seed (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runs `fn` over `items` with at most `limit` in flight; results in order. */
export async function pmap(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** A simple token bucket: `await take()` paces calls to `rps` per second. */
export function limiter(rps) {
  if (!rps || rps <= 0) return async () => {};
  let tokens = rps;
  let at = performance.now();
  return async () => {
    for (;;) {
      const now = performance.now();
      tokens = Math.min(rps, tokens + ((now - at) / 1000) * rps);
      at = now;
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      await new Promise((r) => setTimeout(r, Math.ceil(((1 - tokens) / rps) * 1000)));
    }
  };
}
