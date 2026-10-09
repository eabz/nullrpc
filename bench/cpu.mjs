#!/usr/bin/env node
// CPU and wall time per benchmark case from a `wrangler tail` capture. scenario.mjs tags every
// request with `x-nullrpc-bench: <case label>`, and the tail event of each request carries
// `cpuTime` and `wallTime` (ms) with the request headers, so the Worker's own CPU time can be
// grouped by case: what the platform bills, as opposed to the latency the client sees.
//
//   cd apps/rpc && bunx wrangler tail nullrpc-rpc-560048 --format json --method POST > tail.json
//   node bench/scenario.mjs --chain 560048 --phase calls            (meanwhile)
//   node bench/cpu.mjs tail.json [--json FILE] [--match <regex>]
//
// Requests without the tag (other clients during the capture) are grouped as "(untagged)".

import { readFileSync, writeFileSync } from "node:fs";
import { fmtMs, parseArgs, percentile, table } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const file = args._[0];
if (!file) throw new Error("usage: node bench/cpu.mjs <tail.json> [--json FILE] [--match regex]");
const match = args.match ? new RegExp(String(args.match)) : null;

/** The tail prints one pretty-printed JSON object per event; objects start at column 0. */
function* events(text) {
  let buffer = [];
  for (const line of text.split("\n")) {
    buffer.push(line);
    if (line === "}") {
      try {
        yield JSON.parse(buffer.join("\n"));
      } catch {}
      buffer = [];
    }
  }
}

const groups = new Map();
let total = 0;
for (const e of events(readFileSync(String(file), "utf8"))) {
  if (typeof e.cpuTime !== "number") continue;
  const label = e.event?.request?.headers?.["x-nullrpc-bench"] ?? "(untagged)";
  if (match && !match.test(label)) continue;
  total++;
  const g = groups.get(label) ?? { cpu: [], wall: [], outcomes: {} };
  g.cpu.push(e.cpuTime);
  g.wall.push(e.wallTime ?? 0);
  g.outcomes[e.outcome] = (g.outcomes[e.outcome] ?? 0) + 1;
  groups.set(label, g);
}

const rows = [["case", "n", "cpu p50", "cpu p95", "cpu mean", "cpu total", "wall p50", "outcomes"]];
const out = {};
const sum = (a) => a.reduce((x, y) => x + y, 0);
for (const [label, g] of [...groups].sort((a, b) => sum(b[1].cpu) - sum(a[1].cpu))) {
  const cpu = g.cpu.slice().sort((a, b) => a - b);
  const wall = g.wall.slice().sort((a, b) => a - b);
  const mean = sum(cpu) / cpu.length;
  out[label] = { n: cpu.length, cpuP50: percentile(cpu, 50), cpuP95: percentile(cpu, 95), cpuMean: mean, cpuTotal: sum(cpu), wallP50: percentile(wall, 50), outcomes: g.outcomes };
  rows.push([label, cpu.length, fmtMs(percentile(cpu, 50)), fmtMs(percentile(cpu, 95)), fmtMs(mean), fmtMs(sum(cpu)), fmtMs(percentile(wall, 50)), Object.entries(g.outcomes).map(([k, v]) => `${k}=${v}`).join(" ")]);
}
const all = [...groups.values()].flatMap((g) => g.cpu).sort((a, b) => a - b);
console.log(`${total} requests in the capture; CPU mean ${fmtMs(sum(all) / (all.length || 1))}, p50 ${fmtMs(percentile(all, 50))}, p95 ${fmtMs(percentile(all, 95))}\n`);
console.log(table(rows));
if (args.json) writeFileSync(String(args.json), JSON.stringify(out, null, 1));
