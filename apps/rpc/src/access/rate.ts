// Requests per second (one token per HTTP request; a batch is one request):
//
//   1. Keyless: a token bucket per client network in the isolate (10/s, burst 20), before the
//      body is read and before any I/O.
//   2. Every plan: the Workers rate-limit binding of its plan (RPC_RATE_LIMIT_<PLAN>), keyed by
//      account (or the client network when keyless). Approximate and per location.
//   3. Paid plans (`limiter`): the account's RateBudget Durable Object grants each isolate its
//      share of the next second, so the limit holds across every location. Asked at most once a
//      second per isolate; on error the isolate allows the full rate for that second.
//
// Every check fails open on infrastructure errors: availability over strictness.

import { Lru } from "../archive/lru";

const PUBLIC_RPS = 10;
const PUBLIC_BURST = 20;

const buckets = new Lru<string, { tokens: number; at: number }>(10_000);

/** Takes one token from the keyless bucket of `rateKey`; false when empty. */
export function takePublic(rateKey: string, now = Date.now()): boolean {
  const b = buckets.get(rateKey) ?? { tokens: PUBLIC_BURST, at: now };
  b.tokens = Math.min(PUBLIC_BURST, b.tokens + ((now - b.at) / 1000) * PUBLIC_RPS);
  b.at = now;
  const ok = b.tokens >= 1;
  if (ok) b.tokens -= 1;
  buckets.set(rateKey, b);
  return ok;
}

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The plan's rate-limit binding; unknown plans use Free's. */
export async function limitByPlan(env: object, plan: string, key: string): Promise<boolean> {
  if (plan === "internal") return true;
  const bindings = env as Record<string, RateLimiter | undefined>;
  const binding = bindings[`RPC_RATE_LIMIT_${plan.toUpperCase()}`] ?? bindings.RPC_RATE_LIMIT_FREE;
  if (!binding) return true;
  try {
    return (await binding.limit({ key })).success;
  } catch {
    return true;
  }
}

// ---- strict limiter (RateBudget)

// Random values are not allowed at module load in Workers: the isolate id is made on first use.
let isolateId: string | null = null;
const isolate = () => (isolateId ??= Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join(""));
interface Window {
  second: number;
  tokens: number;
  demand: number;
  lastDemand: number;
  asking: Promise<void> | null;
}
const windows = new Lru<string, Window>(5_000);

/** Takes one token from the account's share of this second; false when used up. */
export async function takeStrict(ns: DurableObjectNamespace | undefined, account: string, rps: number, now = Date.now()): Promise<boolean> {
  if (!ns || rps <= 0) return true;
  const second = Math.floor(now / 1000);
  let w = windows.get(account);
  if (!w) {
    w = { second: -1, tokens: 0, demand: 0, lastDemand: 0, asking: null };
    windows.set(account, w);
  }
  if (w.second !== second) {
    if (!w.asking) {
      const want = Math.min(rps, Math.max(1, Math.ceil(1.5 * Math.max(w.demand, w.lastDemand)), Math.ceil(rps / 10)));
      const win = w;
      w.asking = (async () => {
        let tokens = rps;
        try {
          const stub = ns.get(ns.idFromName(account));
          const res = await stub.fetch(`https://rate/take?rps=${rps}&want=${want}&isolate=${isolate()}`);
          if (res.ok) tokens = Math.max(0, Number(((await res.json()) as { tokens?: number }).tokens ?? rps));
        } catch {
          // Fail open: allow the full rate this second.
        }
        win.lastDemand = win.demand;
        win.demand = 0;
        win.tokens = tokens;
        win.second = second;
      })().finally(() => (win.asking = null));
    }
    await w.asking;
  }
  w.demand += 1;
  if (w.tokens < 1) return false;
  w.tokens -= 1;
  return true;
}
