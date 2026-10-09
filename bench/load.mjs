#!/usr/bin/env node
// Load benchmark and stress test for a nullrpc endpoint. Builds a realistic workload from the
// chain itself (recent and archive blocks, their transactions and addresses), then runs a
// weighted mix of methods from `--concurrency` workers for `--duration` seconds and reports
// per-method latency percentiles, throughput and errors. `--stress` instead ramps concurrency
// stage by stage until the endpoint degrades, and reports the last healthy stage.
//
//   node bench/load.mjs [--chain 560048] [--url https://…] [--key nr_…]
//                       [--duration 30] [--concurrency 8] [--rps 0] [--mix read|blocks|state|exec|logs]
//                       [--batch 0] [--seed 1] [--json out.json]
//   node bench/load.mjs --stress [--stages 1,2,4,8,16,32,64] [--stage-seconds 15] [--max-p99 2000] [--max-errors 2]
//
// Keyless clients are limited to 10 requests/s with a burst of 20 per client network, so a
// meaningful run needs a key (NULLRPC_KEY or --key) on a plan that allows the target rate.

import { writeFileSync } from "node:fs";
import { batch, endpoint, fmtMs, hex, limiter, num, parseArgs, percentile, rng, rpc, table, target } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const t = target(args);
const URL = endpoint(t.url, t.key);
const random = rng(Number(args.seed ?? 1));
const DURATION = Number(args.duration ?? 30);
const BATCH = Number(args.batch ?? 0);
const log = (...x) => console.log(...x);

async function must(method, params) {
  const r = await rpc(URL, method, params);
  if (!r.ok) throw new Error(`${method}: ${r.error.code} ${r.error.message} (http ${r.http})`);
  return r.result;
}
const pick = (arr) => arr[Math.floor(random() * arr.length)];
const between = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));

// ---- workload data, from the target itself

log(`target ${t.url}${t.key ? " (with key)" : " (keyless: 10 rps, burst 20)"}`);
const head = num(await must("eth_blockNumber", []));
const status = await fetch(`${t.url.replace(/\/$/, "")}/status.json`).then((r) => r.json()).catch(() => null);
const P = status?.archived_through ?? Math.max(0, head - 300);
log(`head ${head}, archived through ${P}, live window ${head - P} blocks`);

const seedBlocks = [...new Set([head - 1, head - 3, between(P + 1, head - 1), between(1, P), between(1, P), between(1, P), between(1, P), between(Math.max(1, P - 50_000), P)])].filter((n) => n > 0);
const txs = [];
const addrs = new Set();
const contracts = new Set();
const hashes = [];
for (const n of seedBlocks) {
  const b = await must("eth_getBlockByNumber", [hex(n), true]);
  if (!b) continue;
  hashes.push(b.hash);
  for (const tx of b.transactions.slice(0, 20)) {
    txs.push({ hash: tx.hash, block: n, from: tx.from, to: tx.to, input: tx.input, value: tx.value, gas: tx.gas });
    addrs.add(tx.from);
    if (tx.to) {
      addrs.add(tx.to);
      if (tx.input && tx.input.length > 10) contracts.add(tx.to);
    }
  }
}
if (!txs.length) throw new Error("no transactions found in the seed blocks; try another --seed");
const A = [...addrs];
const C = [...contracts];
const CALLS = txs.filter((tx) => tx.to && tx.input && tx.input !== "0x");
log(`workload: ${txs.length} transactions, ${A.length} addresses, ${C.length} contracts from blocks ${seedBlocks.join(" ")}`);

// ---- the mix

const OPS = {
  eth_blockNumber: () => ["eth_blockNumber", []],
  "eth_getBlockByNumber latest": () => ["eth_getBlockByNumber", ["latest", false]],
  "eth_getBlockByNumber live full": () => ["eth_getBlockByNumber", [hex(between(P + 1, head)), true]],
  "eth_getBlockByNumber archive full": () => ["eth_getBlockByNumber", [hex(between(1, P)), true]],
  eth_getBlockByHash: () => ["eth_getBlockByHash", [pick(hashes), false]],
  eth_getTransactionByHash: () => ["eth_getTransactionByHash", [pick(txs).hash]],
  eth_getTransactionReceipt: () => ["eth_getTransactionReceipt", [pick(txs).hash]],
  eth_getBlockReceipts: () => ["eth_getBlockReceipts", [hex(pick(seedBlocks))]],
  "eth_getBalance latest": () => ["eth_getBalance", [pick(A), "latest"]],
  "eth_getBalance archive": () => ["eth_getBalance", [pick(A), hex(between(1, P))]],
  eth_getTransactionCount: () => ["eth_getTransactionCount", [pick(A), "latest"]],
  eth_getCode: () => ["eth_getCode", [pick(C.length ? C : A), "latest"]],
  eth_getStorageAt: () => ["eth_getStorageAt", [pick(C.length ? C : A), "0x0", "latest"]],
  "eth_getLogs 10 blocks": () => {
    const n = between(1, head - 10);
    return ["eth_getLogs", [{ fromBlock: hex(n), toBlock: hex(n + 9) }]];
  },
  "eth_getLogs 100 blocks": () => {
    const n = between(1, head - 100);
    return ["eth_getLogs", [{ fromBlock: hex(n), toBlock: hex(n + 99) }]];
  },
  eth_call: () => {
    const tx = pick(CALLS.length ? CALLS : txs);
    return ["eth_call", [{ from: tx.from, to: tx.to ?? tx.from, data: tx.input, value: tx.value }, "latest"]];
  },
  "eth_call archive": () => {
    const tx = pick(CALLS.length ? CALLS : txs);
    return ["eth_call", [{ from: tx.from, to: tx.to ?? tx.from, data: tx.input, value: tx.value }, hex(tx.block - 1)]];
  },
  eth_estimateGas: () => {
    const tx = pick(CALLS.length ? CALLS : txs);
    return ["eth_estimateGas", [{ from: tx.from, to: tx.to ?? tx.from, data: tx.input, value: tx.value }, "latest"]];
  },
  eth_feeHistory: () => ["eth_feeHistory", ["0xa", "latest", [25, 75]]],
  eth_gasPrice: () => ["eth_gasPrice", []],
  eth_chainId: () => ["eth_chainId", []],
};

const MIXES = {
  // Roughly what a wallet- and indexer-heavy public endpoint sees.
  read: {
    eth_blockNumber: 12, "eth_getBlockByNumber latest": 8, "eth_getBlockByNumber live full": 4, "eth_getBlockByNumber archive full": 6, eth_getBlockByHash: 2,
    eth_getTransactionByHash: 8, eth_getTransactionReceipt: 14, eth_getBlockReceipts: 2,
    "eth_getBalance latest": 10, "eth_getBalance archive": 2, eth_getTransactionCount: 4, eth_getCode: 3, eth_getStorageAt: 2,
    "eth_getLogs 10 blocks": 4, "eth_getLogs 100 blocks": 1,
    eth_call: 10, "eth_call archive": 2, eth_estimateGas: 2, eth_feeHistory: 2, eth_gasPrice: 4, eth_chainId: 2,
  },
  blocks: { "eth_getBlockByNumber latest": 3, "eth_getBlockByNumber live full": 3, "eth_getBlockByNumber archive full": 6, eth_getBlockByHash: 2, eth_getBlockReceipts: 3, eth_getTransactionReceipt: 3 },
  state: { "eth_getBalance latest": 4, "eth_getBalance archive": 4, eth_getTransactionCount: 2, eth_getCode: 2, eth_getStorageAt: 2 },
  exec: { eth_call: 5, "eth_call archive": 3, eth_estimateGas: 2 },
  logs: { "eth_getLogs 10 blocks": 3, "eth_getLogs 100 blocks": 1 },
};
const mix = MIXES[args.mix ?? "read"];
if (!mix) throw new Error(`unknown mix; one of ${Object.keys(MIXES).join(", ")}`);
const weighted = Object.entries(mix).flatMap(([op, w]) => Array(w).fill(op));

// ---- one stage

async function stage(concurrency, seconds, rps) {
  const pace = limiter(rps);
  const samples = []; // {op, ms, ok, code, http}
  const end = performance.now() + seconds * 1000;
  let inFlight = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (performance.now() < end) {
      await pace();
      inFlight++;
      if (BATCH > 1) {
        const ops = Array.from({ length: BATCH }, () => pick(weighted));
        const rs = await batch(URL, ops.map((op) => OPS[op]()));
        rs.forEach((r, i) => samples.push({ op: ops[i], ms: r.ms, ok: r.ok, code: r.error?.code, http: r.http, batch: true }));
      } else {
        const op = pick(weighted);
        const [method, params] = OPS[op]();
        const r = await rpc(URL, method, params);
        samples.push({ op, ms: r.ms, ok: r.ok, code: r.error?.code, http: r.http, message: r.error?.message });
      }
      inFlight--;
    }
  });
  const t0 = performance.now();
  await Promise.all(workers);
  const wall = (performance.now() - t0) / 1000;
  return summarize(samples, wall, concurrency);
}

const isRefusal = (s) => s.code === 3 || /reverted|insufficient funds|more than \d+ logs|narrow the range|intrinsic gas|nonce too low/i.test(s.message ?? "");

function summarize(samples, wall, concurrency) {
  const all = samples.map((s) => s.ms).sort((a, b) => a - b);
  const ok = samples.filter((s) => s.ok).length;
  const limited = samples.filter((s) => s.http === 429).length;
  // Refusals are correct answers to the request (a revert, an unfunded sender, a range the
  // endpoint will not serve), not failures of the endpoint.
  const refused = samples.filter((s) => !s.ok && s.http !== 429 && isRefusal(s)).length;
  const errors = samples.filter((s) => !s.ok && s.http !== 429 && !isRefusal(s));
  const perOp = {};
  for (const s of samples) {
    const o = (perOp[s.op] ??= { n: 0, ok: 0, limited: 0, refused: 0, err: 0, ms: [] });
    o.n++;
    if (s.ok) o.ok++;
    else if (s.http === 429) o.limited++;
    else if (isRefusal(s)) o.refused++;
    else o.err++;
    o.ms.push(s.ms);
  }
  for (const o of Object.values(perOp)) o.ms.sort((a, b) => a - b);
  const errorKinds = {};
  for (const e of errors) errorKinds[`${e.http} ${e.code} ${(e.message ?? "").slice(0, 60)}`] = (errorKinds[`${e.http} ${e.code} ${(e.message ?? "").slice(0, 60)}`] ?? 0) + 1;
  const requests = BATCH > 1 ? Math.ceil(samples.length / BATCH) : samples.length;
  return {
    concurrency,
    wall,
    calls: samples.length,
    requests,
    rps: requests / wall,
    ok,
    limited,
    refused,
    errors: errors.length,
    errorRate: samples.length ? (errors.length / samples.length) * 100 : 0,
    p50: percentile(all, 50),
    p90: percentile(all, 90),
    p99: percentile(all, 99),
    max: all[all.length - 1] ?? null,
    perOp,
    errorKinds,
  };
}

function printStage(r, title) {
  log(`\n${title}: ${r.calls} calls in ${r.wall.toFixed(1)}s = ${r.rps.toFixed(1)} req/s at concurrency ${r.concurrency}; ok ${r.ok}, refused ${r.refused}, rate-limited ${r.limited}, errors ${r.errors} (${r.errorRate.toFixed(2)}%); p50 ${fmtMs(r.p50)} p90 ${fmtMs(r.p90)} p99 ${fmtMs(r.p99)} max ${fmtMs(r.max)}`);
  const rows = [["method", "n", "ok", "refused", "429", "err", "p50", "p90", "p99", "max"]];
  for (const [op, o] of Object.entries(r.perOp).sort((a, b) => b[1].n - a[1].n)) rows.push([op, o.n, o.ok, o.refused, o.limited, o.err, fmtMs(percentile(o.ms, 50)), fmtMs(percentile(o.ms, 90)), fmtMs(percentile(o.ms, 99)), fmtMs(o.ms[o.ms.length - 1])]);
  log(table(rows));
  const kinds = Object.entries(r.errorKinds);
  if (kinds.length) {
    log("errors:");
    for (const [k, n] of kinds.sort((a, b) => b[1] - a[1]).slice(0, 10)) log(`  ${n}× ${k}`);
  }
}

// ---- run

const out = { target: t, head, archived_through: P, mix: args.mix ?? "read", batch: BATCH, stages: [] };
if (args.stress) {
  const stages = String(args.stages ?? "1,2,4,8,16,32,64,128").split(",").map(Number);
  const seconds = Number(args["stage-seconds"] ?? 15);
  const maxP99 = Number(args["max-p99"] ?? 2000);
  const maxErr = Number(args["max-errors"] ?? 2);
  let lastGood = null;
  for (const c of stages) {
    const r = await stage(c, seconds, Number(args.rps ?? 0));
    out.stages.push(r);
    printStage(r, `stage ${c}`);
    const limitedRate = r.calls ? (r.limited / r.calls) * 100 : 0;
    if (r.errorRate > maxErr || (r.p99 ?? 0) > maxP99 || limitedRate > 50) {
      log(`\nstopping: ${r.errorRate > maxErr ? `error rate ${r.errorRate.toFixed(1)}% > ${maxErr}%` : limitedRate > 50 ? `rate-limited ${limitedRate.toFixed(0)}% of calls` : `p99 ${fmtMs(r.p99)} > ${maxP99}ms`}`);
      break;
    }
    lastGood = r;
  }
  log("");
  log(table([["concurrency", "req/s", "ok", "refused", "429", "errors", "p50", "p90", "p99"], ...out.stages.map((r) => [r.concurrency, r.rps.toFixed(1), r.ok, r.refused, r.limited, `${r.errors} (${r.errorRate.toFixed(1)}%)`, fmtMs(r.p50), fmtMs(r.p90), fmtMs(r.p99)])]));
  log(lastGood ? `\nlast healthy stage: concurrency ${lastGood.concurrency}, ${lastGood.rps.toFixed(1)} req/s, p99 ${fmtMs(lastGood.p99)}` : "\nno healthy stage");
} else {
  const r = await stage(Number(args.concurrency ?? 8), DURATION, Number(args.rps ?? (t.key ? 0 : 8)));
  out.stages.push(r);
  printStage(r, `${args.mix ?? "read"} mix`);
}
if (args.json) writeFileSync(String(args.json), JSON.stringify(out, null, 2));
