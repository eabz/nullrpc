// Credit leases: exact quotas without a per-request
// call. An RPC Worker isolate asks for a lease of credits for a subject (an API key, or a keyless
// client network), serves at most that many, and renews before serving more; a renewal reports
// what the previous lease served and tops the reservation up, in one call.
//
// Every limit is a counter ("target") with a cap: the account's period (`acct:<address>`), the
// client network's month for non-paying traffic (`net:<id>:<YYYYMM>`), and for keyless traffic
// the /24 (`block:`), the ASN (`asn:`) and the global day (`day:`). Each target keeps the sum of
// its leases' reservations (`usage_buckets.reserved`), and a top-up is one conditional statement
// over all of a lease's targets, so for every target, always:
//
//     used + reserved <= cap
//
// and an isolate never serves more than its lease's reservation. Credits only leave the
// reservation when reported (moved to `used`) or when the lease expires unrenewed (released:
// an evicted isolate's unreported credits are not charged; the bound is in the docs).

import { keyState } from "./db";
import {
  DATACENTER_CAPS,
  FREE_NETWORK_CAP,
  isDatacenter,
  LEASE_MAX,
  LEASE_MIN,
  LEASE_MS,
  NETWORK_CAPPED,
  plan,
  PLANS,
  PUBLIC_CAPS,
  PUBLIC_DAILY_BUDGET,
  utcDay,
  utcMonth,
} from "./plans";

/** What a lease answers about its subject. */
export type LeaseStatus =
  | "active"
  // The account's period quota (or the public tier's network / block / ASN cap) is used up.
  | "exhausted"
  // A Free key's network used FREE_NETWORK_CAP this month (shared with keyless traffic).
  | "network"
  // The global daily keyless budget is used up.
  | "capacity"
  // Credits remain but are reserved by other isolates' leases; retry shortly.
  | "busy"
  | "suspended"
  | "revoked"
  | "unknown";

/** One lease request (an isolate's line for a subject). Counts are credits. */
export interface LeaseLine {
  /** `key:<32 hex>` or `anon:<32 hex>`. */
  subject: string;
  /** The client network's keyed hash (the public-tier id), sent with keys too. */
  net?: string;
  /** Keyed hash of the IPv4 /24 or IPv6 /48 (keyless only). */
  block?: string;
  /** request.cf.asn (keyless only). */
  asn?: number;
  /** The lease being renewed. */
  lease?: string;
  /** Credits and requests served since the last acknowledged renewal. */
  used?: number;
  requests?: number;
  /** Cumulative credits and requests reported on this lease (makes a retried renewal idempotent). */
  total?: number;
  requests_total?: number;
  /** Unused credits the isolate hands back (already removed from its allowance). */
  release?: number;
  /** Credits the isolate expects to need until its next renewal. */
  want?: number;
  /** Credits the request waiting on this renewal needs (its worst case). */
  need?: number;
}

export interface LeaseGrant {
  status: LeaseStatus;
  plan?: string;
  account?: string;
  rps?: number;
  /** Use the strict global per-second limiter (RateBudget). */
  limiter?: boolean;
  lease: string | null;
  /** The lease's whole reservation after this renewal: what the isolate may still serve, including what it served since sending the request. */
  reserved: number;
  ttl_ms: number;
}

/** Keyless lines reserve less at a time (10 req/s per network is about 12k credits a minute). */
const PUBLIC_LEASE_MAX = 200_000;
/** A top-up takes at most this share of what is left under a cap, so isolates share the tail. */
const FAIR_SHARE = 4;
/** Expired leases released per call (the cron releases the rest). */
const SWEEP = 20;

interface Target {
  id: string;
  cap: number;
  /** Status when this target refuses. */
  refusal: LeaseStatus;
  /** SQL for its `used` value, and the binds. */
  used: [string, unknown[]];
  /** Statements adding a report of `units` credits / `requests` requests. */
  add: (db: D1Database, units: number, requests: number) => D1PreparedStatement[];
  /** When the counter's row may be deleted (0: once nothing is reserved). */
  expires: number;
}

const hex32 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
const count = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0);
const MONTH_MS = 32 * 24 * 3600 * 1000;

function bucketTarget(id: string, cap: number, refusal: LeaseStatus, expires: number): Target {
  return {
    id,
    cap,
    refusal,
    used: ["COALESCE((SELECT used FROM usage_buckets WHERE id = ?), 0)", [id]],
    add: (db, units, requests) => [
      db
        .prepare(
          "INSERT INTO usage_buckets (id, used, requests, reserved, expires_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT (id) DO UPDATE SET used = used + excluded.used, requests = requests + excluded.requests",
        )
        .bind(id, units, requests, expires),
    ],
    expires,
  };
}

function networkTarget(net: string, month: number, cap: number, refusal: LeaseStatus, now: number, keyed: boolean): Target {
  return {
    id: `net:${net}:${month}`,
    cap,
    refusal,
    used: ["COALESCE((SELECT units FROM public_usage WHERE id = ? AND month = ?), 0)", [net, month]],
    add: (db, units, requests) => [
      db
        .prepare(
          "INSERT INTO public_usage (id, month, units, requests, key_units) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id, month) DO UPDATE SET units = units + excluded.units, requests = requests + excluded.requests, key_units = key_units + excluded.key_units",
        )
        .bind(net, month, units, requests, keyed ? units : 0),
    ],
    expires: now + MONTH_MS * 2,
  };
}

/** The resolved subject: its grant fields and the targets it leases against. */
interface Subject {
  grant: Omit<LeaseGrant, "lease" | "reserved" | "ttl_ms">;
  targets: Target[];
  /** Usage writes that are not targets (hourly key usage). */
  extra: (db: D1Database, units: number, requests: number) => D1PreparedStatement[];
  /** No reservation needed (internal plan). */
  unlimited: boolean;
  maxLease: number;
}

async function resolve(db: D1Database, line: LeaseLine, now: number): Promise<Subject | LeaseStatus> {
  const [kind, id] = line.subject.split(":") as [string, string | undefined];
  const month = utcMonth(now);
  if (kind === "anon" && hex32(id)) {
    // Keyless: the client network, its /24 and ASN, and the global day.
    const dc = isDatacenter(line.asn);
    const caps = dc ? DATACENTER_CAPS : PUBLIC_CAPS;
    const targets = [networkTarget(id, month, caps.net, "exhausted", now, false)];
    if (hex32(line.block)) targets.push(bucketTarget(`block:${line.block}:${month}`, caps.block, "exhausted", now + MONTH_MS * 2));
    if (typeof line.asn === "number" && Number.isSafeInteger(line.asn) && line.asn > 0) {
      targets.push(bucketTarget(`asn:${line.asn}:${month}`, caps.asn, "exhausted", now + MONTH_MS * 2));
    }
    targets.push(bucketTarget(`day:${utcDay(now)}`, PUBLIC_DAILY_BUDGET, "capacity", now + 3 * 24 * 3600 * 1000));
    const p = PLANS.public;
    return {
      grant: { status: "active", plan: p.id, rps: p.rps, limiter: false },
      targets,
      extra: () => [],
      unlimited: false,
      maxLease: PUBLIC_LEASE_MAX,
    };
  }
  if (kind !== "key" || !hex32(id)) return "unknown";
  const state = await keyState(db, id, now);
  if (state.status !== "ok") return state.status;
  const account = state.account;
  const p = plan(account.plan);
  const hour = Math.floor(now / 3_600_000);
  const extra = (d: D1Database, units: number, requests: number) => [
    d
      .prepare(
        "INSERT INTO usage (key_id, hour, address, units, requests) VALUES (?, ?, ?, ?, ?) ON CONFLICT (key_id, hour) DO UPDATE SET units = units + excluded.units, requests = requests + excluded.requests",
      )
      .bind(id, hour, account.address, units, requests),
  ];
  const grant = { status: "active" as LeaseStatus, account: account.address, plan: p.id, rps: p.rps, limiter: p.strictRate };
  const accountTarget: Target = {
    id: `acct:${account.address}`,
    cap: p.included,
    refusal: "exhausted",
    used: ["COALESCE((SELECT period_units FROM accounts WHERE address = ?), 0)", [account.address]],
    add: (d, units) => [d.prepare("UPDATE accounts SET period_units = period_units + ? WHERE address = ?").bind(units, account.address)],
    // The reservation row lives as long as leases hold it.
    expires: 0,
  };
  if (p.id === "internal") return { grant, targets: [accountTarget], extra, unlimited: true, maxLease: LEASE_MAX };
  const targets = [accountTarget];
  // Non-paying keys share the client network's cap with keyless traffic.
  if (NETWORK_CAPPED.has(p.id) && hex32(line.net)) targets.push(networkTarget(line.net, month, FREE_NETWORK_CAP, "network", now, true));
  return { grant, targets, extra, unlimited: false, maxLease: LEASE_MAX };
}

/** Releases expired leases' reservations from their targets (atomic per lease). */
function releaseExpired(db: D1Database, leaseId: string, now: number): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE usage_buckets SET reserved = MAX(0, reserved - COALESCE((SELECT reserved FROM leases WHERE id = ?1 AND expires_at <= ?2), 0))
         WHERE id IN (SELECT target FROM lease_targets WHERE lease_id = ?1)`,
      )
      .bind(leaseId, now),
    db.prepare("UPDATE leases SET reserved = 0 WHERE id = ?1 AND expires_at <= ?2").bind(leaseId, now),
  ];
}

/** Releases up to `limit` expired leases (every lease call, and the cron). */
export async function sweepLeases(db: D1Database, now: number, limit = SWEEP): Promise<number> {
  const expired = await db.prepare("SELECT id FROM leases WHERE reserved > 0 AND expires_at <= ? ORDER BY expires_at LIMIT ?").bind(now, limit).all<{ id: string }>();
  if (!expired.results.length) return 0;
  await db.batch(expired.results.flatMap((r) => releaseExpired(db, r.id, now)));
  return expired.results.length;
}

/** Deletes long-expired leases and finished counters (cron). */
export async function pruneLeases(db: D1Database, now: number): Promise<void> {
  const before = now - 24 * 3600 * 1000;
  await db.batch([
    db.prepare("DELETE FROM lease_targets WHERE lease_id IN (SELECT id FROM leases WHERE reserved = 0 AND expires_at < ?)").bind(before),
    db.prepare("DELETE FROM leases WHERE reserved = 0 AND expires_at < ?").bind(before),
    db.prepare("DELETE FROM usage_buckets WHERE reserved = 0 AND expires_at < ?").bind(now),
  ]);
}

const newLeaseId = () => crypto.randomUUID().replaceAll("-", "");

/** One line: settle the report, then top the lease up within every target's cap. */
async function leaseOne(db: D1Database, line: LeaseLine, now: number): Promise<LeaseGrant> {
  const subject = await resolve(db, line, now);
  if (typeof subject === "string") return { status: subject, lease: null, reserved: 0, ttl_ms: LEASE_MS };
  const { targets } = subject;
  const targetKey = targets.map((t) => t.id).sort().join(" ");
  const expires = now + LEASE_MS;

  // The lease row (if any) for idempotent settlement.
  const given = hex32(line.lease) ? line.lease : null;
  const row = given
    ? await db.prepare("SELECT reserved, expires_at, reported_units, reported_requests, targets FROM leases WHERE id = ?").bind(given).first<{
        reserved: number;
        expires_at: number;
        reported_units: number;
        reported_requests: number;
        targets: string;
      }>()
    : null;
  const total = count(line.total);
  const totalRequests = count(line.requests_total);
  const units = row ? Math.max(0, total - row.reported_units) : count(line.used);
  const requests = row ? Math.max(0, totalRequests - row.reported_requests) : count(line.requests);
  const release = count(line.release);

  const writes: D1PreparedStatement[] = [];
  // Usage: the counters and the hourly key rows (kept for the usage tables).
  if (units > 0 || requests > 0) {
    for (const t of targets) writes.push(...t.add(db, units, requests));
    writes.push(...subject.extra(db, units, requests));
  }

  if (subject.unlimited) {
    if (writes.length) await db.batch(writes);
    return { ...subject.grant, lease: null, reserved: LEASE_MAX, ttl_ms: LEASE_MS };
  }

  // Settle the lease: expired -> release all of it; same targets -> move the report out of
  // the reservation; other targets (plan changed) -> release it and start a new lease.
  let leaseId = given ?? newLeaseId();
  if (row && row.targets !== targetKey) {
    if (row.expires_at > now) writes.push(db.prepare("UPDATE leases SET expires_at = ? WHERE id = ?").bind(now, leaseId));
    writes.push(...releaseExpired(db, leaseId, now));
    leaseId = newLeaseId();
  } else if (row && row.expires_at <= now) {
    writes.push(...releaseExpired(db, leaseId, now));
  } else if (row) {
    const settle = units + release;
    writes.push(
      db
        .prepare(
          `UPDATE usage_buckets SET reserved = MAX(0, reserved - MIN(?2, COALESCE((SELECT reserved FROM leases WHERE id = ?1), 0)))
           WHERE id IN (SELECT target FROM lease_targets WHERE lease_id = ?1)`,
        )
        .bind(leaseId, settle),
      db.prepare("UPDATE leases SET reserved = MAX(0, reserved - ?2) WHERE id = ?1").bind(leaseId, settle),
    );
  }
  const fresh = !row || leaseId !== given;
  if (fresh) {
    writes.push(
      db
        .prepare("INSERT INTO leases (id, subject, targets, reserved, expires_at, reported_units, reported_requests, created_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)")
        .bind(leaseId, line.subject, targetKey, expires, total, totalRequests, now),
      ...targets.map((t) => db.prepare("INSERT OR IGNORE INTO lease_targets (lease_id, target) VALUES (?, ?)").bind(leaseId, t.id)),
    );
  } else {
    writes.push(
      db
        .prepare("UPDATE leases SET expires_at = ?, reported_units = MAX(reported_units, ?), reported_requests = MAX(reported_requests, ?) WHERE id = ?")
        .bind(expires, total, totalRequests, leaseId),
    );
  }
  await db.batch(writes);

  // Top up: read the targets, size the grant, apply it only if every cap still holds.
  const need = count(line.need);
  const want = Math.min(subject.maxLease, Math.max(LEASE_MIN, count(line.want)));
  let own = 0;
  let avail = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await readState(db, leaseId, targets);
    own = state.own;
    avail = Math.min(...targets.map((t, i) => t.cap - state.used[i]! - state.reserved[i]!));
    let topUp = Math.max(0, Math.min(want - own, Math.floor(avail / FAIR_SHARE)));
    // Always let the waiting request through when it fits under every cap.
    if (own + topUp < need && avail >= need - own) topUp = need - own;
    if (topUp <= 0) break;
    if (await applyTopUp(db, leaseId, own, topUp, targets, expires)) {
      own += topUp;
      break;
    }
  }
  if (own >= need && own > 0) return { ...subject.grant, lease: leaseId, reserved: own, ttl_ms: LEASE_MS };
  // Refused: a target whose cap is used up (ignoring reservations) is exhausted; otherwise
  // the remaining credits are held by other leases.
  const state = await readState(db, leaseId, targets);
  const full = targets.find((t, i) => t.cap - state.used[i]! < Math.max(1, need));
  return { ...subject.grant, status: full ? full.refusal : "busy", lease: leaseId, reserved: own, ttl_ms: LEASE_MS };
}

async function readState(db: D1Database, leaseId: string, targets: Target[]): Promise<{ own: number; used: number[]; reserved: number[] }> {
  const columns = targets.flatMap((t, i) => [`${t.used[0]} AS u${i}`, `COALESCE((SELECT reserved FROM usage_buckets WHERE id = ?), 0) AS r${i}`]);
  const binds = targets.flatMap((t) => [...t.used[1], t.id]);
  const row = await db
    .prepare(`SELECT COALESCE((SELECT reserved FROM leases WHERE id = ?), 0) AS own, ${columns.join(", ")}`)
    .bind(leaseId, ...binds)
    .first<Record<string, number>>();
  return {
    own: row?.own ?? 0,
    used: targets.map((_, i) => row?.[`u${i}`] ?? 0),
    reserved: targets.map((_, i) => row?.[`r${i}`] ?? 0),
  };
}

/**
 * Adds `topUp` to the lease and to each target's reservation, all or nothing: the lease update
 * is one statement conditioned on every target's `used + reserved + topUp <= cap`, and the
 * targets are only updated when the lease update applied (same D1 transaction).
 */
async function applyTopUp(db: D1Database, leaseId: string, own: number, topUp: number, targets: Target[], expires: number): Promise<boolean> {
  const conditions = targets.map((t) => `(${t.used[0]} + COALESCE((SELECT reserved FROM usage_buckets WHERE id = ?), 0) + ? <= ?)`);
  const binds = targets.flatMap((t) => [...t.used[1], t.id, topUp, t.cap]);
  const statements = [
    db.prepare(`UPDATE leases SET reserved = reserved + ? WHERE id = ? AND reserved = ? AND ${conditions.join(" AND ")}`).bind(topUp, leaseId, own, ...binds),
    ...targets.map((t) =>
      db
        .prepare(
          `INSERT INTO usage_buckets (id, used, requests, reserved, expires_at) SELECT ?, 0, 0, ?, ? WHERE (SELECT reserved FROM leases WHERE id = ?) = ?
           ON CONFLICT (id) DO UPDATE SET reserved = reserved + excluded.reserved`,
        )
        .bind(t.id, topUp, Math.max(expires, t.expires), leaseId, own + topUp),
    ),
  ];
  const results = await db.batch(statements);
  return (results[0]?.meta.changes ?? 0) === 1;
}

/** The sweep of expired leases runs on a lease call at most this often per isolate (the cron runs it too). */
const SWEEP_INTERVAL_MS = 10_000;
let lastSweep = -Infinity;

/** `POST /lease` on the Access entrypoint: renews each line in order. */
export async function lease(db: D1Database, lines: LeaseLine[], now: number): Promise<LeaseGrant[]> {
  // Every D1 round trip here queues behind every other lease call's (D1 serializes a database's
  // queries), so a lease call does only its own line's work; the sweep is amortized.
  if (now - lastSweep >= SWEEP_INTERVAL_MS) {
    lastSweep = now;
    await sweepLeases(db, now);
  }
  const out: LeaseGrant[] = [];
  for (const line of lines) {
    out.push(typeof line?.subject === "string" ? await leaseOne(db, line, now) : { status: "unknown", lease: null, reserved: 0, ttl_ms: LEASE_MS });
  }
  return out;
}

