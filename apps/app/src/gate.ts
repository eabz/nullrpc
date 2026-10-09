// Sign-up controls.
//
//   - Turnstile: the sign-in request carries a Cloudflare Turnstile token, checked with
//     siteverify before the signature is verified. Off until TURNSTILE_SITE_KEY below and the
//     TURNSTILE_SECRET secret are both set.
//   - Client networks: at most SIGNUPS_PER_NETWORK new accounts per IPv4 address or IPv6 /64
//     and UTC day. Only a keyed hash of the network is stored, never the address.
//   - Free-plan gate: a new wallet gets the Free plan only with on-chain history on Ethereum
//     mainnet (nonce or balance over the thresholds below), within a daily cap of new free
//     accounts. Otherwise it signs in on the `unverified` plan (no included credits) and can
//     pay for a plan or ask for a re-check.

import { ensureAccount } from "./db";
import { ETH_RPC_URL } from "./payments";
import { PERIOD_MS, utcDay } from "./plans";

export { utcDay };

/** Free-plan gate: a wallet qualifies with at least this many sent transactions… */
export const MIN_NONCE = 5;
/** …or at least this balance (0.005 ETH), on Ethereum mainnet. */
export const MIN_BALANCE_WEI = 5_000_000_000_000_000n;
/** New accounts per client network (IPv4 address or IPv6 /64) and UTC day. */
export const SIGNUPS_PER_NETWORK = 3;
/** New accounts granted the Free plan per UTC day, across all networks (env override). */
export const FREE_SIGNUPS_PER_DAY = 1_000;
/** A wallet's on-demand re-check is allowed once per this interval. */
export const RECHECK_MS = 60 * 1000;

export interface GateEnv {
  DB: D1Database;
  SESSION_SECRET: string;
  /** Secret: the Turnstile widget's secret key. */
  TURNSTILE_SECRET?: string;
}

const enc = new TextEncoder();
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");


// ---- client networks

/** Eight 16-bit groups of an IPv6 address, or null. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase().split("%")[0] ?? "";
  // A trailing dotted IPv4 (::ffff:1.2.3.4) becomes two groups.
  const v4 = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const parts = ipv4(v4[2] as string);
    if (!parts) return null;
    text = `${v4[1]}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s ? s.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) : []);
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const groups = [...head, ...new Array(halves.length === 2 ? fill : 0).fill(0), ...tail];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}

function ipv4(ip: string): number[] | null {
  const parts = ip.split(".").map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return parts.length === 4 && parts.every((p) => p >= 0 && p <= 255) ? parts : null;
}

/** The client network of an IP address: the IPv4 address, or the IPv6 /64 prefix. */
export function clientNetwork(ip: string): string | null {
  const v4 = ipv4(ip.trim());
  if (v4) return v4.join(".");
  const v6 = ipv6Groups(ip.trim());
  if (!v6) return null;
  // IPv4-mapped addresses (::ffff:a.b.c.d) are the IPv4 client.
  if (v6.slice(0, 5).every((g) => g === 0) && v6[5] === 0xffff) {
    return [v6[6]! >> 8, v6[6]! & 255, v6[7]! >> 8, v6[7]! & 255].join(".");
  }
  return v6.slice(0, 4).map((g) => g.toString(16)).join(":") + "::/64";
}

/**
 * A keyed hash (32 hex) of the request's client network, or null when the request has no
 * client address (only outside Cloudflare, e.g. in tests). The address itself is not kept.
 */
export async function networkId(secret: string, request: Request): Promise<string | null> {
  const ip = request.headers.get("cf-connecting-ip");
  const net = ip ? clientNetwork(ip) : null;
  if (!net) return null;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode("nullrpc-signup-net-v1\n" + net))).slice(0, 32);
}

// ---- Turnstile

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_ACTION = "signin";
/** The Turnstile widget's public site key; empty keeps Turnstile off. */
export const TURNSTILE_SITE_KEY = "";

export function turnstileEnabled(env: GateEnv): boolean {
  return Boolean(TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET);
}

/** Checks a Turnstile token with siteverify (single use; bound to the app's hostname). */
export async function verifyTurnstile(env: GateEnv, token: unknown, request: Request, host: string): Promise<"ok" | "invalid" | "unavailable"> {
  if (typeof token !== "string" || !token || token.length > 4096) return "invalid";
  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET ?? "");
  form.set("response", token);
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) form.set("remoteip", ip);
  let result: { success?: boolean; hostname?: string; action?: string };
  try {
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body: form, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return "unavailable";
    result = await res.json();
  } catch {
    return "unavailable";
  }
  if (result.success !== true) return "invalid";
  if (result.hostname && result.hostname !== host) return "invalid";
  if (result.action && result.action !== TURNSTILE_ACTION) return "invalid";
  return "ok";
}

// ---- wallet activity

export interface Activity {
  nonce: number;
  balanceWei: bigint;
}

async function rpc(url: string, method: string, params: unknown[]): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown };
  if (typeof body.result !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.result)) throw new Error("bad result");
  return body.result;
}

/**
 * The wallet's nonce and balance on Ethereum mainnet (EOAs and contract wallets alike), from
 * the first RPC that answers; null when none does.
 */
export async function walletActivity(urls: string[], address: string): Promise<Activity | null> {
  for (const url of urls) {
    try {
      const [nonce, balance] = await Promise.all([rpc(url, "eth_getTransactionCount", [address, "latest"]), rpc(url, "eth_getBalance", [address, "latest"])]);
      return { nonce: Number(BigInt(nonce)), balanceWei: BigInt(balance) };
    } catch {
      // next RPC
    }
  }
  return null;
}

export function qualifies(a: Activity): boolean {
  return a.nonce >= MIN_NONCE || a.balanceWei >= MIN_BALANCE_WEI;
}


export type WalletCheck = "passed" | "failed" | "pending" | "capped";

interface CheckResult {
  check: Exclude<WalletCheck, "capped">;
  activity: Activity | null;
}

/** Runs the gate's on-chain check. */
async function checkWallet(address: string): Promise<CheckResult> {
  const activity = await walletActivity([ETH_RPC_URL], address);
  if (!activity) return { check: "pending", activity: null };
  return { check: qualifies(activity) ? "passed" : "failed", activity };
}

/** Takes one of the day's free-plan slots; false when the day's cap is reached. */
async function reserveFree(env: GateEnv, day: number, net: string | null): Promise<boolean> {
  const cap = FREE_SIGNUPS_PER_DAY;
  if (cap <= 0) return false;
  const r = await env.DB.prepare(
    "INSERT INTO signup_days (day, net, accounts, free) VALUES (?, '', 0, 1) ON CONFLICT (day, net) DO UPDATE SET free = free + 1 WHERE free < ?",
  )
    .bind(day, cap)
    .run();
  if (r.meta.changes !== 1) return false;
  if (net) await env.DB.prepare("UPDATE signup_days SET free = free + 1 WHERE day = ? AND net = ?").bind(day, net).run();
  return true;
}

// ---- sign-up

export const NETWORK_LIMIT_ERROR = "too many new accounts from your network today; try again tomorrow, or sign in with an existing account";

/**
 * Creates the account of a wallet signing in for the first time: the client network's daily
 * limit, then the free-plan gate. Returns an error message when the sign-up is refused.
 */
export async function signUp(env: GateEnv, request: Request, address: string, now: number): Promise<{ check: WalletCheck } | { error: string }> {
  const day = utcDay(now);
  const net = await networkId(env.SESSION_SECRET, request);
  if (net) {
    const perNet = SIGNUPS_PER_NETWORK;
    if (perNet <= 0) return { error: NETWORK_LIMIT_ERROR };
    const r = await env.DB.prepare(
      "INSERT INTO signup_days (day, net, accounts, free) VALUES (?, ?, 1, 0) ON CONFLICT (day, net) DO UPDATE SET accounts = accounts + 1 WHERE accounts < ?",
    )
      .bind(day, net, perNet)
      .run();
    if (r.meta.changes !== 1) return { error: NETWORK_LIMIT_ERROR };
  }
  await env.DB.prepare("INSERT INTO signup_days (day, net, accounts, free) VALUES (?, '', 1, 0) ON CONFLICT (day, net) DO UPDATE SET accounts = accounts + 1")
    .bind(day)
    .run();
  const result = await checkWallet(address);
  let check: WalletCheck = result.check;
  if (check === "passed" && !(await reserveFree(env, day, net))) check = "capped";
  await ensureAccount(env.DB, address, now);
  await env.DB.prepare(
    "UPDATE accounts SET plan = ?, wallet_check = ?, wallet_checked_at = ?, wallet_nonce = ?, wallet_balance_wei = ?, signup_net = ? WHERE address = ? AND plan = 'free'",
  )
    .bind(
      check === "passed" ? "free" : "unverified",
      check,
      now,
      result.activity?.nonce ?? null,
      result.activity ? result.activity.balanceWei.toString() : null,
      net,
      address,
    )
    .run();
  return { check };
}

export interface WalletState {
  plan: string;
  wallet_check: WalletCheck | null;
  wallet_checked_at: number | null;
}

/**
 * Re-checks an `unverified` account's wallet on demand: when it now qualifies (and the day's
 * free cap allows), the account moves to Free with a fresh period.
 */
export async function recheck(env: GateEnv, address: string, now: number): Promise<{ check: WalletCheck } | { error: string; status: number }> {
  const row = await env.DB.prepare("SELECT plan, wallet_check, wallet_checked_at FROM accounts WHERE address = ?").bind(address).first<WalletState>();
  if (!row) return { error: "account not found", status: 404 };
  if (row.plan !== "unverified") return { check: row.wallet_check ?? "passed" };
  if (row.wallet_checked_at && now - row.wallet_checked_at < RECHECK_MS) return { error: "checked a moment ago; try again in a minute", status: 429 };
  const result = await checkWallet(address);
  let check: WalletCheck = result.check;
  if (check === "passed" && !(await reserveFree(env, utcDay(now), null))) check = "capped";
  const free = check === "passed";
  await env.DB.prepare(
    `UPDATE accounts SET wallet_check = ?, wallet_checked_at = ?, wallet_nonce = COALESCE(?, wallet_nonce), wallet_balance_wei = COALESCE(?, wallet_balance_wei)
       ${free ? ", plan = 'free', period_start = ?, period_end = ?, period_units = 0" : ""}
     WHERE address = ? AND plan = 'unverified'`,
  )
    .bind(
      check,
      now,
      result.activity?.nonce ?? null,
      result.activity ? result.activity.balanceWei.toString() : null,
      ...(free ? [now, now + PERIOD_MS] : []),
      address,
    )
    .run();
  return { check };
}

/** What the app shows about the free-plan gate (GET /api/me `account.wallet`). */
export function walletView(row: { wallet_check: string | null; wallet_checked_at: number | null } | null) {
  return { check: row?.wallet_check ?? null, checked_at: row?.wallet_checked_at ?? null, min_nonce: MIN_NONCE, min_balance_eth: Number(MIN_BALANCE_WEI) / 1e18 };
}
