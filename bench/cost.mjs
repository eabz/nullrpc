#!/usr/bin/env node
// Cost of a benchmark run from Cloudflare's own metrics, per run window written by
// bench/scenario.mjs: Workers requests and CPU, Durable Object requests and duration, R2
// operations. Prices per 1M requests and the margin per plan follow.
//
//   CF_API_TOKEN=… node bench/cost.mjs --report bench/results/<stamp> [--account <id>]
//                                      [--rpc nullrpc-rpc-560048] [--live nullrpc-live-560048]
//                                      [--app nullrpc-app] [--bucket nullrpc]
//
// The token needs Account Analytics: Read (and Workers Scripts: Read to list Durable Object
// namespaces). Without CF_API_TOKEN the wrangler OAuth token is tried. Writes cost.md and
// cost.json next to report.json.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseArgs, table } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.report) throw new Error("--report <dir with report.json> is required");
const DIR = String(args.report);
const report = JSON.parse(readFileSync(join(DIR, "report.json"), "utf8"));
const ACCOUNT = String(args.account ?? process.env.CF_ACCOUNT_ID ?? "60401d41768f5312f816303569019bb5");
const RPC = String(args.rpc ?? `nullrpc-rpc-${report.target.chainId}`);
const LIVE = String(args.live ?? `nullrpc-live-${report.target.chainId}`);
const APP = String(args.app ?? "nullrpc-app");
const BUCKET = String(args.bucket ?? "nullrpc");

function token() {
  if (process.env.CF_API_TOKEN) return process.env.CF_API_TOKEN;
  for (const p of [join(homedir(), "Library/Preferences/.wrangler/config/default.toml"), join(homedir(), ".wrangler/config/default.toml"), join(homedir(), ".config/.wrangler/config/default.toml")]) {
    try {
      const m = /oauth_token\s*=\s*"([^"]+)"/.exec(readFileSync(p, "utf8"));
      if (m) return m[1];
    } catch {}
  }
  throw new Error("no CF_API_TOKEN and no wrangler login found");
}
const TOKEN = token();

async function graphql(query, variables) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
    const body = await res.json();
    const msg = body.errors?.map((e) => e.message).join("; ") ?? "";
    // The analytics API has a small budget per 5 minutes; wait it out rather than fail.
    if (/budget depleted|rate limit/i.test(msg) && attempt < 3) {
      console.log("analytics rate limit: waiting 5 minutes");
      await new Promise((r) => setTimeout(r, 5 * 60_000 + 5_000));
      continue;
    }
    if (msg) throw new Error("GraphQL: " + msg);
    return body.data.viewer.accounts[0];
  }
}
async function rest(path) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const body = await res.json();
  if (!body.success) throw new Error("REST " + path + ": " + JSON.stringify(body.errors));
  return body.result;
}

// Prices (USD), Workers Paid: https://developers.cloudflare.com/workers/platform/pricing/
const PRICE = { workersReq: 0.3 / 1e6, cpuMs: 0.02 / 1e6, doReq: 0.15 / 1e6, doGbS: 12.5 / 1e6, r2ClassA: 4.5 / 1e6, r2ClassB: 0.36 / 1e6, doRowsRead: 0.001 / 1e6, doRowsWritten: 1.0 / 1e6 };

/** Durable Object namespaces of the live and app Workers. */
let nsCache = null;
async function namespaces() {
  if (nsCache) return nsCache;
  const list = await rest(`/accounts/${ACCOUNT}/workers/durable_objects/namespaces?per_page=100`);
  return (nsCache = list.filter((n) => [LIVE, APP].includes(n.script)).map((n) => ({ id: n.id, name: `${n.script}/${n.class}` })));
}

async function window(label, from, to, requests) {
  const vars = { account: ACCOUNT, from, to };
  const w = await graphql(`query($account:String!,$from:Time!,$to:Time!,$scripts:[String!]){viewer{accounts(filter:{accountTag:$account}){
    workersInvocationsAdaptive(limit:100,filter:{datetime_geq:$from,datetime_leq:$to,scriptName_in:$scripts}){dimensions{scriptName} sum{requests errors subrequests cpuTimeUs} quantiles{cpuTimeP50 cpuTimeP99}}}}}`, { ...vars, scripts: [RPC, LIVE, APP] });
  const ns = await namespaces();
  const d = ns.length ? await graphql(`query($account:String!,$from:Time!,$to:Time!,$ns:[String!]){viewer{accounts(filter:{accountTag:$account}){
    inv:durableObjectsInvocationsAdaptiveGroups(limit:100,filter:{datetime_geq:$from,datetime_leq:$to,namespaceId_in:$ns}){dimensions{namespaceId} sum{requests wallTime}}
    per:durableObjectsPeriodicGroups(limit:100,filter:{datetime_geq:$from,datetime_leq:$to,namespaceId_in:$ns}){dimensions{namespaceId} sum{duration rowsRead rowsWritten}}}}}`, { ...vars, ns: ns.map((n) => n.id) }) : { inv: [], per: [] };
  const r2 = await graphql(`query($account:String!,$from:Time!,$to:Time!,$buckets:[String!]){viewer{accounts(filter:{accountTag:$account}){
    r2OperationsAdaptiveGroups(limit:100,filter:{datetime_geq:$from,datetime_leq:$to,bucketName_in:$buckets}){dimensions{actionType} sum{requests}}}}}`, { ...vars, buckets: [BUCKET] });
  const scripts = Object.fromEntries((w.workersInvocationsAdaptive ?? []).map((x) => [x.dimensions.scriptName, { requests: x.sum.requests, errors: x.sum.errors, subrequests: x.sum.subrequests, cpuMs: x.sum.cpuTimeUs / 1000, cpuP50: x.quantiles.cpuTimeP50 / 1000, cpuP99: x.quantiles.cpuTimeP99 / 1000 }]));
  const doReq = (d.inv ?? []).reduce((s, x) => s + x.sum.requests, 0);
  const doGbS = (d.per ?? []).reduce((s, x) => s + x.sum.duration, 0) * (128 / 1024);
  const rowsRead = (d.per ?? []).reduce((s, x) => s + x.sum.rowsRead, 0);
  const rowsWritten = (d.per ?? []).reduce((s, x) => s + x.sum.rowsWritten, 0);
  const CLASS_A = new Set(["PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload", "ListObjects", "ListBuckets", "PutBucket", "UploadPart", "UploadPartCopy", "PutObjectAcl", "DeleteObject", "DeleteObjects"]);
  let classA = 0, classB = 0;
  for (const x of r2.r2OperationsAdaptiveGroups ?? []) (CLASS_A.has(x.dimensions.actionType) ? (classA += x.sum.requests) : (classB += x.sum.requests));
  // Only edge-originated requests are billed: calls over service bindings and Workers RPC are
  // not charged as requests (their CPU time is). The RPC Worker is the only edge entry.
  const workersReq = scripts[RPC]?.requests ?? 0;
  const cpuMs = Object.values(scripts).reduce((s, x) => s + x.cpuMs, 0);
  const cost = workersReq * PRICE.workersReq + cpuMs * PRICE.cpuMs + doReq * PRICE.doReq + doGbS * PRICE.doGbS + classA * PRICE.r2ClassA + classB * PRICE.r2ClassB + rowsRead * PRICE.doRowsRead + rowsWritten * PRICE.doRowsWritten;
  const n = requests || scripts[RPC]?.requests || 1;
  const breakdown = { "Workers requests": workersReq * PRICE.workersReq, "Workers CPU": cpuMs * PRICE.cpuMs, "DO requests": doReq * PRICE.doReq, "DO duration": doGbS * PRICE.doGbS, "DO rows": rowsRead * PRICE.doRowsRead + rowsWritten * PRICE.doRowsWritten, "R2 Class B": classB * PRICE.r2ClassB, "R2 Class A": classA * PRICE.r2ClassA };
  return { label, from, to, requests: n, scripts, doReq, doGbS, rowsRead, rowsWritten, r2ClassA: classA, r2ClassB: classB, cost, per1M: (cost / n) * 1e6, breakdown, units: { rpcReq: workersReq / n, liveCalls: (scripts[LIVE]?.requests ?? 0) / n, appCalls: (scripts[APP]?.requests ?? 0) / n, cpuMs: cpuMs / n, doReq: doReq / n, r2ClassB: classB / n, rowsRead: rowsRead / n } };
}

const windows = [];
const W = report.windows ?? {};
const pad = (iso, s) => new Date(new Date(iso).getTime() + s * 1000).toISOString();
if (W.calls?.ended) windows.push(["calls", W.calls.started, pad(W.calls.ended, 30), report.samples.calls.length]);
if (W.user?.ended) windows.push(["user", W.user.started, pad(W.user.ended, 30), report.samples.user.filter((s) => s.step !== "session").length]);
for (const [plan, w] of Object.entries(W.stress ?? {})) if (w.ended) windows.push([`stress ${plan}`, w.started, pad(w.ended, 30), report.samples.stress[plan].length]);
if (!windows.length) throw new Error("report.json has no finished run windows");
console.log("Analytics are sampled and arrive with a delay of a few minutes; run this at least 5 minutes after the scenario. Windows include 30s of tail for in-flight work.");
const results = [];
for (const [label, from, to, n] of windows) {
  const r = await window(label, from, to, n);
  results.push(r);
  console.log(`${label}: ${n} client requests; per request: rpc ${r.units.rpcReq.toFixed(2)}, live calls ${r.units.liveCalls.toFixed(1)}, app calls ${r.units.appCalls.toFixed(2)}, DO ${r.units.doReq.toFixed(1)}, R2 B ${r.units.r2ClassB.toFixed(1)}, cpu ${r.units.cpuMs.toFixed(1)}ms; $${r.per1M.toFixed(2)} per 1M requests = ${Object.entries(r.breakdown).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${((v / r.cost) * 100).toFixed(0)}%`).join(", ")}`);
}

// Margin per plan: the price the quota buys per 1M requests against the measured cost.
const PLANS = report.economics.plans;
const mixCredits = report.economics.mixCredits;
const costRef = results.find((r) => r.label.startsWith("stress")) ?? results.find((r) => r.label === "user") ?? results[0];
const rows = [["plan", "$/mo", "revenue $ per 1M req", "cost $ per 1M req (" + costRef.label + ")", "margin per 1M req", "cost of the full quota", "margin at full quota"]];
for (const [plan, p] of Object.entries(PLANS)) {
  const reqs = p.included / mixCredits;
  const rev = p.price ? (p.price / reqs) * 1e6 : 0;
  const quotaCost = (reqs / 1e6) * costRef.per1M;
  rows.push([plan, p.price, rev.toFixed(3), costRef.per1M.toFixed(3), (rev - costRef.per1M).toFixed(3), quotaCost.toFixed(2), (p.price - quotaCost).toFixed(2)]);
}
console.log("\n" + table(rows));
const md = [`# Cost of run ${DIR.split("/").pop()}`, "", "Cloudflare metrics per run window (sampled, with a 30s tail). Prices: Workers $0.30/M requests and $0.02/M CPU-ms, Durable Objects $0.15/M requests and $12.50/M GB-s plus SQL rows, R2 $0.36/M Class B and $4.50/M Class A.", "", "Service-binding and RPC calls between Workers are not billed as requests (their CPU is), so only the RPC Worker's edge requests count. Per-request units are divided by the client's request count; other traffic in the window (dashboards, other clients) inflates them.", "", "| window | client req | rpc req/req | live calls/req | app calls/req | DO req/req | R2 B/req | cpu ms/req | rpc cpu p50/p99 | $ per 1M req | biggest cost |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|"];
for (const r of results) { const top = Object.entries(r.breakdown).sort((a, b) => b[1] - a[1])[0]; md.push(`| ${r.label} | ${r.requests} | ${r.units.rpcReq.toFixed(2)} | ${r.units.liveCalls.toFixed(1)} | ${r.units.appCalls.toFixed(2)} | ${r.units.doReq.toFixed(1)} | ${r.units.r2ClassB.toFixed(1)} | ${r.units.cpuMs.toFixed(1)} | ${(r.scripts[RPC]?.cpuP50 ?? 0).toFixed(1)} / ${(r.scripts[RPC]?.cpuP99 ?? 0).toFixed(1)} ms | ${r.per1M.toFixed(3)} | ${top[0]} ${((top[1] / r.cost) * 100).toFixed(0)}% |`); }
md.push("", "## Margin per plan", "", `Revenue per 1M requests is the plan price over the requests its quota buys at ${mixCredits.toFixed(1)} credits per request (the measured user mix). Cost per 1M requests is the ${costRef.label} window's. Free plans have no revenue: their column is the cost of serving a full quota.`, "", "| " + rows[0].join(" | ") + " |", "|" + rows[0].map(() => "---").join("|") + "|");
for (const r of rows.slice(1)) md.push("| " + r.join(" | ") + " |");
writeFileSync(join(DIR, "cost.md"), md.join("\n") + "\n");
writeFileSync(join(DIR, "cost.json"), JSON.stringify({ windows: results, plans: rows }, null, 1));
console.log(`\nwrote ${join(DIR, "cost.md")}`);
