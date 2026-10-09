// RateBudget: the strict global per-second limit for paid plans. One object per account (`idFromName(address)`), bound directly by the RPC
// Workers (`RATE_BUDGET`, script nullrpc-app). Each RPC Worker isolate asks at most once per second
// for its share of the account's requests for the next second (`GET /take?rps=&want=&isolate=`);
// the object never grants more than `rps` per one-second window in total. Nothing is stored:
// a restarted object starts a fresh window.
//
// Keyless clients (switch PUBLIC_STRICT = "on" in the RPC Workers,
// "Keyless per-second limit"): one object per client network, `idFromName("net:<id>")` with `id`
// the public-tier keyed hash (never an address), asked with `scope=public`: the rate is then the
// public plan's (`PLANS.public.rps`), whatever `rps` the caller sends.

import { DurableObject } from "cloudflare:workers";
import { PLANS } from "./plans";

/** The rate of a `/take` call: the public plan's for `scope=public`, else the caller's `rps`. */
export function takeRate(scope: string | null, rps: number): number {
  return scope === "public" ? PLANS.public.rps : rps;
}

export interface Take {
  /** Requests the isolate may serve in its next second. */
  tokens: number;
}

/** The pure window arithmetic, testable without the runtime. */
export class Budget {
  private window = -1;
  private granted = 0;
  private isolates = new Set<string>();
  private previousIsolates = 1;

  take(nowMs: number, rps: number, want: number, isolate: string): number {
    const window = Math.floor(nowMs / 1000);
    if (window !== this.window) {
      this.previousIsolates = Math.max(1, window === this.window + 1 ? this.isolates.size : 1);
      this.window = window;
      this.granted = 0;
      this.isolates = new Set();
    }
    this.isolates.add(isolate);
    const remaining = Math.max(0, rps - this.granted);
    // A fair share of the rate among the isolates active last second, or half of what is
    // left, whichever is larger: busy isolates are not starved by an early greedy one.
    const share = Math.max(Math.ceil(rps / this.previousIsolates), Math.floor(remaining / 2));
    const tokens = Math.max(0, Math.min(Math.floor(want), remaining, share));
    this.granted += tokens;
    return tokens;
  }
}

export class RateBudget extends DurableObject {
  private budget = new Budget();

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const rps = takeRate(url.searchParams.get("scope"), Number(url.searchParams.get("rps")));
    const want = Number(url.searchParams.get("want"));
    const isolate = (url.searchParams.get("isolate") ?? "").slice(0, 64);
    if (!Number.isSafeInteger(rps) || rps <= 0 || !Number.isFinite(want) || want < 0) {
      return Response.json({ error: "rps and want required" }, { status: 400 });
    }
    const take: Take = { tokens: this.budget.take(Date.now(), rps, want, isolate) };
    return Response.json(take);
  }
}
