// Manual refunds. A withdrawal leaves a refund
// owed on its invoice; the treasury is a hardware wallet, so an admin sends each refund by hand
// (admin page /admin, "Send with wallet" or Trezor Suite) and records the transaction here.
// A recorded transaction must have succeeded and moved at least the refund in USDC to the
// buyer's wallet; each transaction settles one refund.
//
//   GET  /api/admin/refunds[?status=pending|sent|all]  refunds, oldest due first
//   POST /api/admin/refunds/:invoice {tx_hash}          verify and record a sent refund

import { createPublicClient, decodeEventLog, encodeFunctionData, erc20Abi, getAddress, http, type Hex, type PublicClient } from "viem";
import { NETWORKS, type Network } from "./payments";

/** Refunds are due this long after the withdrawal (Directive 2011/83/EU art. 13). */
export const REFUND_DUE_MS = 14 * 24 * 3600 * 1000;

export interface RefundEnv {
  DB: D1Database;
}

interface Row {
  id: string;
  number: string | null;
  address: string;
  plan: string | null;
  months: number | null;
  usd_cents: number;
  chain_id: number;
  buyer: string | null;
  paid_at: number | null;
  withdrawn_at: number;
  refund_cents: number;
  refund_tx: string | null;
  refunded_at: number | null;
}

/** USDC base units of a refund in cents (USDC has 6 decimals). */
export const refundUnits = (cents: number) => BigInt(cents) * 10_000n;

function view(row: Row, networks: Network[], now: number) {
  const network = networks.find((n) => n.chainId === row.chain_id);
  const buyer = (() => {
    try {
      return row.buyer ? (JSON.parse(row.buyer) as { name?: string; country?: string; business?: boolean }) : null;
    } catch {
      return null;
    }
  })();
  const due = row.withdrawn_at + REFUND_DUE_MS;
  const units = refundUnits(row.refund_cents);
  const explorer = network?.explorer?.replace(/\/$/, "");
  return {
    invoice: row.id,
    number: row.number,
    address: getAddress(row.address),
    customer: buyer ? { name: buyer.name ?? null, country: buyer.country ?? null, business: buyer.business === true } : null,
    plan: row.plan,
    months: row.months,
    paid_usd: row.usd_cents / 100,
    paid_at: row.paid_at,
    withdrawn_at: row.withdrawn_at,
    refund_usd: row.refund_cents / 100,
    refund_usdc_units: units.toString(),
    due_at: due,
    overdue: row.refund_tx === null && now > due,
    status: row.refund_tx ? "sent" : row.refund_cents > 0 ? "pending" : "nothing_owed",
    refund_tx: row.refund_tx,
    refunded_at: row.refunded_at,
    network: network?.name ?? String(row.chain_id),
    tx_url: explorer && row.refund_tx ? `${explorer}/tx/${row.refund_tx}` : null,
    // The wallet transaction for "Send with wallet": transfer(buyer, amount) on USDC.
    tx:
      !row.refund_tx && row.refund_cents > 0 && network?.usdc
        ? {
            chainId: `0x${network.chainId.toString(16)}`,
            to: getAddress(network.usdc),
            value: "0x0",
            data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [getAddress(row.address), units] }),
          }
        : null,
  };
}

export async function listRefunds(env: RefundEnv, status: string, now: number) {
  const where = status === "sent" ? "AND refund_tx IS NOT NULL" : status === "all" ? "" : "AND refund_tx IS NULL AND refund_cents > 0";
  const rows = await env.DB.prepare(
    `SELECT id, number, address, plan, months, usd_cents, chain_id, buyer, paid_at, withdrawn_at, refund_cents, refund_tx, refunded_at
       FROM invoices WHERE withdrawn_at IS NOT NULL ${where} ORDER BY withdrawn_at LIMIT 500`,
  ).all<Row>();
  const networks = NETWORKS;
  const refunds = rows.results.map((r) => view(r, networks, now));
  const pending = refunds.filter((r) => r.status === "pending");
  return {
    refunds,
    pending: { count: pending.length, usd: pending.reduce((a, r) => a + r.refund_usd, 0), overdue: pending.filter((r) => r.overdue).length },
  };
}

export type RefundCheck = { ok: true; block: number; from: string } | { ok: false; status: number; reason: string };

/** Checks that `hash` succeeded and moved at least `units` USDC to `to` on `network`. */
export async function verifyRefund(hash: Hex, to: string, units: bigint, network: Network, rpc?: PublicClient): Promise<RefundCheck> {
  if (!network.usdc) return { ok: false, status: 400, reason: "no USDC contract on this network" };
  const c = rpc ?? createPublicClient({ transport: http(network.rpc, { timeout: 15_000, retryCount: 1 }) });
  let receipt;
  try {
    receipt = await c.getTransactionReceipt({ hash });
  } catch {
    return { ok: false, status: 409, reason: "transaction not found or not mined yet; record it again in a minute" };
  }
  if (receipt.status !== "success") return { ok: false, status: 400, reason: "the transaction reverted" };
  const usdc = network.usdc.toLowerCase();
  const buyer = to.toLowerCase();
  let sent = 0n;
  let from = "";
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdc) continue;
    try {
      const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
      if (event.eventName === "Transfer" && event.args.to.toLowerCase() === buyer) {
        sent += event.args.value;
        from = event.args.from;
      }
    } catch {
      // not a Transfer
    }
  }
  if (sent === 0n) return { ok: false, status: 400, reason: "no USDC transfer to the customer's wallet in this transaction" };
  if (sent < units) return { ok: false, status: 400, reason: `the transfer (${sent} units) is less than the refund (${units} units)` };
  return { ok: true, block: Number(receipt.blockNumber), from };
}

/** Records a verified refund transaction on its invoice; false if already recorded. */
export async function recordRefund(db: D1Database, invoice: string, hash: string, now: number): Promise<boolean> {
  const r = await db
    .prepare("UPDATE invoices SET refund_tx = ?, refunded_at = ? WHERE id = ? AND withdrawn_at IS NOT NULL AND refund_tx IS NULL")
    .bind(hash, now, invoice)
    .run();
  return r.meta.changes === 1;
}

/** The refunds part of the admin API (already authorized), or null for other paths. */
export async function refundsApi(request: Request, env: RefundEnv, url: URL, now: number, verify = verifyRefund): Promise<Response | null> {
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  const path = url.pathname;
  if (path === "/api/admin/refunds" && request.method === "GET") {
    return reply(await listRefunds(env, url.searchParams.get("status") ?? "pending", now));
  }
  const match = path.match(/^\/api\/admin\/refunds\/([0-9a-f-]{36})$/);
  if (!match || request.method !== "POST") return null;
  let input: { tx_hash?: unknown; note?: unknown };
  try {
    input = (await request.json()) as typeof input;
  } catch {
    return reply({ error: "JSON body required" }, 400);
  }
  const hash = typeof input.tx_hash === "string" ? input.tx_hash.trim().toLowerCase() : "";
  if (!/^0x[0-9a-f]{64}$/.test(hash)) return reply({ error: "tx_hash required" }, 400);
  const row = await env.DB.prepare(
    "SELECT id, number, address, plan, months, usd_cents, chain_id, buyer, paid_at, withdrawn_at, refund_cents, refund_tx, refunded_at FROM invoices WHERE id = ? AND withdrawn_at IS NOT NULL",
  )
    .bind(match[1])
    .first<Row>();
  if (!row) return reply({ error: "no withdrawal for this invoice" }, 404);
  if (row.refund_tx) return reply({ error: `already refunded in ${row.refund_tx}` }, 409);
  if (row.refund_cents <= 0) return reply({ error: "nothing is owed for this withdrawal" }, 400);
  const used = await env.DB.prepare("SELECT id FROM invoices WHERE refund_tx = ?").bind(hash).first<{ id: string }>();
  if (used) return reply({ error: `this transaction already settled the refund of invoice ${used.id}` }, 409);
  const network = NETWORKS.find((n) => n.chainId === row.chain_id);
  if (!network) return reply({ error: "the invoice's network is not configured" }, 500);
  const check = await verify(hash as Hex, row.address, refundUnits(row.refund_cents), network);
  if (!check.ok) return reply({ error: check.reason }, check.status);
  if (!(await recordRefund(env.DB, row.id, hash, now))) return reply({ error: "already refunded" }, 409);
  const note = typeof input.note === "string" ? input.note.slice(0, 500) : null;
  await env.DB.prepare("INSERT INTO admin_log (at, target, action, note) VALUES (?, ?, ?, ?)")
    .bind(now, `account:${row.address}`, JSON.stringify({ refund: row.id, tx: hash, usd: row.refund_cents / 100, from: check.from }), note)
    .run();
  const fresh = await env.DB.prepare(
    "SELECT id, number, address, plan, months, usd_cents, chain_id, buyer, paid_at, withdrawn_at, refund_cents, refund_tx, refunded_at FROM invoices WHERE id = ?",
  )
    .bind(row.id)
    .first<Row>();
  return reply({ refund: view(fresh as Row, NETWORKS, now) });
}
