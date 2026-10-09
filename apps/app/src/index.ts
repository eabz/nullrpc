// nullrpc-app: the nullrpc platform at https://app.nullrpc.dev.
//
//   - Wallet sign-in (EIP-4361) and a signed session cookie.
//   - API keys (src/keys.ts), plans and usage (src/plans.ts, src/db.ts).
//   - On-chain payments in USDC or ETH (src/payments.ts), verified on submission and by
//     a cron for transactions still waiting for confirmations.
//   - Compliance: Terms acceptance, sanctions screening (src/sanctions.ts),
//     taxed and numbered invoices and the consumer right of withdrawal (src/tax.ts).
//   - The `Access` entrypoint, bound by the RPC Workers only (never public): key
//     entitlements and metering flushes.

import { networks } from "../../networks";
import { WorkerEntrypoint } from "cloudflare:workers";
import { getAddress } from "viem";
import { creditInvoice, ensureAccount, entitlement, publicEntitlement, recordUsage, withdrawInvoice, type Invoice } from "./db";
import { SECURITY_HEADERS } from "./headers";
import { deriveKey, newKeyId } from "./keys";
import { PRIVACY_URL, SELLER, TERMS_URL, TERMS_VERSION } from "./legal";
import { amountFor, ETH_RPC_URL, NETWORKS, publicNetworks, TREASURY_ADDRESS, txRequest, USDC_INVOICE_MS, verifyPayment } from "./payments";
import { checkPurchase, CREDITS, exhausted, newAccount, plan, priceFor, publicPlans, TYPICAL_CREDITS, utcMonth } from "./plans";
import { sanctionedPlace, screenAddress, type Screening } from "./sanctions";
import { clearedCookie, readCookie, SESSION_COOKIE, SESSION_MS, sessionCookie, sign, verify } from "./session";
import { challenge, verifySignIn } from "./siwe";
// Sign-up controls, admin API and anomaly report.
import { adminApi } from "./admin";
import { recheck, signUp, turnstileEnabled, TURNSTILE_SITE_KEY, verifyTurnstile, walletView, type WalletCheck } from "./gate";
import { daily } from "./report";
import { lease, pruneLeases, sweepLeases, type LeaseLine } from "./leases";
// The strict per-second limiter, bound by the RPC Workers.
export { RateBudget } from "./ratebudget";
import { consentText, parseBilling, taxCents, taxFor, withdrawalFor, type Billing, type Tax } from "./tax";

export interface Env {
  DB: D1Database;
  /** Runtime configuration (KV): the `networks` list, see apps/networks.ts. */
  CONFIG?: KVNamespace;
  ASSETS: Fetcher;
  /** Secret: HMAC key of the session cookie and the sign-in nonce token. */
  SESSION_SECRET: string;
  /** Secret: HMAC key of API keys; the same value is set on every RPC Worker. */
  KEY_SECRET: string;
  // ---- optional secrets
  /** Secret: Turnstile widget secret key; Turnstile is on when this and TURNSTILE_SITE_KEY are set. */
  TURNSTILE_SECRET?: string;
  /** Secret: bearer token of the admin API (/api/admin/*); unset disables it. */
  ADMIN_TOKEN?: string;
}

const MAX_KEYS = 5;
/** The daily cron (wrangler.jsonc): the anomaly report (src/report.ts). */
const DAILY_CRON = "5 0 * * *";
/** Accounts with keys or a paid plan are screened again after this long. */
const RESCREEN_MS = 24 * 3600 * 1000;
/** Hourly usage rows are deleted after 13 months (about 395 days). */
const USAGE_RETENTION_MS = 395 * 24 * 3600 * 1000;

// ---- responses

function withHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  const type = out.headers.get("content-type") ?? "";
  if (type.startsWith("text/html") || !out.headers.has("cache-control")) {
    out.headers.set("cache-control", type.startsWith("text/html") ? "no-cache, no-transform" : "public, max-age=3600, no-transform");
  }
  return out;
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return withHeaders(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
    }),
  );
}

const fail = (status: number, error: string) => json({ error }, status);

// ---- session

interface Session {
  a: string;
  exp: number;
}

async function session(request: Request, env: Env, now: number): Promise<string | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const payload = await verify<Session>(env.SESSION_SECRET, token, now);
  return payload?.a ?? null;
}

/** State-changing API calls must come from the app's own pages (CSRF). */
function sameOrigin(request: Request, url: URL): boolean {
  return request.headers.get("origin") === url.origin;
}

async function body(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) return null;
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The RPC endpoints shown to users: apps/networks.ts (CONFIG KV, re-read at most once a minute; else the bundled file). */
async function endpoints(env: Env) {
  return (await networks(env.CONFIG)).map((n) => ({ chain_id: n.chain_id, name: n.name, url: n.url, testnet: n.testnet }));
}

// ---- compliance

interface Standing {
  terms_version: string | null;
  terms_accepted_at: number | null;
  suspended_at: number | null;
  billing: string | null;
}

async function standing(env: Env, address: string): Promise<Standing | null> {
  return env.DB.prepare("SELECT terms_version, terms_accepted_at, suspended_at, billing FROM accounts WHERE address = ?").bind(address).first<Standing>();
}

const SANCTIONED_ERROR = "this wallet cannot use nullrpc: it failed sanctions screening (see the Terms of Service)";
const PLACE_ERROR = "nullrpc is not available in your country or region";
const unavailable = () => fail(451, PLACE_ERROR);

/**
 * Screens `address` with the sanctions oracle and records the result: a listed address is
 * suspended (its keys stop working).
 */
async function screen(env: Env, address: string, now: number): Promise<Screening> {
  const result = await screenAddress(ETH_RPC_URL, address);
  if (result === "sanctioned") {
    await ensureAccount(env.DB, address, now);
    await env.DB.prepare("UPDATE accounts SET screened_at = ?, suspended_at = COALESCE(suspended_at, ?), suspended_reason = 'sanctions' WHERE address = ?")
      .bind(now, now, address)
      .run();
    console.warn("sanctions: address suspended", address);
  } else if (result === "clear") {
    await env.DB.prepare("UPDATE accounts SET screened_at = ? WHERE address = ?").bind(now, address).run();
  }
  return result;
}

function parseJson<T>(text: string | null): T | null {
  try {
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

// ---- views

async function accountView(env: Env, address: string, now: number) {
  const account = await ensureAccount(env.DB, address, now);
  const p = plan(account.plan);
  // Throughput: requests recorded this hour (RPC Workers flush every 30 s) over the seconds elapsed.
  const hour = Math.floor(now / 3_600_000);
  const thisHour = await env.DB.prepare("SELECT COALESCE(SUM(requests), 0) AS requests FROM usage WHERE address = ? AND hour = ?")
    .bind(address, hour)
    .first<{ requests: number }>();
  const elapsedS = Math.max(60, (now - hour * 3_600_000) / 1000);
  return {
    address: getAddress(address),
    plan: { id: p.id, name: p.name, included_credits: p.included, rps: p.rps, overage_usd_per_million_credits: p.overageNano === null ? null : p.overageNano / 1000 },
    paid_until: account.paid_until || null,
    period: { start: account.period_start, end: account.period_end, credits: account.period_units },
    balance_usd: account.balance_nano / 1e9,
    exhausted: exhausted(account),
    // Free-plan gate (src/gate.ts): why an `unverified` account has no free credits.
    wallet: walletView(await env.DB.prepare("SELECT wallet_check, wallet_checked_at FROM accounts WHERE address = ?").bind(address).first()),
    throughput: { requests: thisHour?.requests ?? 0, seconds: Math.round(elapsedS), rps: (thisHour?.requests ?? 0) / elapsedS },
  };
}

async function legalView(env: Env, address: string) {
  const s = await standing(env, address);
  return {
    terms: { version: TERMS_VERSION, url: TERMS_URL, privacy_url: PRIVACY_URL, accepted: s?.terms_version === TERMS_VERSION, accepted_at: s?.terms_accepted_at ?? null },
    billing: parseJson<Billing>(s?.billing ?? null),
  };
}

async function keysView(env: Env, address: string) {
  const rows = await env.DB.prepare("SELECT id, name, created_at, revoked_at FROM api_keys WHERE address = ? ORDER BY created_at")
    .bind(address)
    .all<{ id: string; name: string; created_at: number; revoked_at: number | null }>();
  return Promise.all(
    rows.results.map(async (r) => ({ ...r, key: r.revoked_at === null ? await deriveKey(env.KEY_SECRET, r.id) : null })),
  );
}

function invoiceView(invoice: Invoice, env: Env, now = Date.now()) {
  const network = NETWORKS.find((n) => n.chainId === invoice.chain_id);
  const buyer = parseJson<Billing & { ip_country?: string }>(invoice.buyer);
  // Invoices created before billing details existed have no buyer and no withdrawal.
  const right = buyer ? withdrawalFor(buyer) : null;
  const day = 24 * 3600 * 1000;
  const deadline = right && invoice.paid_at ? invoice.paid_at + right.days * day : null;
  const fullUntil = right?.full_days && invoice.paid_at ? invoice.paid_at + right.full_days * day : null;
  return {
    number: invoice.number,
    subtotal_usd: (invoice.subtotal_cents ?? invoice.usd_cents) / 100,
    tax_usd: invoice.tax_cents / 100,
    tax: parseJson<Tax>(invoice.tax),
    buyer,
    consent: invoice.consent,
    withdrawal: right
      ? {
          days: right.days,
          deadline,
          // Until this time the refund is the whole payment; after it, the unused share.
          full_refund_until: fullUntil,
          prorata: !(fullUntil !== null && now < fullUntil),
          withdrawn_at: invoice.withdrawn_at,
          refund_usd: invoice.refund_cents === null ? null : invoice.refund_cents / 100,
          refund_tx: invoice.refund_tx,
          available: invoice.status === "paid" && invoice.withdrawn_at === null && deadline !== null && now < deadline,
        }
      : null,
    id: invoice.id,
    kind: invoice.kind,
    plan: invoice.plan,
    months: invoice.months,
    usd: invoice.usd_cents / 100,
    chain_id: invoice.chain_id,
    network: network?.name ?? String(invoice.chain_id),
    asset: invoice.asset,
    amount: invoice.amount,
    created_at: invoice.created_at,
    expires_at: invoice.expires_at,
    status: invoice.status,
    tx_hash: invoice.tx_hash,
    paid_at: invoice.paid_at,
    note: invoice.note,
    explorer: network?.explorer && invoice.tx_hash ? `${network.explorer.replace(/\/$/, "")}/tx/${invoice.tx_hash}` : null,
    tx: invoice.status === "open" && network ? txRequest(invoice, network, TREASURY_ADDRESS) : null,
  };
}

async function loadInvoice(env: Env, id: string, address?: string): Promise<Invoice | null> {
  const row = await env.DB.prepare("SELECT * FROM invoices WHERE id = ?").bind(id).first<Invoice>();
  if (!row || (address && row.address !== address)) return null;
  return row;
}

/** Verifies a submitted invoice's transaction and credits it when final. */
async function check(env: Env, invoice: Invoice, now: number): Promise<{ status: string; reason?: string }> {
  if (invoice.status !== "pending") return { status: invoice.status };
  const network = NETWORKS.find((n) => n.chainId === invoice.chain_id);
  if (!network) return { status: "pending", reason: "network unavailable" };
  let result;
  try {
    result = await verifyPayment(invoice, network, TREASURY_ADDRESS);
  } catch {
    return { status: "pending", reason: "network RPC unavailable; retrying" };
  }
  if (result.status === "pending") return result;
  if (result.status === "failed") {
    await env.DB.prepare("UPDATE invoices SET status = 'failed', note = ? WHERE id = ? AND status = 'pending'").bind(result.reason, invoice.id).run();
    return result;
  }
  await creditInvoice(env.DB, invoice, now);
  return { status: "paid" };
}

// ---- API

async function api(request: Request, env: Env, url: URL, now: number): Promise<Response> {
  const path = url.pathname;
  const method = request.method;
  // Admin API: bearer token, no cookie, so it is exempt from the same-origin check.
  const admin = await adminApi(request, env, url, now);
  if (admin) return withHeaders(admin);
  if (method !== "GET" && !sameOrigin(request, url)) return fail(403, "cross-origin request refused");

  if (path === "/api/config" && method === "GET") {
    return json({
      plans: publicPlans(),
      recommended: "builder",
      max_keys: MAX_KEYS,
      credits: { default: CREDITS.default, invalid: CREDITS.invalid, methods: CREDITS.methods, ranges: CREDITS.ranges, typical: TYPICAL_CREDITS },
      networks: publicNetworks(NETWORKS),
      endpoints: await endpoints(env),
      treasury: TREASURY_ADDRESS,
      // Sign-in: the Turnstile widget's site key, or null when Turnstile is off.
      turnstile_site_key: turnstileEnabled(env) ? TURNSTILE_SITE_KEY : null,
    });
  }

  if (path === "/api/auth/nonce" && method === "GET") {
    const result = await challenge(env.SESSION_SECRET, url, url.searchParams.get("address") ?? "", now);
    return result ? json(result) : fail(400, "invalid address");
  }

  if (path === "/api/auth/verify" && method === "POST") {
    const input = await body(request);
    if (!input) return fail(400, "JSON body required");
    // Turnstile first, so scripted sign-ins never reach signature or RPC checks.
    if (turnstileEnabled(env)) {
      const human = await verifyTurnstile(env, input.turnstile, request, url.host);
      if (human === "unavailable") return fail(503, "sign-in is temporarily unavailable; try again shortly");
      if (human !== "ok") return fail(403, "the browser check failed; reload the page and try again");
    }
    const result = await verifySignIn(env.SESSION_SECRET, url, input, now, ETH_RPC_URL);
    if ("error" in result) return fail(401, result.error);
    const used = await env.DB.prepare("INSERT OR IGNORE INTO used_nonces (nonce, expires_at) VALUES (?, ?)").bind(result.nonce, result.exp).run();
    if (used.meta.changes !== 1) return fail(401, "sign-in request already used; try again");
    if (sanctionedPlace(request.cf)) return unavailable();
    const screening = await screen(env, result.address, now);
    if (screening === "unavailable") return fail(503, "sign-in is temporarily unavailable; try again shortly");
    if (screening === "sanctioned") return fail(403, SANCTIONED_ERROR);
    // First sign-in: per-network sign-up limit and the free-plan wallet gate (src/gate.ts).
    // Existing accounts always sign in.
    const known = await env.DB.prepare("SELECT 1 AS ok FROM accounts WHERE address = ?").bind(result.address).first();
    if (!known) {
      const admitted = await signUp(env, request, result.address, now);
      if ("error" in admitted) return fail(429, admitted.error);
    }
    await ensureAccount(env.DB, result.address, now);
    if ((await standing(env, result.address))?.suspended_at) return fail(403, "this account is suspended; contact legal@nullrpc.dev");
    const token = await sign(env.SESSION_SECRET, { a: result.address, exp: now + SESSION_MS });
    return json(await accountView(env, result.address, now), 200, { "set-cookie": sessionCookie(token) });
  }

  if (path === "/api/auth/logout" && method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": clearedCookie() });
  }

  const address = await session(request, env, now);
  if (!address) return fail(401, "sign in required");
  const status = await standing(env, address);
  if (status?.suspended_at) return fail(403, "this account is suspended; contact legal@nullrpc.dev");
  const termsAccepted = status?.terms_version === TERMS_VERSION;

  if (path === "/api/me" && method === "GET") {
    return json({ account: await accountView(env, address, now), keys: await keysView(env, address), endpoints: await endpoints(env), ...(await legalView(env, address)) });
  }

  // Free-plan gate: re-check an `unverified` wallet's on-chain history (src/gate.ts).
  if (path === "/api/wallet/check" && method === "POST") {
    const result = await recheck(env, address, now);
    if ("error" in result) return fail(result.status, result.error);
    return json({ check: result.check satisfies WalletCheck, account: await accountView(env, address, now) });
  }

  if (path === "/api/terms" && method === "POST") {
    const input = await body(request);
    if (input?.version !== TERMS_VERSION || input?.accept !== true) return fail(400, `accept the current Terms (version ${TERMS_VERSION})`);
    await ensureAccount(env.DB, address, now);
    await env.DB.prepare("UPDATE accounts SET terms_version = ?, terms_accepted_at = ? WHERE address = ?").bind(TERMS_VERSION, now, address).run();
    return json(await legalView(env, address));
  }

  // Creating keys and payments needs the current Terms accepted.
  if (method === "POST" && (path === "/api/keys" || path === "/api/invoices") && !termsAccepted) {
    return fail(403, "accept the Terms of Service first");
  }

  if (path === "/api/keys" && method === "POST") {
    const input = await body(request);
    const name = typeof input?.name === "string" ? input.name.trim().slice(0, 40) : "";
    if (!name) return fail(400, "name required");
    await ensureAccount(env.DB, address, now);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE address = ? AND revoked_at IS NULL").bind(address).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_KEYS) return fail(400, `at most ${MAX_KEYS} active keys`);
    const id = newKeyId();
    await env.DB.prepare("INSERT INTO api_keys (id, address, name, created_at) VALUES (?, ?, ?, ?)").bind(id, address, name, now).run();
    return json({ keys: await keysView(env, address) }, 201);
  }

  const keyMatch = path.match(/^\/api\/keys\/([0-9a-f]{32})$/);
  if (keyMatch && method === "DELETE") {
    await env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND address = ? AND revoked_at IS NULL").bind(now, keyMatch[1], address).run();
    return json({ keys: await keysView(env, address) });
  }

  if (path === "/api/usage" && method === "GET") {
    const range = url.searchParams.get("range") ?? "24h";
    const hours = { "24h": 24, "7d": 168, "30d": 720 }[range];
    if (!hours) return fail(400, "range must be 24h, 7d or 30d");
    const since = Math.floor(now / 3_600_000) - hours + 1;
    const rows = await env.DB.prepare(
      "SELECT hour, SUM(units) AS units, SUM(requests) AS requests FROM usage WHERE address = ? AND hour >= ? GROUP BY hour ORDER BY hour",
    )
      .bind(address, since)
      .all<{ hour: number; units: number; requests: number }>();
    const byKey = await env.DB.prepare("SELECT key_id, SUM(units) AS units, SUM(requests) AS requests FROM usage WHERE address = ? AND hour >= ? GROUP BY key_id")
      .bind(address, since)
      .all<{ key_id: string; units: number; requests: number }>();
    return json({ range, since_hour: since, series: rows.results, by_key: byKey.results });
  }

  if (path === "/api/invoices" && method === "GET") {
    const rows = await env.DB.prepare("SELECT * FROM invoices WHERE address = ? ORDER BY created_at DESC LIMIT 50").bind(address).all<Invoice>();
    return json({ invoices: rows.results.map((i) => invoiceView(i, env)) });
  }

  if (path === "/api/invoices" && method === "POST") {
    const input = await body(request);
    if (!input) return fail(400, "JSON body required");
    const network = NETWORKS.find((n) => n.chainId === input.chain_id);
    if (!network) return fail(400, "unsupported network");
    // Only USDC is accepted for new payments (ETH invoices created before still verify).
    if (input.asset !== "USDC" || !network.usdc) return fail(400, "only USDC is accepted");
    if (sanctionedPlace(request.cf)) return unavailable();
    const billing = parseBilling(input.billing);
    if (typeof billing === "string") return fail(400, billing);
    const screening = await screen(env, address, now);
    if (screening === "unavailable") return fail(503, "payments are temporarily unavailable; try again shortly");
    if (screening === "sanctioned") return fail(403, SANCTIONED_ERROR);
    const account = await ensureAccount(env.DB, address, now);
    let usdCents: number;
    let planId: string | null = null;
    let months: number | null = null;
    if (input.kind === "plan") {
      planId = String(input.plan ?? "");
      months = Number(input.months);
      const problem = checkPurchase(account, planId, months, now);
      if (problem === "downgrade") return fail(400, "your current plan is higher; it can be extended, not downgraded, while paid");
      if (problem) return fail(400, problem === "months" ? "months must be 1, 6 or 12" : "unknown plan");
      usdCents = priceFor(planId, months);
    } else {
      // Balance top-ups are no longer sold: plans are paid upfront and stop at their quota.
      return fail(400, "kind must be plan");
    }
    // Prices are net; the buyer's tax is added (src/tax.ts). The location evidence kept with
    // the invoice: the declared billing country and the request's country.
    const tax = taxFor(billing);
    const subtotalCents = usdCents;
    const taxed = taxCents(subtotalCents, tax);
    usdCents = subtotalCents + taxed;
    const cf = request.cf as { country?: string } | undefined;
    const buyer = { ...billing, ip_country: typeof cf?.country === "string" ? cf.country : null };
    const asset = "USDC";
    const amount = amountFor(asset, usdCents);
    const id = crypto.randomUUID();
    const expires = now + USDC_INVOICE_MS;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO invoices (id, address, kind, plan, months, usd_cents, chain_id, asset, amount, created_at, expires_at, subtotal_cents, tax_cents, tax, buyer, consent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(id, address, input.kind, planId, months, usdCents, network.chainId, asset, amount.toString(), now, expires, subtotalCents, taxed, JSON.stringify(tax), JSON.stringify(buyer), consentText(billing)),
      env.DB.prepare("UPDATE accounts SET billing = ? WHERE address = ?").bind(JSON.stringify(billing), address),
    ]);
    const invoice = await loadInvoice(env, id);
    return json({ invoice: invoiceView(invoice as Invoice, env) }, 201);
  }

  if (path === "/api/checkout" && method === "POST") {
    // The tax and acknowledgement for billing details, before any invoice exists.
    const input = await body(request);
    const billing = parseBilling(input?.billing);
    if (typeof billing === "string") return fail(400, billing);
    const months = Number(input?.months);
    const planId = String(input?.plan ?? "");
    const tax = taxFor(billing);
    const subtotal = checkPurchase(newAccount(now), planId, months, now) === null ? priceFor(planId, months) : 0;
    const taxed = taxCents(subtotal, tax);
    return json({ tax, subtotal_usd: subtotal / 100, tax_usd: taxed / 100, total_usd: (subtotal + taxed) / 100, statement: consentText(billing), withdrawal: withdrawalFor(billing) });
  }

  const oneMatch = path.match(/^\/api\/invoices\/([0-9a-f-]{36})$/);
  if (oneMatch && method === "GET") {
    const invoice = await loadInvoice(env, oneMatch[1] as string, address);
    if (!invoice) return fail(404, "invoice not found");
    return json({ invoice: { ...invoiceView(invoice, env, now), address: getAddress(invoice.address) }, seller: SELLER });
  }

  const withdrawMatch = path.match(/^\/api\/invoices\/([0-9a-f-]{36})\/withdraw$/);
  if (withdrawMatch && method === "POST") {
    const invoice = await loadInvoice(env, withdrawMatch[1] as string, address);
    if (!invoice) return fail(404, "invoice not found");
    const view = invoiceView(invoice, env, now);
    if (!view.withdrawal?.available) return fail(400, "this payment can no longer be withdrawn");
    const result = await withdrawInvoice(env.DB, invoice, view.withdrawal.prorata, now);
    if (typeof result === "string") {
      return fail(409, result === "not_latest" ? "only your latest plan payment can be withdrawn" : result === "already" ? "already withdrawn" : "this payment cannot be withdrawn");
    }
    console.log("withdrawal", invoice.id, result.refundCents);
    return json({ invoice: invoiceView((await loadInvoice(env, invoice.id)) as Invoice, env, now) });
  }

  // Delete an unpaid payment: only open or expired invoices with no transaction submitted,
  // so a payment in flight (pending) or a paid one is never removed.
  const deleteMatch = path.match(/^\/api\/invoices\/([0-9a-f-]{36})$/);
  if (deleteMatch && method === "DELETE") {
    const r = await env.DB.prepare("DELETE FROM invoices WHERE id = ? AND address = ? AND status IN ('open', 'expired') AND tx_hash IS NULL")
      .bind(deleteMatch[1], address)
      .run();
    if (r.meta.changes !== 1) {
      const invoice = await loadInvoice(env, deleteMatch[1] as string, address);
      return invoice ? fail(409, `a ${invoice.status} payment cannot be deleted`) : fail(404, "invoice not found");
    }
    const rows = await env.DB.prepare("SELECT * FROM invoices WHERE address = ? ORDER BY created_at DESC LIMIT 50").bind(address).all<Invoice>();
    return json({ invoices: rows.results.map((i) => invoiceView(i, env)) });
  }

  const submitMatch = path.match(/^\/api\/invoices\/([0-9a-f-]{36})\/(submit|check)$/);
  if (submitMatch && method === "POST") {
    const invoice = await loadInvoice(env, submitMatch[1] as string, address);
    if (!invoice) return fail(404, "invoice not found");
    if (submitMatch[2] === "submit") {
      const input = await body(request);
      const hash = typeof input?.tx_hash === "string" ? input.tx_hash.toLowerCase() : "";
      if (!/^0x[0-9a-f]{64}$/.test(hash)) return fail(400, "tx_hash required");
      // An expired invoice still accepts its transaction: verification checks that an ETH
      // payment was mined before the quote expired (src/payments.ts).
      if (invoice.status !== "open" && invoice.status !== "expired") return fail(400, `invoice is ${invoice.status}`);
      try {
        const r = await env.DB.prepare("UPDATE invoices SET tx_hash = ?, status = 'pending' WHERE id = ? AND status IN ('open', 'expired')").bind(hash, invoice.id).run();
        if (r.meta.changes !== 1) return fail(409, "invoice already submitted");
      } catch {
        return fail(409, "this transaction was already used for another invoice");
      }
      invoice.tx_hash = hash;
      invoice.status = "pending";
    }
    const result = await check(env, invoice, now);
    const fresh = (await loadInvoice(env, invoice.id)) as Invoice;
    return json({ invoice: invoiceView(fresh, env), reason: result.reason ?? null });
  }

  return fail(404, "not found");
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const now = Date.now();
  if (url.pathname.startsWith("/api/")) {
    try {
      return await api(request, env, url, now);
    } catch (error) {
      console.error("api error", error);
      return fail(500, "internal error");
    }
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return withHeaders(new Response("Method not allowed.\n", { status: 405, headers: { allow: "GET, HEAD", "content-type": "text/plain" } }));
  }
  return withHeaders(await env.ASSETS.fetch(request));
}

/** Every few minutes: verify submitted payments, expire stale invoices, drop used nonces. */
export async function scheduled(env: Env, now: number): Promise<void> {
  const pending = await env.DB.prepare("SELECT * FROM invoices WHERE status = 'pending' ORDER BY created_at LIMIT 50").all<Invoice>();
  for (const invoice of pending.results) await check(env, invoice, now);
  await env.DB.batch([
    env.DB.prepare("UPDATE invoices SET status = 'expired' WHERE status = 'open' AND expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM used_nonces WHERE expires_at < ?").bind(now),
    // Keep the public tier's current and previous month only.
    env.DB.prepare("DELETE FROM public_usage WHERE month < ?").bind(utcMonth(now - 32 * 24 * 3600 * 1000)),
    // Hourly usage per key is kept 13 months (privacy notice, "What we collect").
    env.DB.prepare("DELETE FROM usage WHERE hour < ?").bind(Math.floor((now - USAGE_RETENTION_MS) / 3_600_000)),
  ]);
  // Credit leases (src/leases.ts): release expired reservations, drop old leases and counters.
  await sweepLeases(env.DB, now, 500);
  await pruneLeases(env.DB, now);
  // Sanctions lists change: screen accounts with keys or a paid plan again every day.
  const due = await env.DB.prepare(
    `SELECT address FROM accounts WHERE suspended_at IS NULL AND screened_at < ?
       AND (plan NOT IN ('free', 'internal', 'unverified') OR EXISTS (SELECT 1 FROM api_keys k WHERE k.address = accounts.address AND k.revoked_at IS NULL))
     ORDER BY screened_at LIMIT 25`,
  )
    .bind(now - RESCREEN_MS)
    .all<{ address: string }>();
  for (const { address } of due.results) await screen(env, address, now);
}

/**
 * Internal entrypoint for the RPC Workers (service binding with `entrypoint = "Access"`);
 * not reachable from the internet.
 *   POST /lease {lines:[LeaseLine]} -> {lines:[LeaseGrant]}  (credit leases, src/leases.ts)
 * Legacy, for RPC Workers deployed before leases (kept until all are redeployed):
 *   GET  /entitlement?key=<32 hex> | ?anon=<32 hex> [&v=2]  -> Entitlement
 *   POST /usage {entries:[{key | anon, units, requests}]} -> {statuses: {"key:<id>" | "anon:<id>": status}}
 */
export class Access extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();
    const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    try {
      if (url.pathname === "/entitlement" && request.method === "GET") {
        const anon = url.searchParams.get("anon");
        if (anon !== null) {
          if (!/^[0-9a-f]{32}$/.test(anon)) return reply({ status: "unknown" });
          return reply(await publicEntitlement(this.env.DB, anon, now));
        }
        const key = url.searchParams.get("key") ?? "";
        if (!/^[0-9a-f]{32}$/.test(key)) return reply({ status: "unknown" });
        return reply(await entitlement(this.env.DB, key, now, url.searchParams.get("v") === "2"));
      }
      if (url.pathname === "/lease" && request.method === "POST") {
        const input = (await request.json()) as { lines?: unknown };
        const lines = Array.isArray(input.lines) ? (input.lines as LeaseLine[]).slice(0, 200) : [];
        return reply({ lines: await lease(this.env.DB, lines, now) });
      }
      if (url.pathname === "/usage" && request.method === "POST") {
        const input = (await request.json()) as { entries?: unknown };
        const entries = Array.isArray(input.entries) ? (input.entries as { key?: string; anon?: string; units: number; requests: number }[]).slice(0, 1000) : [];
        return reply({ statuses: await recordUsage(this.env.DB, entries, now) });
      }
      return reply({ error: "not found" }, 404);
    } catch (error) {
      console.error("access error", error);
      return reply({ error: "internal error" }, 500);
    }
  }
}

export default {
  fetch: handle,
  async scheduled(controller, env, ctx) {
    // Daily (00:05 UTC): the anomaly report (src/report.ts); otherwise the 2-minute jobs.
    if (controller.cron === DAILY_CRON) ctx.waitUntil(daily(env, Date.now()).then(() => undefined));
    else ctx.waitUntil(scheduled(env, Date.now()));
  },
} satisfies ExportedHandler<Env>;
