// D1 access for nullrpc-app. Every account read applies `roll` and
// persists it, so plan expiry and period resets need no scheduled job.

import { applyPurchase, applyUsage, checkPurchase, exhausted, newAccount, plan, PERIOD_MS, PLANS, roll, utcMonth, type AccountState, type PlanId } from "./plans";

export interface Account extends AccountState {
  address: string;
  created_at: number;
}

const ACCOUNT_COLUMNS = "address, created_at, plan, paid_until, period_start, period_end, period_units, balance_nano";

async function persistRoll(db: D1Database, account: Account, now: number): Promise<Account> {
  const next = roll(account, now);
  if (!next) return account;
  await db
    .prepare("UPDATE accounts SET plan = ?, period_start = ?, period_end = ?, period_units = 0 WHERE address = ? AND period_end = ?")
    .bind(next.plan, next.period_start, next.period_end, account.address, account.period_end)
    .run();
  return { ...account, ...next };
}

export async function ensureAccount(db: D1Database, address: string, now: number): Promise<Account> {
  const fresh = newAccount(now);
  await db
    .prepare(`INSERT OR IGNORE INTO accounts (${ACCOUNT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(address, now, fresh.plan, fresh.paid_until, fresh.period_start, fresh.period_end, 0, 0)
    .run();
  const account = await getAccount(db, address, now);
  if (!account) throw new Error("account not created");
  return account;
}

export async function getAccount(db: D1Database, address: string, now: number): Promise<Account | null> {
  const row = await db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE address = ?`).bind(address).first<Account>();
  return row ? persistRoll(db, row, now) : null;
}

export type KeyStatus = "active" | "revoked" | "exhausted" | "suspended" | "unknown";

export interface Entitlement {
  status: KeyStatus;
  account?: string;
  plan?: string;
  rps?: number;
}

/**
 * An API key's state. Suspended: the account's `suspended_at` (sanctions, abuse) or
 * `suspended` flag, or the key's `suspended` flag (migration 0005).
 */
export async function keyState(
  db: D1Database,
  id: string,
  now: number,
): Promise<{ status: "unknown" | "revoked" | "suspended" } | { status: "ok"; account: Account }> {
  const row = await db
    .prepare(
      "SELECT k.revoked_at, k.suspended AS key_suspended, a.suspended_at, a.suspended AS account_suspended, a.address FROM api_keys k JOIN accounts a ON a.address = k.address WHERE k.id = ?",
    )
    .bind(id)
    .first<{ revoked_at: number | null; key_suspended: number | null; suspended_at: number | null; account_suspended: number | null; address: string }>();
  if (!row) return { status: "unknown" };
  if (row.revoked_at !== null) return { status: "revoked" };
  if (row.suspended_at !== null || row.account_suspended || row.key_suspended) return { status: "suspended" };
  const account = await getAccount(db, row.address, now);
  return account ? { status: "ok", account } : { status: "unknown" };
}

/**
 * What the RPC Worker needs for key `id` (internal `Access` entrypoint, `GET /entitlement`;
 * current RPC Workers use `POST /lease`, src/leases.ts). RPC Workers deployed before
 * suspension existed do not know the "suspended" status (they would fall back to serving the
 * key), so unless `v2` it is reported as "revoked".
 */
export async function entitlement(db: D1Database, id: string, now: number, v2 = false): Promise<Entitlement> {
  const state = await keyState(db, id, now);
  if (state.status === "suspended") return { status: v2 ? "suspended" : "revoked" };
  if (state.status !== "ok") return { status: state.status };
  const p = plan(state.account.plan);
  return { status: exhausted(state.account) ? "exhausted" : "active", account: state.account.address, plan: p.id, rps: p.rps };
}

/** The public tier's entitlement for client network `id` (a keyed hash; no IP). */
export async function publicEntitlement(db: D1Database, id: string, now: number): Promise<Entitlement> {
  const row = await db.prepare("SELECT units FROM public_usage WHERE id = ? AND month = ?").bind(id, utcMonth(now)).first<{ units: number }>();
  const p = PLANS.public;
  return { status: (row?.units ?? 0) >= p.included ? "exhausted" : "active", plan: p.id, rps: p.rps };
}

/** One metering entry: an API key (`key`) or a public-tier client network (`anon`). */
export interface UsageEntry {
  key?: string;
  anon?: string;
  units: number;
  requests: number;
}

/**
 * Applies a metering flush from an RPC Worker: hourly rows per key, the period's units
 * and the overage charge per account. Returns each key's status after the flush.
 */
export async function recordUsage(db: D1Database, entries: UsageEntry[], now: number): Promise<Record<string, KeyStatus>> {
  const counted = (e: UsageEntry) => Number.isSafeInteger(e.units) && e.units > 0 && Number.isSafeInteger(e.requests) && e.requests >= 0;
  const hex32 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{32}$/.test(v);
  const keyed = entries.filter((e) => counted(e) && hex32(e.key)) as (UsageEntry & { key: string })[];
  const anon = entries.filter((e) => counted(e) && hex32(e.anon)) as (UsageEntry & { anon: string })[];
  const out: Record<string, KeyStatus> = {};
  const statements: D1PreparedStatement[] = [];

  // Public tier: monthly totals per client network.
  const month = utcMonth(now);
  const anonUnits = new Map<string, number>();
  for (const e of anon) {
    statements.push(
      db
        .prepare(
          "INSERT INTO public_usage (id, month, units, requests) VALUES (?, ?, ?, ?) ON CONFLICT (id, month) DO UPDATE SET units = units + excluded.units, requests = requests + excluded.requests",
        )
        .bind(e.anon, month, e.units, e.requests),
    );
    anonUnits.set(e.anon, (anonUnits.get(e.anon) ?? 0) + e.units);
  }
  if (anonUnits.size) {
    const ids = [...anonUnits.keys()];
    const rows = await db
      .prepare(`SELECT id, units FROM public_usage WHERE month = ? AND id IN (${ids.map(() => "?").join(", ")})`)
      .bind(month, ...ids)
      .all<{ id: string; units: number }>();
    const before = new Map(rows.results.map((r) => [r.id, r.units]));
    for (const [id, units] of anonUnits) {
      out[`anon:${id}`] = (before.get(id) ?? 0) + units >= PLANS.public.included ? "exhausted" : "active";
    }
  }

  // API keys.
  const ids = [...new Set(keyed.map((e) => e.key))];
  const ownerOf = new Map<string, string>();
  const suspended = new Set<string>();
  const suspendedKeys = new Set<string>();
  if (ids.length) {
    const owners = await db
      .prepare(
        `SELECT k.id, k.address, a.suspended_at, a.suspended AS account_suspended, k.suspended AS key_suspended FROM api_keys k JOIN accounts a ON a.address = k.address WHERE k.id IN (${ids.map(() => "?").join(", ")})`,
      )
      .bind(...ids)
      .all<{ id: string; address: string; suspended_at: number | null; account_suspended: number | null; key_suspended: number | null }>();
    for (const r of owners.results) {
      ownerOf.set(r.id, r.address);
      if (r.suspended_at !== null || r.account_suspended) suspended.add(r.address);
      if (r.key_suspended) suspendedKeys.add(r.id);
    }
  }
  const hour = Math.floor(now / 3_600_000);
  const unitsByAccount = new Map<string, number>();
  for (const e of keyed) {
    const address = ownerOf.get(e.key);
    if (!address) continue;
    statements.push(
      db
        .prepare(
          "INSERT INTO usage (key_id, hour, address, units, requests) VALUES (?, ?, ?, ?, ?) ON CONFLICT (key_id, hour) DO UPDATE SET units = units + excluded.units, requests = requests + excluded.requests",
        )
        .bind(e.key, hour, address, e.units, e.requests),
    );
    unitsByAccount.set(address, (unitsByAccount.get(address) ?? 0) + e.units);
  }
  const statusOf = new Map<string, KeyStatus>();
  for (const [address, units] of unitsByAccount) {
    const account = await getAccount(db, address, now);
    if (!account) continue;
    const { chargeNano } = applyUsage(account, units);
    statements.push(
      db
        .prepare("UPDATE accounts SET period_units = period_units + ?, balance_nano = balance_nano - ? WHERE address = ?")
        .bind(units, chargeNano, address),
    );
    const after = { ...account, period_units: account.period_units + units, balance_nano: account.balance_nano - chargeNano };
    statusOf.set(address, suspended.has(address) ? "revoked" : exhausted(after) ? "exhausted" : "active");
  }
  if (statements.length) await db.batch(statements);
  // Legacy RPC Workers: a suspension is reported as "revoked" (they do not know "suspended").
  for (const id of ids) out[`key:${id}`] = suspendedKeys.has(id) ? "revoked" : (statusOf.get(ownerOf.get(id) ?? "") ?? "unknown");
  return out;
}

export interface Invoice {
  id: string;
  address: string;
  kind: "plan" | "topup";
  plan: string | null;
  months: number | null;
  usd_cents: number;
  chain_id: number;
  asset: string;
  amount: string;
  created_at: number;
  expires_at: number;
  status: string;
  tx_hash: string | null;
  paid_at: number | null;
  note: string | null;
  subtotal_cents: number | null;
  tax_cents: number;
  /** JSON (src/tax.ts `Tax`). */
  tax: string | null;
  /** JSON: billing details and location evidence at creation. */
  buyer: string | null;
  consent: string | null;
  number: string | null;
  withdrawn_at: number | null;
  refund_cents: number | null;
  refund_tx: string | null;
}

/**
 * Credits a verified invoice exactly once: the account change and the invoice's move to
 * `paid` run in one D1 batch (a transaction), both conditioned on the invoice still
 * being `pending`. A plan purchase that is no longer valid (for example a downgrade
 * bought while a higher plan started) is credited to the balance instead.
 */
export async function creditInvoice(db: D1Database, invoice: Invoice, now: number): Promise<boolean> {
  const account = await getAccount(db, invoice.address, now);
  if (!account) return false;
  const pending = "EXISTS (SELECT 1 FROM invoices WHERE id = ? AND status = 'pending')";
  let update: D1PreparedStatement;
  let note: string | null = null;
  const valid = invoice.kind === "plan" && invoice.plan && invoice.months && checkPurchase(account, invoice.plan, invoice.months, now) === null;
  if (valid) {
    const next = applyPurchase(account, invoice.plan as PlanId, invoice.months as number, now);
    update = db
      .prepare(`UPDATE accounts SET plan = ?, paid_until = ?, period_start = ?, period_end = ?, period_units = ? WHERE address = ? AND ${pending}`)
      .bind(next.plan, next.paid_until, next.period_start, next.period_end, next.period_units, account.address, invoice.id);
  } else {
    if (invoice.kind === "plan") note = "plan no longer applicable; kept as account credit";
    update = db
      .prepare(`UPDATE accounts SET balance_nano = balance_nano + ? WHERE address = ? AND ${pending}`)
      .bind(invoice.usd_cents * 10_000_000, account.address, invoice.id);
  }
  // The invoice number is sequential and assigned in the same transaction (no gaps).
  const results = await db.batch([
    update,
    db.prepare(`UPDATE counters SET value = value + 1 WHERE name = 'invoice' AND ${pending}`).bind(invoice.id),
    db
      .prepare(
        "UPDATE invoices SET status = 'paid', paid_at = ?, note = ?, number = (SELECT printf('NR-%06d', value) FROM counters WHERE name = 'invoice') WHERE id = ? AND status = 'pending'",
      )
      .bind(now, note, invoice.id),
  ]);
  return (results[2]?.meta.changes ?? 0) === 1;
}

export type WithdrawError = "not_found" | "not_paid" | "not_latest" | "already";

/**
 * A consumer's withdrawal from a paid plan. Only the
 * account's latest paid plan invoice can be withdrawn; the plan time it bought that is still
 * unused is removed (back to Free when none is left). `prorata` refunds that unused share
 * (EU); otherwise the whole payment. The refund itself is sent by hand (`refund_tx`).
 */
export async function withdrawInvoice(db: D1Database, invoice: Invoice, prorata: boolean, now: number): Promise<{ refundCents: number } | WithdrawError> {
  if (invoice.status !== "paid" || invoice.kind !== "plan" || !invoice.months || invoice.note) return "not_paid";
  if (invoice.withdrawn_at !== null) return "already";
  const latest = await db
    .prepare("SELECT id FROM invoices WHERE address = ? AND status = 'paid' AND kind = 'plan' AND withdrawn_at IS NULL ORDER BY paid_at DESC LIMIT 1")
    .bind(invoice.address)
    .first<{ id: string }>();
  if (latest?.id !== invoice.id) return "not_latest";
  const account = await getAccount(db, invoice.address, now);
  if (!account) return "not_found";
  const bought = invoice.months * PERIOD_MS;
  const unused = Math.max(0, Math.min(bought, account.paid_until - now));
  const refundCents = prorata ? Math.floor((invoice.usd_cents * unused) / bought) : invoice.usd_cents;
  const paidUntil = account.paid_until - unused;
  const statements = [
    db.prepare("UPDATE invoices SET withdrawn_at = ?, refund_cents = ? WHERE id = ? AND withdrawn_at IS NULL").bind(now, refundCents, invoice.id),
  ];
  if (paidUntil <= now) {
    // Nothing paid is left: back to Free with a fresh period. [sign-up controls] A wallet that
    // failed the free-plan gate (src/gate.ts) goes back to `unverified`: a refunded payment
    // does not lift the gate.
    statements.push(
      db.prepare("UPDATE accounts SET plan = CASE WHEN wallet_check IN ('failed', 'pending', 'capped') THEN 'unverified' ELSE 'free' END, paid_until = 0, period_start = ?, period_end = ?, period_units = 0 WHERE address = ?").bind(now, now + PERIOD_MS, invoice.address),
    );
  } else {
    statements.push(db.prepare("UPDATE accounts SET paid_until = ? WHERE address = ?").bind(paidUntil, invoice.address));
  }
  const results = await db.batch(statements);
  return (results[0]?.meta.changes ?? 0) === 1 ? { refundCents } : "already";
}
