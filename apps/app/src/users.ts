// Account list for the admin Users page (/admin). Suspending and lifting a suspension use
// POST /api/admin/account/:address (src/admin.ts), which logs every change.
//
//   GET /api/admin/accounts[?q=&status=all|active|suspended|paid&limit=]  newest first

import { getAddress } from "viem";
import { hasColumn } from "./admin";

export interface UsersEnv {
  DB: D1Database;
}

interface Row {
  address: string;
  created_at: number;
  plan: string;
  paid_until: number;
  period_units: number;
  suspended_at: number | null;
  suspended_reason: string | null;
  suspended_flag: number;
  billing: string | null;
  admin_note: string | null;
  keys: number;
  paid_usd_cents: number;
}

export async function listAccounts(env: UsersEnv, url: URL, now: number) {
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 80);
  const status = url.searchParams.get("status") ?? "all";
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100));
  const flag = (await hasColumn(env.DB, "accounts", "suspended")) ? "a.suspended" : "0";
  const note = (await hasColumn(env.DB, "accounts", "admin_note")) ? "a.admin_note" : "NULL";
  const suspended = `(a.suspended_at IS NOT NULL OR ${flag} = 1)`;
  const where: string[] = [];
  const binds: unknown[] = [];
  if (status === "suspended") where.push(suspended);
  if (status === "active") where.push(`NOT ${suspended}`);
  if (status === "paid") where.push("a.plan NOT IN ('free', 'internal', 'unverified') AND a.paid_until > ?") && binds.push(now);
  if (q) {
    // An address (or its start), or a word of the billing details (name, tax ID, country).
    where.push("(a.address LIKE ? OR LOWER(COALESCE(a.billing, '')) LIKE ?)");
    binds.push(`${q}%`, `%${q.replace(/[%_]/g, "")}%`);
  }
  const rows = await env.DB.prepare(
    `SELECT a.address, a.created_at, a.plan, a.paid_until, a.period_units, a.suspended_at, a.suspended_reason,
            ${flag} AS suspended_flag, a.billing, ${note} AS admin_note,
            (SELECT COUNT(*) FROM api_keys k WHERE k.address = a.address AND k.revoked_at IS NULL) AS keys,
            (SELECT COALESCE(SUM(usd_cents), 0) FROM invoices i WHERE i.address = a.address AND i.status = 'paid') AS paid_usd_cents
       FROM accounts a ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY a.created_at DESC LIMIT ?`,
  )
    .bind(...binds, limit)
    .all<Row>();
  const totals = await env.DB.prepare(`SELECT COUNT(*) AS accounts, SUM(CASE WHEN ${suspended} THEN 1 ELSE 0 END) AS suspended FROM accounts a`).first<{
    accounts: number;
    suspended: number;
  }>();
  return {
    totals: { accounts: totals?.accounts ?? 0, suspended: totals?.suspended ?? 0 },
    accounts: rows.results.map((r) => {
      let billing: { name?: string; country?: string; tax_id?: string; business?: boolean } | null = null;
      try {
        billing = r.billing ? JSON.parse(r.billing) : null;
      } catch {
        billing = null;
      }
      return {
        address: getAddress(r.address),
        created_at: r.created_at,
        plan: r.plan,
        paid_until: r.paid_until > now ? r.paid_until : null,
        period_credits: r.period_units,
        keys: r.keys,
        paid_usd: r.paid_usd_cents / 100,
        customer: billing ? { name: billing.name ?? null, country: billing.country ?? null, tax_id: billing.tax_id || null, business: billing.business === true } : null,
        suspended: r.suspended_at !== null || r.suspended_flag === 1,
        suspended_at: r.suspended_at,
        suspended_reason: r.suspended_reason,
        admin_note: r.admin_note,
      };
    }),
  };
}

/** The users part of the admin API (already authorized), or null for other paths. */
export async function usersApi(request: Request, env: UsersEnv, url: URL, now: number): Promise<Response | null> {
  if (url.pathname !== "/api/admin/accounts" || request.method !== "GET") return null;
  return new Response(JSON.stringify(await listAccounts(env, url, now), null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
