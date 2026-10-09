// Daily anomaly report. Computed from D1 by the
// daily cron (00:05 UTC), stored in `anomaly_reports` and served at GET /api/admin/report.
// It also suspends accounts that break a hard rule.

import { PLANS, PUBLIC_DAILY_BUDGET, utcDay, utcMonth, type PlanId } from "./plans";

export interface ReportEnv {
  DB: D1Database;
}

/** Report thresholds. */
export const THRESHOLDS = {
  /** An account is reported when its period's credits exceed its plan's by this ratio. */
  overQuotaRatio: 1.01,
  /** A client network is reported with more accounts than this (all time)… */
  networkAccounts: 5,
  /** …or more active keys than this across its accounts. */
  networkKeys: 10,
  /** A key is reported when used from more client networks than this (needs per-key data). */
  keyNetworks: 20,
  /** A payment still pending after this long is reported. */
  pendingMs: 2 * 3600 * 1000,
  /** Hard rule: a network with at least this many accounts gets its
   *  unpaid free and unverified accounts suspended. */
  autoSuspendNetworkAccounts: 20,
};

const REPORT_RETENTION_DAYS = 90;
const DAY_MS = 24 * 3600 * 1000;

async function tables(db: D1Database): Promise<string[]> {
  const rows = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
  // Cloudflare's internal tables (_cf_*) are not readable.
  return rows.results.map((r) => r.name).filter((n) => !/^(_cf_|sqlite_|d1_)/.test(n));
}

async function columns(db: D1Database, table: string): Promise<string[]> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return [];
  const rows = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return rows.results.map((r) => r.name);
}

async function overQuota(db: D1Database, now: number) {
  const limits = (Object.keys(PLANS) as PlanId[])
    .filter((id) => id !== "internal" && id !== "public")
    .map((id) => `WHEN '${id}' THEN ${Math.floor(PLANS[id].included * THRESHOLDS.overQuotaRatio)}`)
    .join(" ");
  const rows = await db
    .prepare(
      `SELECT address, plan, period_units, suspended_at FROM accounts
        WHERE plan != 'internal' AND period_end > ? AND period_units > (CASE plan ${limits} ELSE ${Math.floor(PLANS.free.included * THRESHOLDS.overQuotaRatio)} END)
        ORDER BY period_units DESC LIMIT 100`,
    )
    .bind(now)
    .all<{ address: string; plan: string; period_units: number; suspended_at: number | null }>();
  return rows.results.map((r) => {
    const included = (PLANS[r.plan as PlanId] ?? PLANS.free).included;
    return { address: r.address, plan: r.plan, used: r.period_units, included, ratio: included ? Number((r.period_units / included).toFixed(4)) : null, suspended: r.suspended_at !== null };
  });
}

async function crowdedNetworks(db: D1Database) {
  const rows = await db
    .prepare(
      `SELECT a.signup_net AS net, COUNT(*) AS accounts,
              SUM(a.plan = 'free') AS free, SUM(a.plan = 'unverified') AS unverified, SUM(a.suspended_at IS NOT NULL) AS suspended,
              SUM((SELECT COUNT(*) FROM api_keys k WHERE k.address = a.address AND k.revoked_at IS NULL)) AS keys,
              MIN(a.created_at) AS first_at, MAX(a.created_at) AS last_at
         FROM accounts a WHERE a.signup_net IS NOT NULL
        GROUP BY a.signup_net HAVING accounts > ? OR keys > ?
        ORDER BY accounts DESC LIMIT 100`,
    )
    .bind(THRESHOLDS.networkAccounts, THRESHOLDS.networkKeys)
    .all<{ net: string; accounts: number; free: number; unverified: number; suspended: number; keys: number; first_at: number; last_at: number }>();
  return rows.results;
}

async function signups(db: D1Database, now: number) {
  const since = utcDay(now - 7 * DAY_MS);
  const days = await db
    .prepare("SELECT day, accounts, free FROM signup_days WHERE net = '' AND day >= ? ORDER BY day DESC")
    .bind(since)
    .all<{ day: number; accounts: number; free: number }>();
  const top = await db
    .prepare("SELECT day, net, accounts, free FROM signup_days WHERE net != '' AND day >= ? ORDER BY accounts DESC, day DESC LIMIT 50")
    .bind(utcDay(now - DAY_MS))
    .all<{ day: number; net: string; accounts: number; free: number }>();
  const gate = await db
    .prepare("SELECT COALESCE(wallet_check, 'legacy') AS check_result, COUNT(*) AS accounts FROM accounts WHERE created_at >= ? GROUP BY check_result")
    .bind(now - 7 * DAY_MS)
    .all<{ check_result: string; accounts: number }>();
  return { days: days.results, top_networks: top.results, wallet_checks_7d: gate.results };
}

/** Keyless (public tier) burn: networks, and the /24, ASN and daily-budget counters of the
 *  usage enforcement (usage_buckets, migration 0005) when present. */
async function keyless(db: D1Database, now: number, names: string[]) {
  const month = utcMonth(now);
  const total = await db
    .prepare("SELECT COUNT(*) AS networks, COALESCE(SUM(units), 0) AS units, COALESCE(SUM(requests), 0) AS requests FROM public_usage WHERE month = ?")
    .bind(month)
    .first<{ networks: number; units: number; requests: number }>();
  const keyUnits = (await columns(db, "public_usage")).includes("key_units") ? ", key_units" : "";
  const top = await db.prepare(`SELECT id AS net, units, requests${keyUnits} FROM public_usage WHERE month = ? ORDER BY units DESC LIMIT 20`).bind(month).all();
  const out = { month, ...(total ?? { networks: 0, units: 0, requests: 0 }), top_networks: top.results, daily_budget: null as unknown, top_asns: [] as unknown[], top_blocks: [] as unknown[] };
  if (!names.includes("usage_buckets")) return out;
  const days = [utcDay(now - DAY_MS), utcDay(now)].map((d) => `day:${d}`);
  const budget = await db.prepare("SELECT id, used, requests, reserved FROM usage_buckets WHERE id IN (?, ?)").bind(...days).all<{ id: string; used: number; requests: number; reserved: number }>();
  out.daily_budget = days.map((id) => {
    const row = budget.results.find((r) => r.id === id);
    return { day: Number(id.slice(4)), used: row?.used ?? 0, requests: row?.requests ?? 0, budget: PUBLIC_DAILY_BUDGET, ratio: Number(((row?.used ?? 0) / PUBLIC_DAILY_BUDGET).toFixed(4)) };
  });
  const bucket = async (prefix: string) =>
    (
      await db
        .prepare("SELECT id, used, requests FROM usage_buckets WHERE id LIKE ? ORDER BY used DESC LIMIT 20")
        .bind(`${prefix}:%:${month}`)
        .all<{ id: string; used: number; requests: number }>()
    ).results.map((r) => ({ [prefix]: r.id.slice(prefix.length + 1, r.id.lastIndexOf(":")), used: r.used, requests: r.requests }));
  out.top_asns = await bucket("asn");
  out.top_blocks = await bucket("block");
  return out;
}

/** Keys used from many client networks: the network targets of their leases (Free and
 *  unverified keys carry their client network; leases are kept about a day after expiry). */
async function keysManyNetworks(db: D1Database, names: string[]) {
  if (!names.includes("leases") || !names.includes("lease_targets")) return { available: false, reason: "no per-key client-network data is recorded", keys: [] };
  const rows = await db
    .prepare(
      `SELECT substr(l.subject, 5) AS key_id, k.address, COUNT(DISTINCT t.target) AS networks
         FROM leases l JOIN lease_targets t ON t.lease_id = l.id LEFT JOIN api_keys k ON k.id = substr(l.subject, 5)
        WHERE l.subject LIKE 'key:%' AND t.target LIKE 'net:%'
        GROUP BY key_id HAVING networks > ? ORDER BY networks DESC LIMIT 50`,
    )
    .bind(THRESHOLDS.keyNetworks)
    .all();
  return { available: true, source: "leases (last ~24 h, non-paying keys)", keys: rows.results };
}

async function payments(db: D1Database, now: number) {
  const pending = await db
    .prepare("SELECT id, address, plan, months, usd_cents, tx_hash, created_at FROM invoices WHERE status = 'pending' AND created_at < ? ORDER BY created_at LIMIT 100")
    .bind(now - THRESHOLDS.pendingMs)
    .all();
  const failed = await db
    .prepare("SELECT id, address, plan, usd_cents, tx_hash, created_at, note FROM invoices WHERE status = 'failed' AND created_at >= ? ORDER BY created_at DESC LIMIT 100")
    .bind(now - 7 * DAY_MS)
    .all();
  return { pending_too_long: pending.results, failed_7d: failed.results };
}

export type Report = Awaited<ReturnType<typeof buildReport>>;

export async function buildReport(env: ReportEnv, now: number) {
  const names = await tables(env.DB);
  return {
    day: utcDay(now),
    generated_at: now,
    thresholds: THRESHOLDS,
    auto_suspend: true,
    over_quota: await overQuota(env.DB, now),
    crowded_networks: await crowdedNetworks(env.DB),
    signups: await signups(env.DB, now),
    keyless: await keyless(env.DB, now, names),
    keys_many_networks: await keysManyNetworks(env.DB, names),
    payments: await payments(env.DB, now),
    actions: [] as { address: string; rule: string; net: string }[],
  };
}

/**
 * Hard rule: networks with at least `autoSuspendNetworkAccounts` accounts get their free and
 * unverified accounts that never paid suspended (reason `abuse:auto`). Paid accounts are never
 * touched. Returns the suspended accounts.
 */
async function autoSuspend(env: ReportEnv, report: Report, now: number) {
  const actions: Report["actions"] = [];
  for (const n of report.crowded_networks) {
    if (n.accounts < THRESHOLDS.autoSuspendNetworkAccounts) continue;
    const rows = await env.DB.prepare(
      `SELECT address FROM accounts a WHERE signup_net = ? AND suspended_at IS NULL AND plan IN ('free', 'unverified')
         AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.address = a.address AND i.status = 'paid') LIMIT 200`,
    )
      .bind(n.net)
      .all<{ address: string }>();
    for (const { address } of rows.results) {
      await env.DB.batch([
        env.DB.prepare("UPDATE accounts SET suspended_at = ?, suspended_reason = 'abuse:auto' WHERE address = ? AND suspended_at IS NULL").bind(now, address),
        env.DB.prepare("INSERT INTO admin_log (at, target, action, note) VALUES (?, ?, ?, ?)").bind(
          now,
          `account:${address}`,
          JSON.stringify({ suspended: true, rule: "network_accounts" }),
          `auto: ${n.accounts} accounts from one client network`,
        ),
      ]);
      actions.push({ address, rule: "network_accounts", net: n.net });
    }
  }
  return actions;
}

/** The daily cron: build, act (when enabled), store and prune. */
export async function daily(env: ReportEnv, now: number): Promise<Report> {
  const report = await buildReport(env, now);
  if (report.auto_suspend) report.actions = await autoSuspend(env, report, now);
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO anomaly_reports (day, created_at, report) VALUES (?, ?, ?)").bind(report.day, now, JSON.stringify(report)),
    env.DB.prepare("DELETE FROM anomaly_reports WHERE day < ?").bind(utcDay(now - REPORT_RETENTION_DAYS * DAY_MS)),
    env.DB.prepare("DELETE FROM signup_days WHERE day < ?").bind(utcDay(now - REPORT_RETENTION_DAYS * DAY_MS)),
  ]);
  console.log(
    "anomaly report",
    JSON.stringify({
      day: report.day,
      over_quota: report.over_quota.length,
      crowded_networks: report.crowded_networks.length,
      pending_payments: report.payments.pending_too_long.length,
      auto_suspended: report.actions.length,
    }),
  );
  return report;
}
