#!/usr/bin/env node
// Correctness check: asks nullrpc and a reference node the same questions and reports every
// difference. Samples blocks from the archive (genesis, early, random), the live window and
// the head, then compares blocks, transactions, receipts, raw encodings, logs, state, fees and
// execution at explicit block numbers (never `latest`, whose answer depends on each node's lag).
//
//   node bench/verify.mjs [--chain 560048] [--url https://…] [--ref https://…] [--key nr_…]
//                         [--blocks 8] [--seed 1] [--concurrency 4] [--rps 8]
//                         [--ignore path,path] [--show 20] [--json out.json]
//
// Exit code 1 when any comparison differs or nullrpc errors where the reference answers.

import { writeFileSync } from "node:fs";
import { diff, endpoint, fmtMs, hex, limiter, normalize, num, parseArgs, pmap, rng, rpc, table, target } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const t = target(args);
if (!t.ref) throw new Error("no reference node for this chain; pass --ref");
const OURS = endpoint(t.url, t.key);
const REF = t.ref;
const N_BLOCKS = Number(args.blocks ?? 8);
const SHOW = Number(args.show ?? 20);
const random = rng(Number(args.seed ?? 1));
const pace = limiter(Number(args.rps ?? (t.key ? 40 : 8)));
const CONC = Number(args.concurrency ?? 4);
const IGNORE = String(args.ignore ?? "").split(",").filter(Boolean);

// Fields that differ between execution clients without either being wrong.
const CLIENT_IGNORE = [];

const stats = new Map(); // method -> {compared, equal, differ, oursErr, refUnsupported, ms[]}
const diffs = [];
const problems = [];
const stat = (m) => stats.get(m) ?? stats.set(m, { compared: 0, equal: 0, differ: 0, oursErr: 0, refErr: 0, skipped: 0, ms: [] }).get(m);

/** Asks both sides; records the outcome; returns [ours, ref]. */
async function compare(method, params, label = "") {
  const s = stat(method);
  await pace();
  const [a, b] = await Promise.all([rpc(OURS, method, params), rpc(REF, method, params)]);
  s.ms.push(a.ms);
  const where = `${method}(${label || JSON.stringify(params).slice(0, 80)})`;
  if (!b.ok) {
    if (b.error.code === -32601 || /not (found|supported|available)|unsupported|does not exist/i.test(b.error.message)) {
      s.skipped++;
      return [a, b];
    }
    // Both refuse the same way (a revert, insufficient funds): that is agreement.
    if (!a.ok && a.error.code === b.error.code) {
      s.compared++;
      s.equal++;
      return [a, b];
    }
    s.refErr++;
    problems.push(`${where}: reference error ${b.error.code} ${b.error.message}${a.ok ? " but nullrpc answered" : ` and nullrpc error ${a.error.code} ${a.error.message}`}`);
    return [a, b];
  }
  if (!a.ok) {
    s.oursErr++;
    problems.push(`${where}: nullrpc error ${a.error.code} ${a.error.message} (http ${a.http})`);
    return [a, b];
  }
  s.compared++;
  const d = diff(normalize(a.result), normalize(b.result), [...CLIENT_IGNORE, ...IGNORE]);
  if (d.length) {
    s.differ++;
    diffs.push({ where, d });
  } else s.equal++;
  return [a, b];
}

async function must(url, method, params) {
  const r = await rpc(url, method, params);
  if (!r.ok) throw new Error(`${method} on ${url}: ${r.error.code} ${r.error.message}`);
  return r.result;
}

const log = (...x) => console.log(...x);

log(`nullrpc  ${t.url}${t.key ? " (with key)" : " (keyless)"}`);
log(`reference ${REF}`);

// ---- identity and heads

await compare("eth_chainId", []);
await compare("net_version", []);
const ourHead = num(await must(OURS, "eth_blockNumber", []));
const refHead = num(await must(REF, "eth_blockNumber", []));
const status = await fetch(`${t.url.replace(/\/$/, "")}/status.json`).then((r) => r.json()).catch(() => null);
const P = status?.archived_through ?? null;
log(`head: nullrpc ${ourHead}, reference ${refHead}, lag ${refHead - ourHead} blocks; archived through ${P ?? "?"}, generation ${status?.generation ?? "?"}`);
if (refHead - ourHead > 5) problems.push(`nullrpc head lags the reference by ${refHead - ourHead} blocks`);

// ---- sample blocks: genesis, 1, random archive, random live, near head

const top = Math.min(ourHead, refHead) - 1;
const samples = new Set([0, 1, top]);
const pick = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
if (P !== null) {
  for (let i = 0; i < N_BLOCKS; i++) samples.add(pick(2, P - 1));
  samples.add(P);
  for (let i = 0; i < Math.max(2, N_BLOCKS / 2); i++) samples.add(pick(Math.min(P + 1, top), top));
} else for (let i = 0; i < N_BLOCKS * 1.5; i++) samples.add(pick(2, top));
const blocks = [...samples].filter((n) => n <= top).sort((a, b) => a - b);
log(`blocks: ${blocks.join(" ")}`);

const refSupports = async (method, params) => {
  const r = await rpc(REF, method, params);
  return r.ok || (r.error.code !== -32601 && !/not (found|supported|available)|unsupported|does not exist/i.test(r.error.message));
};
const debugRaw = await refSupports("debug_getRawHeader", ["0x1"]);
const traceCall = await refSupports("debug_traceCall", [{ to: "0x0000000000000000000000000000000000000000" }, "0x1", { tracer: "callTracer" }]);
log(`reference supports debug_getRaw*: ${debugRaw}, debug_traceCall: ${traceCall}`);

// ---- blocks, transactions, receipts

const txs = []; // {hash, block, index, from, to, input, value, gas}
const addrs = new Set();
await pmap(blocks, CONC, async (n) => {
  const tag = hex(n);
  const [full] = await compare("eth_getBlockByNumber", [tag, true], `${n}, full`);
  await compare("eth_getBlockByNumber", [tag, false], `${n}, hashes`);
  await compare("eth_getBlockTransactionCountByNumber", [tag], String(n));
  await compare("eth_getBlockReceipts", [tag], String(n));
  await compare("eth_getUncleCountByBlockNumber", [tag], String(n));
  if (debugRaw) {
    await compare("debug_getRawHeader", [tag], String(n));
    await compare("debug_getRawBlock", [tag], String(n));
    await compare("debug_getRawReceipts", [tag], String(n));
  }
  const b = full.result;
  if (!b) return;
  await compare("eth_getBlockByHash", [b.hash, false], `${n}`);
  await compare("eth_getBlockTransactionCountByHash", [b.hash], String(n));
  if (b.transactions?.length) {
    await compare("eth_getTransactionByBlockNumberAndIndex", [tag, "0x0"], `${n}, 0`);
    await compare("eth_getTransactionByBlockHashAndIndex", [b.hash, hex(b.transactions.length - 1)], `${n}, last`);
    for (const tx of b.transactions.slice(0, 2)) {
      txs.push({ hash: tx.hash, block: n, index: num(tx.transactionIndex), from: tx.from, to: tx.to, input: tx.input, value: tx.value, gas: tx.gas, type: tx.type });
      addrs.add(tx.from);
      if (tx.to) addrs.add(tx.to);
    }
  }
  await compare("eth_getLogs", [{ fromBlock: tag, toBlock: hex(Math.min(n + 9, top)) }], `${n}..${Math.min(n + 9, top)}`);
  await compare("eth_getLogs", [{ blockHash: b.hash }], `hash ${n}`);
});

await pmap(txs, CONC, async (tx) => {
  await compare("eth_getTransactionByHash", [tx.hash], `block ${tx.block}`);
  await compare("eth_getTransactionReceipt", [tx.hash], `block ${tx.block}`);
  await compare("eth_getRawTransactionByHash", [tx.hash], `block ${tx.block}`);
  if (debugRaw) await compare("debug_getRawTransaction", [tx.hash], `block ${tx.block}`);
});

// A transaction nobody mined.
await compare("eth_getTransactionByHash", ["0x" + "11".repeat(32)], "unknown");
await compare("eth_getTransactionReceipt", ["0x" + "11".repeat(32)], "unknown");
await compare("eth_getBlockByNumber", [hex(refHead + 1_000_000), false], "future");

// ---- state at explicit blocks: each sampled address at its block, at the head and at genesis+1

const stateChecks = [];
for (const tx of txs) {
  for (const a of [tx.from, tx.to].filter(Boolean)) {
    stateChecks.push([a, tx.block]);
    stateChecks.push([a, top]);
  }
}
stateChecks.push([[...addrs][0], 1]);
await pmap(stateChecks, CONC, async ([a, n]) => {
  const tag = hex(n);
  await compare("eth_getBalance", [a, tag], `${a.slice(0, 10)} @${n}`);
  await compare("eth_getTransactionCount", [a, tag], `${a.slice(0, 10)} @${n}`);
  const [code] = await compare("eth_getCode", [a, tag], `${a.slice(0, 10)} @${n}`);
  if (code.ok && code.result && code.result !== "0x") {
    await compare("eth_getStorageAt", [a, "0x0", tag], `${a.slice(0, 10)} slot 0 @${n}`);
    await compare("eth_getStorageAt", [a, "0x" + "0".repeat(63) + "1", tag], `${a.slice(0, 10)} slot 1 @${n}`);
  }
});

// ---- fees

for (const n of [blocks[Math.floor(blocks.length / 2)], top]) {
  await compare("eth_feeHistory", ["0x4", hex(n), [25, 75]], `4 @${n}`);
  await compare("eth_feeHistory", [4, hex(n), []], `4 @${n}, no rewards`);
}
for (const m of ["eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_blobBaseFee"]) {
  // Tip-dependent: both must answer, values are each node's own estimate.
  await pace();
  const [a, b] = await Promise.all([rpc(OURS, m, []), rpc(REF, m, [])]);
  const s = stat(m);
  s.ms.push(a.ms);
  if (!a.ok) {
    s.oursErr++;
    problems.push(`${m}: nullrpc error ${a.error.code} ${a.error.message}`);
  } else {
    s.compared++;
    s.equal++;
    log(`${m}: nullrpc ${a.result}, reference ${b.ok ? b.result : "error"} (not compared)`);
  }
}

// ---- execution: replay sampled calls at their block's parent

const calls = txs.filter((tx) => tx.to && tx.input && tx.input !== "0x").slice(0, 6);
await pmap(calls, Math.min(CONC, 2), async (tx) => {
  const call = { from: tx.from, to: tx.to, data: tx.input, value: tx.value, gas: tx.gas };
  const at = hex(tx.block - 1);
  await compare("eth_call", [call, at], `${tx.hash.slice(0, 10)} @${tx.block - 1}`);
  await compare("eth_estimateGas", [{ from: tx.from, to: tx.to, data: tx.input, value: tx.value }, at], `${tx.hash.slice(0, 10)} @${tx.block - 1}`);
  await compare("eth_createAccessList", [call, at], `${tx.hash.slice(0, 10)} @${tx.block - 1}`);
  if (traceCall) await compare("debug_traceCall", [call, at, { tracer: "callTracer" }], `${tx.hash.slice(0, 10)} @${tx.block - 1}`);
});
// A plain transfer and a revert.
if (txs.length) {
  const tx = txs[0];
  await compare("eth_call", [{ from: tx.from, to: tx.from, value: "0x1" }, hex(top)], "self transfer");
  await compare("eth_estimateGas", [{ from: tx.from, to: tx.from, value: "0x1" }, hex(top)], "self transfer");
  await compare("eth_call", [{ from: tx.from, to: tx.from, value: "0x" + "f".repeat(40) }, hex(top)], "insufficient funds");
}

// ---- report

log("");
const rows = [["method", "compared", "equal", "differ", "nullrpc err", "ref err", "ref n/a", "p50", "p95"]];
let bad = 0;
for (const [m, s] of [...stats].sort()) {
  const ms = s.ms.slice().sort((a, b) => a - b);
  const q = (p) => ms.length ? fmtMs(ms[Math.min(ms.length - 1, Math.ceil((p / 100) * ms.length) - 1)]) : "-";
  rows.push([m, s.compared, s.equal, s.differ, s.oursErr, s.refErr, s.skipped, q(50), q(95)]);
  bad += s.differ + s.oursErr;
}
log(table(rows));
log("");
if (problems.length) {
  log(`problems (${problems.length}):`);
  for (const p of problems.slice(0, SHOW)) log("  " + p);
  if (problems.length > SHOW) log(`  … ${problems.length - SHOW} more`);
}
if (diffs.length) {
  log(`differences (${diffs.length} calls):`);
  let shown = 0;
  for (const { where, d } of diffs) {
    if (shown++ >= SHOW) break;
    log(`  ${where}`);
    for (const x of d.slice(0, 6)) log(`    ${x.path}: nullrpc=${JSON.stringify(x.a)?.slice(0, 100)} reference=${JSON.stringify(x.b)?.slice(0, 100)}`);
    if (d.length > 6) log(`    … ${d.length - 6} more fields`);
  }
}
if (args.json) writeFileSync(String(args.json), JSON.stringify({ target: t, heads: { ours: ourHead, ref: refHead, archived_through: P }, blocks, stats: Object.fromEntries([...stats].map(([m, s]) => [m, { ...s, ms: undefined }])), problems, diffs }, null, 2));
log(bad ? `FAIL: ${bad} differing or failing calls` : "OK: every compared answer matches the reference");
process.exit(bad ? 1 : 0);
