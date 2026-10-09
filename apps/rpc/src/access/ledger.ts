// Credit leases (apps/app/src/leases.ts). Each isolate holds a lease of credits per subject,
// serves at most its reservation, and renews before serving more: a renewal reports what was
// served and tops the reservation up, in one call to the app's `Access` entrypoint
// (`POST /lease`). So quotas are exact without a call per request.
//
//   allowance = reserved − unreported − inflight
//
// A request reserves its worst case (inflight) before it is served and settles its actual cost
// after. Renewals happen in the background once a line is due; a request whose estimate does
// not fit renews synchronously first (concurrent requests share that renewal).
//
// If the app is unreachable, the isolate serves a bounded amount (per line and per isolate per
// minute) and reports it at the next successful renewal; beyond that requests are refused as
// busy. A subject already refused stays refused. A line keeps the entitlement of its last grant
// through lease errors and backoff windows; a line never granted is served provisionally
// (`granted: false`), and the caller applies no plan limit to it: the plan is not known yet,
// and refusing on the fallback plan's limit would turn an outage of the app into 429s.
//
// Each line renews at most once at a time: a background renewal is shared by every request
// that finds the line due while it is in flight, and by a request that needs a synchronous one.

import type { Caller } from "./identity";

export type Status = "active" | "exhausted" | "network" | "capacity" | "busy" | "suspended" | "revoked" | "unknown";
const STATUSES = new Set<Status>(["active", "exhausted", "network", "capacity", "busy", "suspended", "revoked", "unknown"]);

interface Grant {
  status: Status;
  plan?: string;
  account?: string;
  rps?: number;
  limiter?: boolean;
  lease: string | null;
  reserved: number;
  ttl_ms: number;
}

/** What the request may rely on after admission. */
export interface Entitlement {
  plan: string;
  account: string | null;
  rps: number;
  limiter: boolean;
}

/** The outcome of `Ledger.admit`: a reservation on a line, or a refusal to cache. */
export type Admission = { ok: true; line: Line; ent: Entitlement; granted: boolean } | { ok: false; status: Status };

/** The app's `Access` entrypoint (service binding). */
export interface AccessApi {
  fetch(request: Request): Promise<Response>;
}

const RENEW_INTERVAL_MS = 30_000;
const EXPIRY_MARGIN_MS = 5_000;
const LEASE_MAX = 5_000_000;
const WANT_HORIZON_MS = 30_000;
const SYNC_TRIES = 3;
const REFUSAL_TTL_MS = 60_000;
const BUSY_TTL_MS = 5_000;
const BACKOFF_MS = 10_000;
/** A lease call that takes longer than this failed (requests waiting on it are served fail-soft). */
const LEASE_TIMEOUT_MS = 8_000;
const SOFT_LINE_PER_MIN = 20_000;
const SOFT_ISOLATE_PER_MIN = 500_000;
const MAX_LINES_PER_CALL = 100;
const MAX_LINES = 20_000;

// Plans before the first grant: the public plan for keyless lines, Free for keys.
const FALLBACK: Record<"anon" | "key", Entitlement> = {
  anon: { plan: "public", account: null, rps: 10, limiter: false },
  key: { plan: "free", account: null, rps: 20, limiter: false },
};
// Paid plans have one account-wide line; Free keys are counted per network as well.
const PER_NETWORK = new Set(["free", "unverified"]);

interface Line {
  subject: string;
  caller: Caller;
  ent: Entitlement;
  /** Set after the first grant. */
  known: boolean;
  lease: string | null;
  reserved: number;
  expiresAt: number;
  lastGrant: number;
  lastRenew: number;
  /** Served credits/requests not yet acknowledged by the app. */
  unreported: number;
  unreportedRequests: number;
  /** Acknowledged totals on the current lease (for idempotent retries). */
  ackTotal: number;
  ackRequests: number;
  inflight: number;
  servedSinceRenew: number;
  refused: { status: Status; until: number } | null;
  renewing: Promise<void> | null;
  /** Fail-soft spending in the current minute. */
  softMinute: number;
  softSpent: number;
}

export class Ledger {
  private readonly lines = new Map<string, Line>();
  private failedAt = -Infinity;
  private softMinute = 0;
  private softSpent = 0;

  constructor(private readonly app: AccessApi) {}

  private lineKey(c: Caller): string {
    if (!c.keyed) return c.subject;
    const paid = this.lines.get(c.subject);
    if (paid?.known && !PER_NETWORK.has(paid.ent.plan)) return c.subject;
    return `${c.subject}@${c.net}`;
  }

  private line(c: Caller): Line {
    const key = this.lineKey(c);
    let l = this.lines.get(key);
    if (!l) {
      if (this.lines.size >= MAX_LINES) this.evict();
      l = {
        subject: c.subject, caller: c, ent: c.keyed ? FALLBACK.key : FALLBACK.anon, known: false, lease: null, reserved: 0,
        expiresAt: 0, lastGrant: 0, lastRenew: 0, unreported: 0, unreportedRequests: 0, ackTotal: 0, ackRequests: 0,
        inflight: 0, servedSinceRenew: 0, refused: null, renewing: null, softMinute: 0, softSpent: 0,
      };
      this.lines.set(key, l);
    }
    l.caller = c;
    return l;
  }

  private evict(): void {
    for (const [k, l] of this.lines) {
      if (l.unreported === 0 && l.inflight === 0 && !l.renewing) {
        this.lines.delete(k);
        if (this.lines.size < MAX_LINES) return;
      }
    }
  }

  /** A cached refusal, checked before the request body is read. */
  refusal(c: Caller, now = Date.now()): Status | null {
    const l = this.lines.get(this.lineKey(c));
    return l?.refused && l.refused.until > now ? l.refused.status : null;
  }

  private allowance(l: Line, now: number): number {
    if (now >= l.expiresAt) return 0;
    return l.reserved - l.unreported - l.inflight;
  }

  /**
   * Reserves `estimate` credits for one request, renewing first if needed. `granted` is false
   * when the app never answered for this line (served fail-soft on the fallback entitlement).
   */
  async admit(c: Caller, estimate: number, now = Date.now()): Promise<Admission> {
    const l = this.line(c);
    for (let attempt = 0; ; attempt++) {
      if (l.refused && l.refused.until > now) return { ok: false, status: l.refused.status };
      if (l.known && this.allowance(l, now) >= estimate) break;
      if (attempt >= SYNC_TRIES) return { ok: false, status: "busy" };
      const renewed = await this.renewSync(l, estimate);
      now = Date.now();
      if (!renewed) {
        // The app is unreachable: serve a bounded amount, reported later, on the last known
        // entitlement (the fallback plan if the line was never granted).
        if (l.refused) return { ok: false, status: l.refused.status };
        if (!this.softSpend(l, estimate, now)) return { ok: false, status: "busy" };
        l.inflight += estimate;
        return { ok: true, line: l, ent: l.ent, granted: l.known };
      }
    }
    l.inflight += estimate;
    return { ok: true, line: l, ent: l.ent, granted: true };
  }

  private softSpend(l: Line, credits: number, now: number): boolean {
    const minute = Math.floor(now / 60_000);
    if (l.softMinute !== minute) (l.softMinute = minute), (l.softSpent = 0);
    if (this.softMinute !== minute) (this.softMinute = minute), (this.softSpent = 0);
    if (l.softSpent + credits > SOFT_LINE_PER_MIN || this.softSpent + credits > SOFT_ISOLATE_PER_MIN) return false;
    l.softSpent += credits;
    this.softSpent += credits;
    return true;
  }

  /** Settles a served request: releases its reservation and records its actual cost. */
  settle(l: Line, estimate: number, actual: number): void {
    l.inflight = Math.max(0, l.inflight - estimate);
    l.unreported += actual;
    l.unreportedRequests += 1;
    l.servedSinceRenew += actual;
  }

  /** Releases a reservation without charging (the request was refused after admission). */
  release(l: Line, estimate: number): void {
    l.inflight = Math.max(0, l.inflight - estimate);
  }

  private due(l: Line, now: number): boolean {
    if (l.renewing || (l.refused && l.refused.until > now)) return false;
    if (l.unreported > 0 && now - l.lastRenew >= RENEW_INTERVAL_MS) return true;
    if (l.known && l.lease !== null && this.allowance(l, now) < l.lastGrant / 2) return l.unreported > 0 || l.servedSinceRenew > 0;
    return l.unreported > 0 && now >= l.expiresAt - EXPIRY_MARGIN_MS;
  }

  /**
   * Renews every due line in the background (call from ctx.waitUntil). A line already renewing
   * is not due, so requests arriving while a renewal is in flight do not start another one.
   */
  async renewDue(now = Date.now()): Promise<void> {
    if (now - this.failedAt < BACKOFF_MS) return;
    // A paid key's line is in the map under its subject and under subject@net: once each.
    const due = [...new Set(this.lines.values())].filter((l) => this.due(l, now)).slice(0, MAX_LINES_PER_CALL);
    if (!due.length) return;
    const renewal = this.renew(due, new Map()).finally(() => {
      for (const l of due) if (l.renewing === renewal) l.renewing = null;
    });
    for (const l of due) l.renewing = renewal;
    await renewal;
  }

  private renewSync(l: Line, need: number): Promise<boolean> {
    if (!l.renewing) {
      if (Date.now() - this.failedAt < BACKOFF_MS) return Promise.resolve(false);
      l.renewing = this.renew([l], new Map([[l, need]])).finally(() => (l.renewing = null));
    }
    return l.renewing.then(() => l.lastRenew > 0 && l.lastRenew > this.failedAt);
  }

  private want(l: Line, now: number, need: number): number {
    if (!l.known) return need;
    const elapsed = Math.max(now - l.lastRenew, 1000);
    const rate = (l.servedSinceRenew / elapsed) * WANT_HORIZON_MS * 2;
    return Math.max(need, Math.min(Math.ceil(rate), LEASE_MAX));
  }

  private async renew(lines: Line[], needs: Map<Line, number>): Promise<void> {
    const now = Date.now();
    const sent = lines.map((l) => ({ l, used: l.unreported, requests: l.unreportedRequests }));
    const body = {
      lines: sent.map(({ l, used, requests }) => ({
        subject: l.subject,
        lease: l.lease ?? undefined,
        used,
        requests,
        total: l.ackTotal + used,
        requests_total: l.ackRequests + requests,
        want: this.want(l, now, needs.get(l) ?? 0),
        need: needs.get(l) ?? 0,
        net: l.caller.net,
        block: l.caller.block,
        asn: l.caller.asn,
      })),
    };
    let grants: Grant[];
    try {
      const res = await this.app.fetch(
        new Request("https://app/lease", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(LEASE_TIMEOUT_MS) }),
      );
      if (!res.ok) throw new Error(`lease HTTP ${res.status}`);
      const parsed = (await res.json()) as { lines?: Grant[] };
      if (!Array.isArray(parsed.lines) || parsed.lines.length !== lines.length) throw new Error("lease response shape");
      grants = parsed.lines;
    } catch (e) {
      this.failedAt = Date.now();
      console.error(JSON.stringify({ event: "lease_error", lines: lines.length, error: e instanceof Error ? e.message : String(e) }));
      return;
    }
    const at = Date.now();
    sent.forEach(({ l, used, requests }, i) => {
      const g = grants[i]!;
      const status: Status = STATUSES.has(g.status) ? g.status : "unknown";
      // The served credits we reported are acknowledged.
      l.unreported -= used;
      l.unreportedRequests -= requests;
      if (g.lease !== l.lease) (l.ackTotal = 0), (l.ackRequests = 0);
      else (l.ackTotal += used), (l.ackRequests += requests);
      l.lease = g.lease;
      l.lastRenew = at;
      l.servedSinceRenew = 0;
      if (status !== "active") {
        l.refused = { status, until: at + (status === "busy" ? BUSY_TTL_MS : REFUSAL_TTL_MS) };
        l.reserved = 0;
        return;
      }
      l.refused = null;
      l.known = true;
      l.reserved = g.reserved;
      l.lastGrant = g.reserved;
      l.expiresAt = at + g.ttl_ms - EXPIRY_MARGIN_MS;
      l.ent = { plan: g.plan ?? l.ent.plan, account: g.account ?? null, rps: g.rps ?? l.ent.rps, limiter: g.limiter === true };
      // A paid key has one line for the whole account, whatever network it is used from.
      if (l.caller.keyed && !PER_NETWORK.has(l.ent.plan) && this.lines.get(l.subject) !== l) {
        this.lines.set(l.subject, l);
        this.lines.delete(`${l.subject}@${l.caller.net}`);
      }
    });
  }
}
