// Plans and the billing arithmetic. Pure functions; no I/O.
//
// Usage is counted in credits: each call costs its method's weight from the shared table
// src/credits.json (shared with the RPC Worker), a batch
// the sum of its calls. A typical call is about 20 credits. Money is integer nano-USD.

import CREDITS from "./credits.json";

export { CREDITS };

/** Credits of a typical call, for "about N calls" figures. */
export const TYPICAL_CREDITS = 20;

export type PlanId = "public" | "free" | "unverified" | "builder" | "growth" | "scale" | "internal";

export interface Plan {
  id: PlanId;
  name: string;
  /** Price per 30-day month in US cents. */
  priceCents: number;
  /** Credits included per period. */
  included: number;
  /** Requests per second (enforced by the RPC Worker's per-tier rate limit). */
  rps: number;
  /** Overage price per credit in nano-USD, or null: the plan stops at its quota. */
  overageNano: number | null;
  /** Purchasable from the app. */
  public: boolean;
  /**
   * Strict global per-second limit (the `RateBudget` Durable Object, src/ratebudget.ts) on top
   * of the per-location rate-limit bindings.
   */
  strictRate: boolean;
}

export const PERIOD_MS = 30 * 24 * 3600 * 1000;

/**
 * Plans are paid upfront for 1, 6 or 12 months; longer terms are discounted. There is no
 * prepaid balance or overage: every plan stops at its monthly quota (upgrade for more).
 */
export const DURATIONS: Record<number, number> = { 1: 0, 6: 0.1, 12: 0.2 }; // months -> discount

/** Price in US cents of `months` months of a plan, after the term discount. */
export function priceFor(planId: string, months: number): number {
  return Math.round(plan(planId).priceCents * months * (1 - (DURATIONS[months] ?? 0)));
}

export const PLANS: Record<PlanId, Plan> = {
  // Keyless requests, per client network (IPv4 address or IPv6 /64) and calendar month (UTC).
  // Not advertised: keyless use is a trial; the goal is a key on Builder.
  public: { id: "public", name: "Public (no key)", priceCents: 0, included: 10_000_000, rps: 10, overageNano: null, public: false, strictRate: false },
  free: { id: "free", name: "Free", priceCents: 0, included: 20_000_000, rps: 20, overageNano: null, public: true, strictRate: false },
  builder: { id: "builder", name: "Builder", priceCents: 1_900, included: 600_000_000, rps: 250, overageNano: null, public: true, strictRate: true },
  growth: { id: "growth", name: "Growth", priceCents: 8_900, included: 3_000_000_000, rps: 1_000, overageNano: null, public: true, strictRate: true },
  scale: { id: "scale", name: "Scale", priceCents: 59_900, included: 20_000_000_000, rps: 3_000, overageNano: null, public: true, strictRate: true },
  // Our own benchmarks and monitors; assigned in D1 by hand, never sold.
  internal: { id: "internal", name: "Internal", priceCents: 0, included: Number.MAX_SAFE_INTEGER, rps: 0, overageNano: null, public: false, strictRate: false },
  // Sign-up controls (src/gate.ts): a wallet without on-chain history signs in with no free
  // credits until it pays for a plan (or passes a re-check). Never sold.
  unverified: { id: "unverified", name: "Free (unverified wallet)", priceCents: 0, included: 0, rps: 20, overageNano: null, public: false, strictRate: false },
};

// ---- Usage enforcement

/**
 * Non-paying traffic per client network (IPv4 address or IPv6 /64) and UTC month: keyless
 * (public tier) and Free-plan keys share this one cap, so a Free key cannot stack its credits
 * on the public tier's from one network. A Free account keeps its own 20M across networks.
 */
export const FREE_NETWORK_CAP = 10_000_000;

/** Plans whose keys count toward FREE_NETWORK_CAP (everything not paid for). */
export const NETWORK_CAPPED: ReadonlySet<string> = new Set(["free", "unverified"]);

/** Keyless caps per UTC month: per client network, per IPv4 /24 (IPv6 /48), per ASN. */
export interface PublicCaps {
  net: number;
  block: number;
  asn: number;
}
export const PUBLIC_CAPS: PublicCaps = { net: FREE_NETWORK_CAP, block: 50_000_000, asn: 1_000_000_000 };
/** The same for datacenter and hosting networks (DATACENTER_ASNS): scripts, not people. */
export const DATACENTER_CAPS: PublicCaps = { net: 1_000_000, block: 5_000_000, asn: 20_000_000 };
/** All keyless traffic together, per UTC day; beyond it "daily public capacity reached". */
export const PUBLIC_DAILY_BUDGET = 200_000_000;

/**
 * Major cloud and hosting ASNs (request.cf.asn). Cloudflare 13335 also carries WARP users,
 * who get the datacenter allowance too (a free key lifts it).
 */
export const DATACENTER_ASNS: ReadonlySet<number> = new Set([
  16509, 14618, // Amazon (AWS)
  15169, 396982, // Google, Google Cloud
  8075, // Microsoft (Azure)
  24940, // Hetzner
  16276, // OVH
  14061, // DigitalOcean
  63949, // Linode / Akamai Connected Cloud
  20473, // Vultr (The Constant Company)
  31898, // Oracle Cloud
  45102, // Alibaba Cloud
  51167, // Contabo
  12876, // Scaleway
  13335, // Cloudflare
]);

export const isDatacenter = (asn: number | undefined | null) => typeof asn === "number" && DATACENTER_ASNS.has(asn);

/** Credit leases (src/leases.ts): lifetime, and the bounds of one lease's reservation. */
export const LEASE_MS = 60_000;
export const LEASE_MIN = 20_000;
export const LEASE_MAX = 5_000_000;

/** Plans ordered by price, for upgrade checks. */
const RANK: PlanId[] = ["free", "builder", "growth", "scale"];

export function plan(id: string): Plan {
  return PLANS[id as PlanId] ?? PLANS.free;
}

export function isPurchasable(id: string): id is PlanId {
  return id in PLANS && PLANS[id as PlanId].public && PLANS[id as PlanId].priceCents > 0;
}

export interface AccountState {
  plan: string;
  paid_until: number;
  period_start: number;
  period_end: number;
  period_units: number;
  balance_nano: number;
}

/**
 * The account at `now`: an expired paid plan falls back to free, and each elapsed
 * 30-day period resets the period's usage. Returns null when nothing changed.
 */
export function roll(account: AccountState, now: number): AccountState | null {
  if (now < account.period_end) return null;
  const next = { ...account };
  if (next.plan !== "free" && next.plan !== "internal" && next.plan !== "unverified" && now >= next.paid_until) next.plan = "free";
  const periods = Math.floor((now - next.period_end) / PERIOD_MS) + 1;
  next.period_start = next.period_end + (periods - 1) * PERIOD_MS;
  next.period_end = next.period_start + PERIOD_MS;
  next.period_units = 0;
  return next;
}

/** Whether the account may not make more requests this period. */
export function exhausted(account: AccountState): boolean {
  const p = plan(account.plan);
  if (account.period_units < p.included) return false;
  return p.overageNano === null || account.balance_nano <= 0;
}

/** Usage applied to the account: the period's units and the overage charged to the balance. */
export function applyUsage(account: AccountState, units: number): { periodUnits: number; chargeNano: number } {
  const p = plan(account.plan);
  const before = account.period_units;
  const after = before + units;
  const overUnits = Math.max(0, after - Math.max(before, p.included));
  const chargeNano = p.overageNano === null ? 0 : overUnits * p.overageNano;
  return { periodUnits: after, chargeNano };
}

export type PurchaseError = "unknown_plan" | "downgrade" | "months";

/** Validates a plan purchase of `months` months for the account at `now`. */
export function checkPurchase(account: AccountState, planId: string, months: number, now: number): PurchaseError | null {
  if (!isPurchasable(planId)) return "unknown_plan";
  if (!Object.hasOwn(DURATIONS, String(months))) return "months";
  const active = account.plan !== "free" && account.paid_until > now;
  if (active && RANK.indexOf(planId) < RANK.indexOf(account.plan as PlanId)) return "downgrade";
  return null;
}

/**
 * The account after a paid purchase of `months` months of `planId`. Extending the
 * current plan adds time; a new or higher plan starts a fresh period now.
 */
export function applyPurchase(account: AccountState, planId: PlanId, months: number, now: number): AccountState {
  const next = { ...account };
  const extending = account.plan === planId && account.paid_until > now;
  if (extending) {
    next.paid_until = account.paid_until + months * PERIOD_MS;
    return next;
  }
  next.plan = planId;
  next.paid_until = now + months * PERIOD_MS;
  next.period_start = now;
  next.period_end = now + PERIOD_MS;
  next.period_units = 0;
  return next;
}

/** A new account on the free plan. */
export function newAccount(now: number): AccountState {
  return { plan: "free", paid_until: 0, period_start: now, period_end: now + PERIOD_MS, period_units: 0, balance_nano: 0 };
}

/** The public tier's period: the UTC calendar month as YYYYMM. */
export function utcMonth(now: number): number {
  const d = new Date(now);
  return d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;
}

/** The public tier's daily budget period: the UTC day as YYYYMMDD. */
export function utcDay(now: number): number {
  const d = new Date(now);
  return d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/** Public plan list for the app and the landing page. */
export function publicPlans() {
  return RANK.map((id) => {
    const p = PLANS[id];
    return {
      id: p.id,
      name: p.name,
      price_usd: p.priceCents / 100,
      included_credits: p.included,
      approx_calls: Math.round(p.included / TYPICAL_CREDITS),
      rps: p.rps,
      overage_usd_per_million_credits: p.overageNano === null ? null : p.overageNano / 1000,
      durations: Object.entries(DURATIONS).map(([m, discount]) => ({
        months: Number(m),
        discount,
        total_usd: priceFor(p.id, Number(m)) / 100,
      })),
    };
  });
}
