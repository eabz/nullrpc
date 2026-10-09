// Admin API. Bearer ADMIN_TOKEN (a secret on
// nullrpc-app), compared in constant time; the whole API answers 404 while the secret is unset.
//
//   GET  /api/admin/report[?day=YYYYMMDD|live=1]  the stored daily anomaly report (or a fresh one)
//   GET  /api/admin/account/:address              account, keys, payments, usage, admin log
//   POST /api/admin/account/:address              {suspended?: bool, plan?: PlanId, months?, note?}
//   POST /api/admin/key/:id                       {suspended: bool, note?}
//   GET  /api/admin/accounts                      account list for the Users page (src/users.ts)
//   GET  /api/admin/refunds, POST …/refunds/:id   refunds owed and sent (src/refunds.ts)
//
// The admin page /admin (public/admin.html) is a client of this API.
//
// Account suspension uses `accounts.suspended_at` / `suspended_reason` (migration 0003; refused
// at sign-in, in the API and for every key) and also sets `accounts.suspended` when that column
// exists. Key suspension needs `api_keys.suspended` (usage-enforcement migration).

import { getAddress, isAddress } from "viem";
import { getAccount } from "./db";
import { PERIOD_MS, PLANS, type PlanId } from "./plans";
import { refundsApi } from "./refunds";
import { buildReport, type ReportEnv } from "./report";
import { usersApi } from "./users";

export interface AdminEnv extends ReportEnv {
  /** Secret: bearer token of the admin API; unset disables it. */
  ADMIN_TOKEN?: string;
}

const enc = new TextEncoder();

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

/** Constant-time comparison of the request's bearer token with ADMIN_TOKEN (both hashed first). */
export async function authorized(request: Request, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!given) return false;
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(given)), crypto.subtle.digest("SHA-256", enc.encode(token))]);
  return crypto.subtle.timingSafeEqual(a, b);
}

const columnCache = new Map<string, boolean>();

/** Whether `table` has `column` (cached per isolate once found). */
export async function hasColumn(db: D1Database, table: string, column: string): Promise<boolean> {
  const id = `${table}.${column}`;
  if (columnCache.get(id)) return true;
  const rows = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  const found = rows.results.some((r) => r.name === column);
  if (found) columnCache.set(id, true);
  return found;
}

export async function hasTable(db: D1Database, table: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table).first()) !== null;
}

async function log(db: D1Database, now: number, target: string, action: unknown, note: string | null) {
  await db.prepare("INSERT INTO admin_log (at, target, action, note) VALUES (?, ?, ?, ?)").bind(now, target, JSON.stringify(action), note).run();
}

async function body(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const ADMIN_PLANS: PlanId[] = ["free", "unverified", "internal", "builder", "growth", "scale"];

async function accountDetail(env: AdminEnv, address: string, now: number) {
  const account = await getAccount(env.DB, address, now);
  if (!account) return null;
  const row = await env.DB.prepare("SELECT * FROM accounts WHERE address = ?").bind(address).first<Record<string, unknown>>();
  const keySuspension = await hasColumn(env.DB, "api_keys", "suspended");
  const keys = await env.DB.prepare(`SELECT id, name, created_at, revoked_at${keySuspension ? ", suspended" : ""} FROM api_keys WHERE address = ? ORDER BY created_at`)
    .bind(address)
    .all();
  const invoices = await env.DB.prepare(
    "SELECT id, number, kind, plan, months, usd_cents, status, created_at, paid_at, withdrawn_at, tx_hash, note FROM invoices WHERE address = ? ORDER BY created_at DESC LIMIT 20",
  )
    .bind(address)
    .all();
  const since = Math.floor(now / 3_600_000) - 30 * 24;
  const usage = await env.DB.prepare("SELECT key_id, SUM(units) AS units, SUM(requests) AS requests FROM usage WHERE address = ? AND hour >= ? GROUP BY key_id")
    .bind(address, since)
    .all();
  const net = typeof row?.signup_net === "string" ? row.signup_net : null;
  const sameNetwork = net
    ? await env.DB.prepare("SELECT address, plan, created_at, suspended_at FROM accounts WHERE signup_net = ? AND address != ? ORDER BY created_at DESC LIMIT 50").bind(net, address).all()
    : null;
  const history = await env.DB.prepare("SELECT at, target, action, note FROM admin_log WHERE target = ? OR target IN (SELECT 'key:' || id FROM api_keys WHERE address = ?) ORDER BY at DESC LIMIT 50")
    .bind(`account:${address}`, address)
    .all();
  const p = PLANS[account.plan as PlanId] ?? PLANS.free;
  return {
    address: getAddress(address),
    account: { ...row, plan: account.plan, period_units: account.period_units, period_start: account.period_start, period_end: account.period_end },
    quota: { included: p.included, used: account.period_units, ratio: p.included ? account.period_units / p.included : null },
    keys: keys.results,
    invoices: invoices.results,
    usage_30d: usage.results,
    same_network: sameNetwork?.results ?? [],
    admin_log: history.results.map((r) => ({ ...r, action: JSON.parse(String((r as { action: string }).action)) })),
  };
}

async function updateAccount(env: AdminEnv, address: string, input: Record<string, unknown>, now: number): Promise<Response> {
  const account = await getAccount(env.DB, address, now);
  if (!account) return reply({ error: "account not found" }, 404);
  const note = typeof input.note === "string" ? input.note.slice(0, 500) : null;
  const statements: D1PreparedStatement[] = [];
  const applied: Record<string, unknown> = {};
  if (input.suspended !== undefined) {
    if (typeof input.suspended !== "boolean") return reply({ error: "suspended must be a boolean" }, 400);
    const flag = (await hasColumn(env.DB, "accounts", "suspended")) ? ", suspended = ?" : "";
    if (input.suspended) {
      statements.push(
        env.DB.prepare(`UPDATE accounts SET suspended_at = COALESCE(suspended_at, ?), suspended_reason = COALESCE(suspended_reason, 'abuse')${flag} WHERE address = ?`).bind(
          now,
          ...(flag ? [1] : []),
          address,
        ),
      );
    } else {
      const s = await env.DB.prepare("SELECT suspended_reason FROM accounts WHERE address = ?").bind(address).first<{ suspended_reason: string | null }>();
      if (s?.suspended_reason === "sanctions") return reply({ error: "a sanctions suspension cannot be lifted here" }, 409);
      statements.push(env.DB.prepare(`UPDATE accounts SET suspended_at = NULL, suspended_reason = NULL${flag} WHERE address = ?`).bind(...(flag ? [0] : []), address));
    }
    applied.suspended = input.suspended;
  }
  if (input.plan !== undefined) {
    const planId = String(input.plan) as PlanId;
    if (!ADMIN_PLANS.includes(planId)) return reply({ error: `plan must be one of ${ADMIN_PLANS.join(", ")}` }, 400);
    const paid = PLANS[planId].priceCents > 0;
    const months = input.months === undefined ? 1 : Number(input.months);
    if (paid && (!Number.isInteger(months) || months < 1 || months > 12)) return reply({ error: "months must be an integer from 1 to 12" }, 400);
    // A changed plan starts a fresh period; a paid plan granted here runs `months` months.
    const fresh = planId !== account.plan;
    const walletCheck = planId === "free" ? "passed" : planId === "unverified" ? "failed" : null;
    statements.push(
      env.DB.prepare(
        `UPDATE accounts SET plan = ?, paid_until = ?${fresh ? ", period_start = ?, period_end = ?, period_units = 0" : ""}${walletCheck ? ", wallet_check = ?" : ""} WHERE address = ?`,
      ).bind(planId, paid ? now + months * PERIOD_MS : 0, ...(fresh ? [now, now + PERIOD_MS] : []), ...(walletCheck ? [walletCheck] : []), address),
    );
    applied.plan = planId;
    if (paid) applied.months = months;
  }
  if (note !== null) {
    statements.push(env.DB.prepare("UPDATE accounts SET admin_note = ? WHERE address = ?").bind(note, address));
  }
  if (!statements.length) return reply({ error: "nothing to change: give suspended, plan or note" }, 400);
  await env.DB.batch(statements);
  await log(env.DB, now, `account:${address}`, applied, note);
  return reply(await accountDetail(env, address, now));
}

async function updateKey(env: AdminEnv, id: string, input: Record<string, unknown>, now: number): Promise<Response> {
  if (typeof input.suspended !== "boolean") return reply({ error: "suspended must be a boolean" }, 400);
  if (!(await hasColumn(env.DB, "api_keys", "suspended"))) {
    return reply({ error: "key suspension needs the api_keys.suspended column (usage-enforcement migration); suspend the account instead" }, 501);
  }
  const r = await env.DB.prepare("UPDATE api_keys SET suspended = ? WHERE id = ?").bind(input.suspended ? 1 : 0, id).run();
  if (r.meta.changes !== 1) return reply({ error: "key not found" }, 404);
  const note = typeof input.note === "string" ? input.note.slice(0, 500) : null;
  await log(env.DB, now, `key:${id}`, { suspended: input.suspended }, note);
  const key = await env.DB.prepare("SELECT id, address, name, created_at, revoked_at, suspended FROM api_keys WHERE id = ?").bind(id).first();
  return reply({ key });
}

/** The admin API's response, or null when `url` is not an admin path. */
export async function adminApi(request: Request, env: AdminEnv, url: URL, now: number): Promise<Response | null> {
  const path = url.pathname;
  if (path !== "/api/admin" && !path.startsWith("/api/admin/")) return null;
  if (!env.ADMIN_TOKEN) return reply({ error: "not found" }, 404);
  if (!(await authorized(request, env.ADMIN_TOKEN))) return reply({ error: "unauthorized" }, 401);
  const method = request.method;

  if (path === "/api/admin/report" && method === "GET") {
    if (url.searchParams.get("live") === "1") return reply(await buildReport(env, now));
    const day = url.searchParams.get("day");
    const row = day
      ? await env.DB.prepare("SELECT day, created_at, report FROM anomaly_reports WHERE day = ?").bind(Number(day)).first<{ day: number; created_at: number; report: string }>()
      : await env.DB.prepare("SELECT day, created_at, report FROM anomaly_reports ORDER BY day DESC LIMIT 1").first<{ day: number; created_at: number; report: string }>();
    if (!row) return day ? reply({ error: "no report for that day" }, 404) : reply(await buildReport(env, now));
    return reply(JSON.parse(row.report));
  }

  const accountMatch = path.match(/^\/api\/admin\/account\/([^/]+)$/);
  if (accountMatch) {
    const raw = decodeURIComponent(accountMatch[1] as string);
    if (!isAddress(raw, { strict: false })) return reply({ error: "invalid address" }, 400);
    const address = raw.toLowerCase();
    if (method === "GET") {
      const detail = await accountDetail(env, address, now);
      return detail ? reply(detail) : reply({ error: "account not found" }, 404);
    }
    if (method === "POST") {
      const input = await body(request);
      if (!input) return reply({ error: "JSON body required" }, 400);
      return updateAccount(env, address, input, now);
    }
  }

  const keyMatch = path.match(/^\/api\/admin\/key\/([0-9a-f]{32})$/);
  if (keyMatch && method === "POST") {
    const input = await body(request);
    if (!input) return reply({ error: "JSON body required" }, 400);
    return updateKey(env, keyMatch[1] as string, input, now);
  }

  const more = (await usersApi(request, env, url, now)) ?? (await refundsApi(request, env, url, now));
  if (more) return more;

  return reply({ error: "not found" }, 404);
}
