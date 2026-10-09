#!/usr/bin/env node
// Benchmark scenarios for a deployed nullrpc endpoint, priced with the shared credit table:
//
//   calls   every served method in four classes: normal (cheap, at the head), heavy (expensive,
//           at the head), deep (cheap, at random archive blocks), deep-heavy (expensive, deep)
//   user    N simulated wallet users running a realistic session loop with think time
//   stress  the user mix at each plan's rate limit, to see what the platform sustains and what
//           a plan's quota is worth in requests, time and money
//
//   node bench/scenario.mjs [--chain 560048] [--key nr_… | NULLRPC_KEY] [--phase calls,user,stress]
//                           [--repeat 8] [--users 25] [--user-seconds 60] [--stress-seconds 20]
//                           [--plans free,builder,growth,scale | --rates 200,300] [--max-inflight 600] [--seed 1]
//                           [--out bench/results/<stamp>]
//
// Writes report.md and report.json (every sample, the run windows per phase for bench/cost.mjs).
// Credits per call follow apps/app/src/credits.json exactly as the RPC Worker charges them.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { endpoint, fmtMs, hex, limiter, num, parseArgs, percentile, pmap, rng, table, target } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const t = target(args);
if (!t.key) console.warn("no key: keyless runs are capped at 10 rps per client network; set NULLRPC_KEY");
const URL = endpoint(t.url, t.key);
const random = rng(Number(args.seed ?? 1));
const PHASES = String(args.phase ?? "calls,user,stress").split(",");
const REPEAT = Number(args.repeat ?? 8);
const USERS = Number(args.users ?? 25);
const USER_SECONDS = Number(args["user-seconds"] ?? 60);
const STRESS_SECONDS = Number(args["stress-seconds"] ?? 20);
const MAX_INFLIGHT = Number(args["max-inflight"] ?? 600);
/** `--only <regex>` runs only the calls cases whose label matches. */
const ONLY = args.only ? new RegExp(String(args.only), "i") : null;
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const OUT = String(args.out ?? join(HERE, "results", stamp));
mkdirSync(OUT, { recursive: true });
const log = (...x) => console.log(...x);

// ---- plans and credits (the account app's tables)

const PLANS = {
  public: { price: 0, included: 10_000_000, rps: 10 },
  free: { price: 0, included: 20_000_000, rps: 20 },
  builder: { price: 19, included: 600_000_000, rps: 250 },
  growth: { price: 89, included: 3_000_000_000, rps: 1_000 },
  scale: { price: 599, included: 20_000_000_000, rps: 3_000 },
};
const CREDITS = JSON.parse(readFileSync(join(HERE, "..", "apps", "app", "src", "credits.json"), "utf8"));
function credits(method, params, errorCode) {
  if (errorCode === -32601 || errorCode === -32600 || errorCode === -32700) return CREDITS.invalid;
  const r = CREDITS.ranges[method];
  if (r) {
    const f = params?.[0];
    let blocks = null;
    if (f && typeof f === "object") {
      if (f.blockHash !== undefined) blocks = 1;
      else {
        const a = num(/^0x/.test(f.fromBlock ?? "") ? f.fromBlock : null);
        const b = num(/^0x/.test(f.toBlock ?? "") ? f.toBlock : null);
        if (a !== null && b !== null && b >= a) blocks = b - a + 1;
      }
    }
    if (blocks === null || blocks > r.max_blocks) return r.base;
    return r.base + Math.ceil(Math.max(0, blocks - r.base_blocks) / r.step) * r.per_step;
  }
  return CREDITS.methods[method] ?? CREDITS.default;
}

// ---- a timed call that also keeps the Worker's cache headers

let nextId = 1;
async function call(method, params, timeoutMs = 40_000, label = null) {
  const id = nextId++;
  const t0 = performance.now();
  try {
    // The case label travels in a header, so `wrangler tail` (cpuTime, wallTime) can be grouped by case.
    const headers = { "content-type": "application/json", ...(label ? { "x-nullrpc-bench": label } : {}) };
    const res = await fetch(URL, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    const ms = performance.now() - t0;
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, ms, http: res.status, code: 0, message: `non-JSON (${res.status})`, method, params };
    }
    const base = { ms, http: res.status, method, params, archive: res.headers.get("x-nullrpc-archive-cache"), response: res.headers.get("x-nullrpc-response-cache"), exec: res.headers.get("x-nullrpc-exec") };
    if (body.error) return { ...base, ok: false, code: body.error.code, message: body.error.message };
    return { ...base, ok: true, result: body.result };
  } catch (e) {
    return { ok: false, ms: performance.now() - t0, http: 0, code: 0, message: e.name === "TimeoutError" ? "timeout" : String(e.message ?? e), method, params };
  }
}
const isRefusal = (s) => s.code === 3 || /reverted|insufficient funds|more than \d+ logs|narrow the range|intrinsic gas|nonce too low|unknown block/i.test(s.message ?? "");
async function must(method, params) {
  const r = await call(method, params);
  if (!r.ok) throw new Error(`${method}: ${r.code} ${r.message}`);
  return r.result;
}
const pick = (a) => a[Math.floor(random() * a.length)];
const between = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad32 = (addr) => "0x" + addr.slice(2).toLowerCase().padStart(64, "0");

// ---- corpus from the chain itself

log(`target ${t.url}${t.key ? " (key)" : " (keyless)"}; out ${OUT}`);
const head = num(await must("eth_blockNumber", []));
const status = await fetch(`${t.url.replace(/\/$/, "")}/status.json`).then((r) => r.json()).catch(() => null);
const P = status?.archived_through ?? head - 300;
log(`head ${head}, archived through ${P}, generation ${status?.generation ?? "?"}`);

const recentBlocks = [];
for (let n = head - 1; n > head - 8; n--) recentBlocks.push(await must("eth_getBlockByNumber", [hex(n), true]));
const deepNumbers = [...new Set(Array.from({ length: 10 }, () => between(1, P)))];
const deepBlocks = [];
for (const n of deepNumbers) {
  const b = await must("eth_getBlockByNumber", [hex(n), true]);
  if (b) deepBlocks.push(b);
}
const txsOf = (blocks) => blocks.flatMap((b) => b.transactions.map((tx) => ({ ...tx, blockNumber: num(b.number), blockHash: b.hash })));
const recentTxs = txsOf(recentBlocks);
const deepTxs = txsOf(deepBlocks);
const callsOf = (txs) => txs.filter((tx) => tx.to && tx.input && tx.input.length > 10);
const recentCalls = callsOf(recentTxs);
const deepCalls = callsOf(deepTxs);
const addrs = [...new Set(recentTxs.flatMap((tx) => [tx.from, tx.to]).filter(Boolean))];
const logsRecent = await must("eth_getLogs", [{ fromBlock: hex(head - 100), toBlock: hex(head), topics: [TRANSFER] }]);
const byToken = new Map();
for (const l of logsRecent) {
  if (l.topics.length < 3) continue;
  const e = byToken.get(l.address) ?? { n: 0, holders: new Set() };
  e.n++;
  e.holders.add("0x" + l.topics[2].slice(26));
  byToken.set(l.address, e);
}
const tokens = [...byToken].sort((a, b) => b[1].n - a[1].n).slice(0, 5).map(([address, e]) => ({ address, holders: [...e.holders].slice(0, 10) }));
if (!tokens.length) log("no Transfer logs in the last 100 blocks: token calls will use plain transfers");
const token = () => pick(tokens.length ? tokens : [{ address: pick(addrs), holders: addrs.slice(0, 3) }]);
const balanceOf = (tk, holder) => ({ to: tk.address, data: "0x70a08231" + holder.slice(2).toLowerCase().padStart(64, "0") });
const recentHashes = recentBlocks.map((b) => b.hash);
log(`corpus: ${recentTxs.length} recent and ${deepTxs.length} deep transactions, ${recentCalls.length}/${deepCalls.length} contract calls, ${tokens.length} tokens, ${addrs.length} addresses, deep blocks ${deepNumbers.join(" ")}`);
if (!recentTxs.length || !addrs.length) throw new Error("the recent blocks have no transactions; try later or another --seed");

const windows = {};
const samples = { calls: [], user: [], stress: {} };

// ---- phase: calls

const CASES = [];
const C = (cls, label, gen) => CASES.push({ cls, label, gen });
// normal: cheap, at the head
C("normal", "eth_chainId", () => ["eth_chainId", []]);
C("normal", "eth_blockNumber", () => ["eth_blockNumber", []]);
C("normal", "eth_gasPrice", () => ["eth_gasPrice", []]);
C("normal", "eth_maxPriorityFeePerGas", () => ["eth_maxPriorityFeePerGas", []]);
C("normal", "eth_feeHistory 4", () => ["eth_feeHistory", ["0x4", "latest", [25, 75]]]);
C("normal", "eth_getBlockByNumber latest hashes", () => ["eth_getBlockByNumber", ["latest", false]]);
C("normal", "eth_getBlockByNumber recent hashes", () => ["eth_getBlockByNumber", [hex(between(head - 7, head - 1)), false]]);
C("normal", "eth_getBlockByHash recent", () => ["eth_getBlockByHash", [pick(recentHashes), false]]);
C("normal", "eth_getBlockTransactionCountByNumber", () => ["eth_getBlockTransactionCountByNumber", [hex(between(head - 7, head - 1))]]);
C("normal", "eth_getBalance latest", () => ["eth_getBalance", [pick(addrs), "latest"]]);
C("normal", "eth_getTransactionCount latest", () => ["eth_getTransactionCount", [pick(addrs), "latest"]]);
C("normal", "eth_getCode latest", () => ["eth_getCode", [token().address, "latest"]]);
C("normal", "eth_getStorageAt latest", () => ["eth_getStorageAt", [token().address, "0x0", "latest"]]);
C("normal", "eth_getTransactionByHash recent", () => ["eth_getTransactionByHash", [pick(recentTxs).hash]]);
C("normal", "eth_getTransactionReceipt recent", () => ["eth_getTransactionReceipt", [pick(recentTxs).hash]]);
C("normal", "eth_getTransactionByBlockNumberAndIndex", () => ["eth_getTransactionByBlockNumberAndIndex", [hex(between(head - 7, head - 1)), "0x0"]]);
C("normal", "eth_getLogs 10 blocks, token", () => ["eth_getLogs", [{ fromBlock: hex(head - 10), toBlock: hex(head), address: token().address }]]);
C("normal", "eth_call balanceOf", () => { const tk = token(); return ["eth_call", [balanceOf(tk, pick(tk.holders)), "latest"]]; });
C("normal", "eth_estimateGas transfer", () => { const a = pick(addrs); return ["eth_estimateGas", [{ from: a, to: a, value: "0x1" }, "latest"]]; });
C("normal", "web3_clientVersion", () => ["web3_clientVersion", []]);
C("normal", "net_version", () => ["net_version", []]);
// heavy: expensive, at the head
C("heavy", "eth_getBlockByNumber recent full", () => ["eth_getBlockByNumber", [hex(between(head - 7, head - 1)), true]]);
C("heavy", "eth_getBlockReceipts recent", () => ["eth_getBlockReceipts", [hex(between(head - 7, head - 1))]]);
C("heavy", "eth_getLogs 1000 blocks, no filter", () => ["eth_getLogs", [{ fromBlock: hex(head - 1000), toBlock: hex(head) }]]);
C("heavy", "eth_getLogs 10000 blocks, token", () => ["eth_getLogs", [{ fromBlock: hex(head - 9999), toBlock: hex(head), address: token().address }]]);
C("heavy", "eth_getLogs 1000 blocks, Transfer topic", () => ["eth_getLogs", [{ fromBlock: hex(head - 1000), toBlock: hex(head), topics: [TRANSFER] }]]);
C("heavy", "eth_call real calldata latest", () => { const tx = pick(recentCalls.length ? recentCalls : recentTxs); return ["eth_call", [{ from: tx.from, to: tx.to, data: tx.input, value: tx.value }, "latest"]]; });
C("heavy", "eth_estimateGas real calldata", () => { const tx = pick(recentCalls.length ? recentCalls : recentTxs); return ["eth_estimateGas", [{ from: tx.from, to: tx.to, data: tx.input, value: tx.value }, "latest"]]; });
C("heavy", "eth_createAccessList", () => { const tx = pick(recentCalls.length ? recentCalls : recentTxs); return ["eth_createAccessList", [{ from: tx.from, to: tx.to, data: tx.input, value: tx.value }, "latest"]]; });
C("heavy", "debug_traceCall callTracer", () => { const tx = pick(recentCalls.length ? recentCalls : recentTxs); return ["debug_traceCall", [{ from: tx.from, to: tx.to, data: tx.input, value: tx.value }, "latest", { tracer: "callTracer" }]]; });
C("heavy", "trace_call", () => { const tx = pick(recentCalls.length ? recentCalls : recentTxs); return ["trace_call", [{ from: tx.from, to: tx.to, data: tx.input, value: tx.value }, ["trace"], "latest"]]; });
C("heavy", "debug_traceTransaction recent", () => ["debug_traceTransaction", [pick(recentCalls.length ? recentCalls : recentTxs).hash, { tracer: "callTracer" }]]);
C("heavy", "trace_transaction recent", () => ["trace_transaction", [pick(recentCalls.length ? recentCalls : recentTxs).hash]]);
C("heavy", "trace_replayTransaction recent", () => ["trace_replayTransaction", [pick(recentCalls.length ? recentCalls : recentTxs).hash, ["trace"]]]);
C("heavy", "debug_traceBlockByNumber recent", () => ["debug_traceBlockByNumber", [hex(between(head - 7, head - 1)), { tracer: "callTracer" }]]);
C("heavy", "debug_traceBlockByHash recent", () => ["debug_traceBlockByHash", [pick(recentHashes), { tracer: "callTracer" }]]);
C("heavy", "trace_block recent", () => ["trace_block", [hex(between(head - 7, head - 1))]]);
C("heavy", "trace_replayBlockTransactions recent", () => ["trace_replayBlockTransactions", [hex(between(head - 7, head - 1)), ["trace"]]]);
C("heavy", "debug_getRawBlock recent", () => ["debug_getRawBlock", [hex(between(head - 7, head - 1))]]);
C("heavy", "debug_getRawReceipts recent", () => ["debug_getRawReceipts", [hex(between(head - 7, head - 1))]]);
C("heavy", "batch of 10 mixed", () => ["__batch", null]);
// deep: cheap, at random archive blocks
const deepN = () => pick(deepNumbers);
C("deep", "eth_getBlockByNumber deep hashes", () => ["eth_getBlockByNumber", [hex(deepN()), false]]);
C("deep", "eth_getBlockByHash deep", () => ["eth_getBlockByHash", [pick(deepBlocks).hash, false]]);
C("deep", "eth_getBalance deep", () => ["eth_getBalance", [pick(addrs), hex(deepN())]]);
C("deep", "eth_getTransactionCount deep", () => ["eth_getTransactionCount", [pick(addrs), hex(deepN())]]);
C("deep", "eth_getCode deep", () => ["eth_getCode", [token().address, hex(deepN())]]);
C("deep", "eth_getStorageAt deep", () => ["eth_getStorageAt", [token().address, "0x0", hex(deepN())]]);
C("deep", "eth_getTransactionByHash deep", () => ["eth_getTransactionByHash", [pick(deepTxs.length ? deepTxs : recentTxs).hash]]);
C("deep", "eth_getTransactionReceipt deep", () => ["eth_getTransactionReceipt", [pick(deepTxs.length ? deepTxs : recentTxs).hash]]);
C("deep", "eth_getLogs 10 blocks deep", () => { const n = deepN(); return ["eth_getLogs", [{ fromBlock: hex(n), toBlock: hex(n + 9) }]]; });
C("deep", "eth_feeHistory 4 deep", () => ["eth_feeHistory", ["0x4", hex(deepN()), [25, 75]]]);
C("deep", "debug_getRawHeader deep", () => ["debug_getRawHeader", [hex(deepN())]]);
// deep-heavy: expensive, deep
C("deep-heavy", "eth_getBlockByNumber deep full", () => ["eth_getBlockByNumber", [hex(deepN()), true]]);
C("deep-heavy", "eth_getBlockReceipts deep", () => ["eth_getBlockReceipts", [hex(deepN())]]);
C("deep-heavy", "eth_getLogs 1000 blocks deep", () => { const n = Math.max(1, deepN() - 1000); return ["eth_getLogs", [{ fromBlock: hex(n), toBlock: hex(n + 999) }]]; });
C("deep-heavy", "eth_getLogs 10000 blocks deep, Transfer", () => { const n = Math.max(1, deepN() - 10000); return ["eth_getLogs", [{ fromBlock: hex(n), toBlock: hex(n + 9999), topics: [TRANSFER] }]]; });
C("deep-heavy", "eth_call replay at n-1", () => { const tx = pick(deepCalls.length ? deepCalls : deepTxs.length ? deepTxs : recentTxs); return ["eth_call", [{ from: tx.from, to: tx.to ?? tx.from, data: tx.input, value: tx.value, gas: tx.gas }, hex(tx.blockNumber - 1)]]; });
C("deep-heavy", "eth_estimateGas replay at n-1", () => { const tx = pick(deepCalls.length ? deepCalls : deepTxs.length ? deepTxs : recentTxs); return ["eth_estimateGas", [{ from: tx.from, to: tx.to ?? tx.from, data: tx.input, value: tx.value }, hex(tx.blockNumber - 1)]]; });
C("deep-heavy", "debug_traceCall replay at n-1", () => { const tx = pick(deepCalls.length ? deepCalls : deepTxs.length ? deepTxs : recentTxs); return ["debug_traceCall", [{ from: tx.from, to: tx.to ?? tx.from, data: tx.input, value: tx.value, gas: tx.gas }, hex(tx.blockNumber - 1), { tracer: "callTracer" }]]; });
C("deep-heavy", "debug_traceTransaction deep", () => ["debug_traceTransaction", [pick(deepCalls.length ? deepCalls : deepTxs.length ? deepTxs : recentTxs).hash, { tracer: "callTracer" }]]);
C("deep-heavy", "trace_transaction deep", () => ["trace_transaction", [pick(deepCalls.length ? deepCalls : deepTxs.length ? deepTxs : recentTxs).hash]]);
C("deep-heavy", "trace_replayTransaction deep", () => ["trace_replayTransaction", [pick(deepCalls.length ? deepCalls : deepTxs.length ? deepTxs : recentTxs).hash, ["trace", "stateDiff"]]]);
C("deep-heavy", "debug_traceBlockByNumber deep", () => ["debug_traceBlockByNumber", [hex(deepN()), { tracer: "callTracer" }]]);
C("deep-heavy", "trace_block deep", () => ["trace_block", [hex(deepN())]]);
C("deep-heavy", "trace_replayBlockTransactions deep", () => ["trace_replayBlockTransactions", [hex(deepN()), ["trace"]]]);
C("deep-heavy", "debug_getRawBlock deep", () => ["debug_getRawBlock", [hex(deepN())]]);
C("deep-heavy", "debug_getRawReceipts deep", () => ["debug_getRawReceipts", [hex(deepN())]]);

async function runCase(c) {
  const [method, params] = c.gen();
  if (method === "__batch") {
    const items = Array.from({ length: 10 }, () => { const [m, p] = pick(CASES.filter((x) => x.cls === "normal")).gen(); return { jsonrpc: "2.0", id: nextId++, method: m, params: p }; });
    const t0 = performance.now();
    try {
      const res = await fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(items), signal: AbortSignal.timeout(40_000) });
      const body = await res.json();
      const ms = performance.now() - t0;
      const errs = Array.isArray(body) ? body.filter((r) => r.error) : items;
      const cr = Array.isArray(body) ? items.reduce((s, it) => s + credits(it.method, it.params, body.find((r) => r.id === it.id)?.error?.code), 0) : CREDITS.invalid;
      return { cls: c.cls, label: c.label, method: "batch[10]", ms, ok: Array.isArray(body) && errs.length === 0, refused: false, http: res.status, credits: cr, archive: res.headers.get("x-nullrpc-archive-cache"), response: res.headers.get("x-nullrpc-response-cache"), message: errs[0]?.error?.message };
    } catch (e) {
      return { cls: c.cls, label: c.label, method: "batch[10]", ms: performance.now() - t0, ok: false, refused: false, http: 0, credits: 0, message: String(e.message ?? e) };
    }
  }
  const r = await call(method, params, 40_000, c.label);
  // Failed calls keep their parameters so a failure can be replayed by hand.
  return { cls: c.cls, label: c.label, method, ms: r.ms, ok: r.ok, refused: !r.ok && isRefusal(r), http: r.http, code: r.code, message: r.message, credits: credits(method, params, r.code), archive: r.archive, response: r.response, exec: r.exec, ...(r.ok ? {} : { params }) };
}

function cacheTally(rows) {
  let hit = 0, miss = 0, rhit = 0, rmiss = 0;
  for (const s of rows) {
    const m = /hit=(\d+) miss=(\d+)/.exec(s.archive ?? "");
    if (m) { hit += Number(m[1]); miss += Number(m[2]); }
    if (s.response === "hit") rhit++; else if (s.response === "miss") rmiss++;
  }
  return { r2ReadsPerCall: rows.length ? miss / rows.length : 0, archiveHitRate: hit + miss ? hit / (hit + miss) : null, responseHitRate: rhit + rmiss ? rhit / (rhit + rmiss) : null };
}

/** Mean read rounds and hinted keys per call from the `x-nullrpc-exec` header (execution methods only). */
function execTally(rows) {
  const parsed = rows.map((s) => /rounds=(\d+) keys=(\d+) hints=(\d+)/.exec(s.exec ?? "")).filter(Boolean);
  if (!parsed.length) return { rounds: "-", hints: "-" };
  const mean = (i) => (parsed.reduce((a, m) => a + Number(m[i]), 0) / parsed.length).toFixed(1);
  return { rounds: mean(1), hints: mean(3) };
}

if (PHASES.includes("calls")) {
  log(`\n== calls: ${CASES.length} cases × ${REPEAT}`);
  windows.calls = { started: new Date().toISOString() };
  const jobs = CASES.filter((c) => !ONLY || ONLY.test(c.label)).flatMap((c) => Array(REPEAT).fill(c));
  // Mixed order so no class monopolizes the cache or the budget.
  for (let i = jobs.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [jobs[i], jobs[j]] = [jobs[j], jobs[i]]; }
  const pace = limiter(t.key ? 0 : 8);
  samples.calls = await pmap(jobs, 4, async (c) => { await pace(); return runCase(c); });
  windows.calls.ended = new Date().toISOString();
  for (const cls of ["normal", "heavy", "deep", "deep-heavy"]) {
    const rows = [["case", "n", "ok", "refused", "err", "p50", "p95", "max", "credits", "r2/call", "resp-cache", "rounds", "hints"]];
    for (const c of CASES.filter((x) => x.cls === cls)) {
      const ss = samples.calls.filter((s) => s.label === c.label);
      const ms = ss.map((s) => s.ms).sort((a, b) => a - b);
      const tally = cacheTally(ss);
      const ex = execTally(ss);
      rows.push([c.label, ss.length, ss.filter((s) => s.ok).length, ss.filter((s) => s.refused).length, ss.filter((s) => !s.ok && !s.refused).length, fmtMs(percentile(ms, 50)), fmtMs(percentile(ms, 95)), fmtMs(ms[ms.length - 1]), ss[0]?.credits ?? "-", tally.r2ReadsPerCall.toFixed(1), tally.responseHitRate === null ? "-" : `${(tally.responseHitRate * 100).toFixed(0)}%`, ex.rounds, ex.hints]);
    }
    log(`\n-- ${cls}\n` + table(rows));
  }
  const errs = {};
  for (const s of samples.calls.filter((s) => !s.ok && !s.refused)) errs[`${s.label}: ${s.http} ${s.code} ${(s.message ?? "").slice(0, 70)}`] = (errs[`${s.label}: ${s.http} ${s.code} ${(s.message ?? "").slice(0, 70)}`] ?? 0) + 1;
  if (Object.keys(errs).length) { log("\nerrors:"); for (const [k, n] of Object.entries(errs)) log(`  ${n}× ${k}`); }
}

// ---- phase: user (a wallet session)

function userSteps() {
  const me = pick(addrs);
  const tk = token();
  const holder = pick(tk.holders);
  const tx = pick(recentTxs);
  return [
    ["connect: eth_chainId", "eth_chainId", []],
    ["connect: eth_blockNumber", "eth_blockNumber", []],
    ["balance: eth_getBalance", "eth_getBalance", [me, "latest"]],
    ["balance: eth_call balanceOf", "eth_call", [balanceOf(tk, holder), "latest"]],
    ["balance: eth_call balanceOf 2", "eth_call", [balanceOf(tk, pick(tk.holders)), "latest"]],
    ["send: eth_getTransactionCount", "eth_getTransactionCount", [me, "pending"]],
    ["send: eth_gasPrice", "eth_gasPrice", []],
    ["send: eth_maxPriorityFeePerGas", "eth_maxPriorityFeePerGas", []],
    ["send: eth_feeHistory", "eth_feeHistory", ["0x5", "latest", [10, 50, 90]]],
    ["send: eth_estimateGas", "eth_estimateGas", [{ from: me, to: me, value: "0x1" }, "latest"]],
    ["confirm: eth_getTransactionReceipt", "eth_getTransactionReceipt", [tx.hash]],
    ["confirm: eth_getTransactionByHash", "eth_getTransactionByHash", [tx.hash]],
    ["confirm: eth_getBlockByNumber latest", "eth_getBlockByNumber", ["latest", false]],
    ["history: eth_getLogs transfers to me", "eth_getLogs", [{ fromBlock: hex(head - 1000), toBlock: "latest", address: tk.address, topics: [TRANSFER, null, pad32(holder)] }]],
    ["history: eth_getBlockByNumber recent", "eth_getBlockByNumber", [hex(between(head - 7, head - 1)), false]],
  ];
}

async function userSession(user, deadline, out) {
  let sessions = 0;
  while (performance.now() < deadline) {
    const t0 = performance.now();
    let failed = false;
    for (const [step, method, params] of userSteps()) {
      if (performance.now() >= deadline) break;
      const r = await call(method, params);
      out.push({ user, step, method, ms: r.ms, ok: r.ok, refused: !r.ok && isRefusal(r), http: r.http, code: r.code, message: r.message, credits: credits(method, params, r.code), archive: r.archive, response: r.response });
      if (!r.ok && !isRefusal(r)) failed = true;
      await new Promise((res) => setTimeout(res, 150 + random() * 450));
    }
    out.push({ user, step: "session", ms: performance.now() - t0, ok: !failed, credits: 0 });
    sessions++;
  }
  return sessions;
}

if (PHASES.includes("user")) {
  log(`\n== user: ${USERS} users for ${USER_SECONDS}s`);
  windows.user = { started: new Date().toISOString() };
  const deadline = performance.now() + USER_SECONDS * 1000;
  await Promise.all(Array.from({ length: USERS }, (_, i) => userSession(i, deadline, samples.user)));
  windows.user.ended = new Date().toISOString();
  const rows = [["step", "n", "ok", "refused", "err", "p50", "p95", "max", "credits"]];
  const steps = [...new Set(samples.user.map((s) => s.step))];
  for (const step of steps) {
    const ss = samples.user.filter((s) => s.step === step);
    const ms = ss.map((s) => s.ms).sort((a, b) => a - b);
    rows.push([step, ss.length, ss.filter((s) => s.ok).length, ss.filter((s) => s.refused).length, ss.filter((s) => !s.ok && !s.refused).length, fmtMs(percentile(ms, 50)), fmtMs(percentile(ms, 95)), fmtMs(ms[ms.length - 1]), ss[0]?.credits ?? 0]);
  }
  log(table(rows));
}

// ---- phase: stress at each plan's rate

function userMixRequest() {
  const steps = userSteps();
  const [, method, params] = pick(steps);
  return [method, params];
}

async function stressAt(rps, seconds) {
  const pace = limiter(rps);
  const out = [];
  const end = performance.now() + seconds * 1000;
  let inflight = 0;
  let dropped = 0;
  const pending = new Set();
  while (performance.now() < end) {
    await pace();
    if (inflight >= MAX_INFLIGHT) { dropped++; continue; }
    inflight++;
    const [method, params] = userMixRequest();
    const p = call(method, params).then((r) => { out.push({ method, ms: r.ms, ok: r.ok, refused: !r.ok && isRefusal(r), http: r.http, code: r.code, message: r.message, credits: credits(method, params, r.code), archive: r.archive, response: r.response }); inflight--; pending.delete(p); });
    pending.add(p);
  }
  const t1 = performance.now();
  await Promise.all([...pending]);
  const wall = seconds + (performance.now() - t1) / 1000;
  return { out, dropped, wall };
}

const stressRows = [];
if (PHASES.includes("stress")) {
  // --rates runs the same mix at arbitrary rates (rows named rate-N) instead of the plans' caps.
  const plans = args.rates ? String(args.rates).split(",").map((r) => `rate-${Number(r)}`) : String(args.plans ?? "free,builder,growth,scale").split(",");
  windows.stress = {};
  for (const plan of plans) {
    const p = plan.startsWith("rate-") ? { rps: Number(plan.slice(5)) } : PLANS[plan];
    if (!p || !(p.rps > 0)) throw new Error(`unknown plan ${plan}`);
    log(`\n== stress: ${plan} at ${p.rps} req/s for ${STRESS_SECONDS}s`);
    windows.stress[plan] = { started: new Date().toISOString(), rps: p.rps };
    const { out, dropped, wall } = await stressAt(p.rps, STRESS_SECONDS);
    windows.stress[plan].ended = new Date().toISOString();
    samples.stress[plan] = out;
    const ms = out.map((s) => s.ms).sort((a, b) => a - b);
    const ok = out.filter((s) => s.ok).length;
    const refused = out.filter((s) => s.refused).length;
    const limited = out.filter((s) => s.http === 429).length;
    const err = out.length - ok - refused - limited;
    const cr = out.reduce((s, x) => s + x.credits, 0);
    const tally = cacheTally(out);
    const row = { plan, target: p.rps, achieved: out.length / wall, n: out.length, ok, refused, limited, err, errRate: out.length ? (err / out.length) * 100 : 0, p50: percentile(ms, 50), p95: percentile(ms, 95), p99: percentile(ms, 99), creditsPerReq: out.length ? cr / out.length : 0, dropped, r2PerCall: tally.r2ReadsPerCall };
    stressRows.push(row);
    log(`achieved ${row.achieved.toFixed(0)} req/s (client dropped ${dropped}); ok ${ok}, refused ${refused}, 429 ${limited}, errors ${err} (${row.errRate.toFixed(2)}%); p50 ${fmtMs(row.p50)} p95 ${fmtMs(row.p95)} p99 ${fmtMs(row.p99)}; ${row.creditsPerReq.toFixed(1)} credits/req`);
    const errs = {};
    for (const s of out.filter((s) => !s.ok && !s.refused)) errs[`${s.http} ${s.code} ${(s.message ?? "").slice(0, 70)}`] = (errs[`${s.http} ${s.code} ${(s.message ?? "").slice(0, 70)}`] ?? 0) + 1;
    for (const [k, n] of Object.entries(errs).sort((a, b) => b[1] - a[1]).slice(0, 5)) log(`  ${n}× ${k}`);
    if (row.errRate > 20) { log("stopping the ramp: error rate above 20%"); break; }
  }
}

// ---- report

const SECONDS_PER_MONTH = 30 * 24 * 3600;
function planEconomics() {
  const rows = [["plan", "$/mo", "included credits", "rps cap", "credits/req (user mix)", "requests in quota", "hours at the cap to spend it", "$ per 1M requests", "$ per 1M credits", "measured at cap: p50 / p99 / err"]];
  const mixCredits = stressRows.length ? stressRows[0].creditsPerReq : samples.user.length ? samples.user.filter((s) => s.step !== "session").reduce((s, x) => s + x.credits, 0) / samples.user.filter((s) => s.step !== "session").length : 20;
  for (const [plan, p] of Object.entries(PLANS)) {
    const reqs = p.included / mixCredits;
    const hours = reqs / p.rps / 3600;
    const m = stressRows.find((r) => r.plan === plan);
    rows.push([plan, p.price, p.included.toLocaleString("en-US"), p.rps, mixCredits.toFixed(1), Math.round(reqs).toLocaleString("en-US"), hours.toFixed(1), p.price ? ((p.price / reqs) * 1e6).toFixed(3) : "0", p.price ? ((p.price / p.included) * 1e6).toFixed(4) : "0", m ? `${fmtMs(m.p50)} / ${fmtMs(m.p99)} / ${m.errRate.toFixed(1)}%` : "-"]);
  }
  return { rows, mixCredits };
}

const econ = planEconomics();
const md = [];
md.push(`# nullrpc benchmark ${stamp}`, "", `Target ${t.url} (${t.key ? "internal key" : "keyless"}), head ${head}, archived through ${P}, generation ${status?.generation ?? "?"}.`, "");
if (samples.calls.length) {
  md.push("## Calls", "", "Each case repeated " + REPEAT + " times, 4 in flight, shuffled. `r2/call` is the Worker's reported R2 misses per call; `resp-cache` the share of answers served from the response cache.", "");
  for (const cls of ["normal", "heavy", "deep", "deep-heavy"]) {
    md.push(`### ${cls}`, "", "| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const c of CASES.filter((x) => x.cls === cls)) {
      const ss = samples.calls.filter((s) => s.label === c.label);
      const ms = ss.map((s) => s.ms).sort((a, b) => a - b);
      const tally = cacheTally(ss);
      md.push(`| ${c.label} | ${ss.length} | ${ss.filter((s) => s.ok).length} | ${ss.filter((s) => s.refused).length} | ${ss.filter((s) => !s.ok && !s.refused).length} | ${fmtMs(percentile(ms, 50))} | ${fmtMs(percentile(ms, 95))} | ${fmtMs(ms[ms.length - 1])} | ${ss[0]?.credits ?? "-"} | ${tally.r2ReadsPerCall.toFixed(1)} | ${tally.responseHitRate === null ? "-" : (tally.responseHitRate * 100).toFixed(0) + "%"} |`);
    }
    md.push("");
  }
  const failures = samples.calls.filter((s) => !s.ok && !s.refused);
  if (failures.length) {
    md.push("### Failures", "");
    const errs = {};
    for (const s of failures) errs[`${s.label}: HTTP ${s.http}, code ${s.code}, ${(s.message ?? "").slice(0, 90)}`] = (errs[`${s.label}: HTTP ${s.http}, code ${s.code}, ${(s.message ?? "").slice(0, 90)}`] ?? 0) + 1;
    for (const [k, n] of Object.entries(errs)) md.push(`- ${n}× ${k}`);
    md.push("", "Parameters of each failed call are in report.json (`samples.calls[].params` where `ok` is false).", "");
  }
}
if (samples.user.length) {
  const sess = samples.user.filter((s) => s.step === "session");
  const steps = samples.user.filter((s) => s.step !== "session");
  const perSession = steps.reduce((s, x) => s + x.credits, 0) / Math.max(1, sess.length);
  md.push("## Normal user scenario", "", `${USERS} simulated wallet users for ${USER_SECONDS}s, each looping a 15-step session (connect, balances, fee quote, estimate, confirmation, history) with 150 to 600ms of think time between steps. ${sess.length} sessions completed, ${sess.filter((s) => s.ok).length} without a failed step; a session costs about ${perSession.toFixed(0)} credits and takes ${fmtMs(percentile(sess.map((s) => s.ms).sort((a, b) => a - b), 50))} at the median.`, "", "| step | n | ok | refused | err | p50 | p95 | max | credits |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const step of [...new Set(steps.map((s) => s.step))]) {
    const ss = steps.filter((s) => s.step === step);
    const ms = ss.map((s) => s.ms).sort((a, b) => a - b);
    md.push(`| ${step} | ${ss.length} | ${ss.filter((s) => s.ok).length} | ${ss.filter((s) => s.refused).length} | ${ss.filter((s) => !s.ok && !s.refused).length} | ${fmtMs(percentile(ms, 50))} | ${fmtMs(percentile(ms, 95))} | ${fmtMs(ms[ms.length - 1])} | ${ss[0]?.credits ?? 0} |`);
  }
  md.push("", `Free plan: 20M credits is about ${Math.round(20e6 / perSession).toLocaleString("en-US")} such sessions a month; Builder: ${Math.round(600e6 / perSession).toLocaleString("en-US")}.`, "");
}
if (stressRows.length) {
  md.push("## Stress at each plan's rate", "", `The user mix sent open-loop at each plan's requests-per-second cap for ${STRESS_SECONDS}s with one internal key (no limits), from one client (at most ${MAX_INFLIGHT} in flight; "dropped" counts sends the client skipped because it was full, a client limit, not the endpoint's).`, "", "| plan | target rps | achieved | n | ok | refused | 429 | err | err % | p50 | p95 | p99 | credits/req | r2/call | client dropped |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of stressRows) md.push(`| ${r.plan} | ${r.target} | ${r.achieved.toFixed(0)} | ${r.n} | ${r.ok} | ${r.refused} | ${r.limited} | ${r.err} | ${r.errRate.toFixed(2)} | ${fmtMs(r.p50)} | ${fmtMs(r.p95)} | ${fmtMs(r.p99)} | ${r.creditsPerReq.toFixed(1)} | ${r.r2PerCall.toFixed(2)} | ${r.dropped} |`);
  md.push("");
}
md.push("## Plan economics", "", `Credits per request from the measured user mix (${econ.mixCredits.toFixed(1)}). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.`, "", "| " + econ.rows[0].join(" | ") + " |", "|" + econ.rows[0].map(() => "---").join("|") + "|");
for (const r of econ.rows.slice(1)) md.push("| " + r.join(" | ") + " |");
md.push("", "Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report " + OUT + "` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.", "");
writeFileSync(join(OUT, "report.md"), md.join("\n"));
writeFileSync(join(OUT, "report.json"), JSON.stringify({ target: { url: t.url, chainId: t.chainId, keyed: !!t.key }, head, archived_through: P, generation: status?.generation ?? null, windows, cases: CASES.map((c) => ({ cls: c.cls, label: c.label })), samples, stress: stressRows, economics: { mixCredits: econ.mixCredits, plans: PLANS } }, null, 1));
log(`\nreport: ${join(OUT, "report.md")}`);
log(table(econ.rows));
