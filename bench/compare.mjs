#!/usr/bin/env node
// Side-by-side comparison of two scenario runs (two chains, or before/after), with prices:
// per case the successful-answer p50, the Worker's R2 misses per call, execution rounds and
// live reads from the x-nullrpc-exec header, the credits charged and their revenue, and from
// each run's cost pull (bench/cost.mjs, cost.json beside report.json) the measured cost per
// million requests of the windows.
//
//   node bench/compare.mjs <dirA> <dirB> [--label-a Hoodi] [--label-b Ethereum] [--out FILE.md]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fmtMs, parseArgs, percentile } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const [A, B] = args._;
if (!A || !B) throw new Error("usage: compare.mjs <dirA> <dirB>");
const LA = String(args["label-a"] ?? A.split("/").pop());
const LB = String(args["label-b"] ?? B.split("/").pop());
const CREDIT_USD_PER_M = 0.03;

function load(dir) {
  const r = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
  const cost = existsSync(join(dir, "cost.json")) ? JSON.parse(readFileSync(join(dir, "cost.json"), "utf8")) : null;
  const stressCost = existsSync(join(dir, "stress", "cost.json")) ? JSON.parse(readFileSync(join(dir, "stress", "cost.json"), "utf8")) : null;
  const stress = existsSync(join(dir, "stress", "report.json")) ? JSON.parse(readFileSync(join(dir, "stress", "report.json"), "utf8")) : null;
  const cases = {};
  for (const s of r.samples.calls) {
    const c = (cases[s.label] ??= { cls: s.cls, n: 0, ok: 0, refused: 0, ms: [], r2: [], rounds: [], live: [], credits: s.credits });
    c.n++;
    if (s.ok) {
      c.ok++;
      c.ms.push(s.ms);
    } else if (s.refused) c.refused++;
    const m = /hit=(\d+) miss=(\d+)/.exec(s.archive ?? "");
    if (m) c.r2.push(Number(m[2]));
    const e = /rounds=(\d+) keys=\d+ hints=\d+ live=(\d+) archive=\d+/.exec(s.exec ?? "");
    if (e) {
      c.rounds.push(Number(e[1]));
      c.live.push(Number(e[2]));
    }
  }
  for (const c of Object.values(cases)) c.ms.sort((x, y) => x - y);
  const user = r.samples.user.filter((s) => s.step === "session" && s.complete !== false);
  return { r, cost, stressCost, stress, cases, user };
}
const a = load(A);
const b = load(B);
const med = (xs) => (xs.length ? [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] : null);
const f = (x, d = 1) => (x === null || x === undefined ? "-" : Number(x).toFixed(d));

const md = [];
md.push(`# ${LA} vs ${LB}`, "", `${LA}: ${A}  ${LB}: ${B}`, "", "Per case: successful-answer p50, R2 misses per call, execution rounds and live reads (median), credits and their revenue at $0.03 per million credits. ok/n counts successes; refusals (reverts, over-wide ranges) are neither errors nor timed.", "");
for (const cls of ["normal", "heavy", "deep", "deep-heavy"]) {
  md.push(`## ${cls}`, "", `| case | credits | $ rev / 1M | ${LA} ok/n | p50 | R2 | rounds | live | ${LB} ok/n | p50 | R2 | rounds | live |`, "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  const labels = [...new Set([...Object.keys(a.cases), ...Object.keys(b.cases)])].filter((l) => (a.cases[l] ?? b.cases[l]).cls === cls);
  for (const l of labels) {
    const x = a.cases[l];
    const y = b.cases[l];
    const cell = (c) => (c ? `${c.ok}/${c.n} | ${fmtMs(percentile(c.ms, 50))} | ${f(med(c.r2))} | ${f(med(c.rounds), 0)} | ${f(med(c.live), 0)}` : "- | - | - | - | -");
    const credits = (x ?? y).credits;
    md.push(`| ${l} | ${credits} | ${(credits * CREDIT_USD_PER_M).toFixed(2)} | ${cell(x)} | ${cell(y)} |`);
  }
  md.push("");
}
md.push("## Wallet user", "", `| | ${LA} | ${LB} |`, "|---|---:|---:|");
md.push(`| complete sessions | ${a.user.length} | ${b.user.length} |`);
md.push(`| clean sessions | ${a.user.filter((s) => s.ok).length} | ${b.user.filter((s) => s.ok).length} |`);
md.push(`| session p50 | ${fmtMs(percentile(a.user.map((s) => s.ms).sort((x, y) => x - y), 50))} | ${fmtMs(percentile(b.user.map((s) => s.ms).sort((x, y) => x - y), 50))} |`, "");
if (a.stress && b.stress) {
  md.push("## Throughput (stress stages, one client)", "", `| stage | ${LA} achieved | p50 | p99 | errors | ${LB} achieved | p50 | p99 | errors |`, "|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const sa of a.stress.stress) {
    const sb = b.stress.stress.find((s) => s.plan === sa.plan);
    const cell = (s) => (s ? `${s.achieved.toFixed(0)} req/s | ${fmtMs(s.p50)} | ${fmtMs(s.p99)} | ${s.err} (${s.errRate.toFixed(1)}%)` : "- | - | - | -");
    md.push(`| ${sa.plan} (${sa.target} rps) | ${cell(sa)} | ${cell(sb)} |`);
  }
  md.push("");
}
md.push("## Cost per 1M requests (Cloudflare metrics per window)", "", `| window | ${LA} $ | live/req | DO/req | R2/req | CPU ms/req | ${LB} $ | live/req | DO/req | R2/req | CPU ms/req |`, "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
const windows = (x) => [...(x.cost?.windows ?? []), ...(x.stressCost?.windows ?? [])];
for (const wa of windows(a)) {
  const wb = windows(b).find((w) => w.label === wa.label);
  const cell = (w) => (w ? `${w.per1M.toFixed(2)} | ${w.units.liveCalls.toFixed(1)} | ${w.units.doReq.toFixed(1)} | ${w.units.r2ClassB.toFixed(1)} | ${w.units.cpuMs.toFixed(0)}` : "- | - | - | - | -");
  md.push(`| ${wa.label} | ${cell(wa)} | ${cell(wb)} |`);
}
md.push("", "Revenue per 1M requests at the measured credits per request is $0.62 to $0.69 on every paid plan; a window above that loses money per request.", "");
const out = md.join("\n");
if (args.out) writeFileSync(String(args.out), out);
console.log(out);
