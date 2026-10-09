#!/usr/bin/env node
// CPU profile of the RPC Worker under `wrangler dev`, through the inspector protocol: starts
// V8's sampling profiler in the Worker, sends the same JSON-RPC request N times, stops, and
// prints where the CPU went (self time by function, and by file), plus the Worker's own wall
// time per request. Needs the dev server's inspector (apps/rpc/wrangler.profile.jsonc):
//
//   cd apps/rpc && bunx wrangler dev --config wrangler.profile.jsonc --port 8799 --inspector-port 9230
//   node bench/profile-worker.mjs --call '{"method":"eth_call","params":[{"to":"0x…","data":"0x…"},"latest"]}' [--n 30] [--url http://127.0.0.1:8799] [--inspector http://127.0.0.1:9230] [--out FILE.cpuprofile] [--warm 3]
//   node bench/profile-worker.mjs --cases <rounds.mjs cases file> [--index 0] …
//
// The Worker's own clock runs normally under workerd on this machine, so the numbers are the
// code's cost, not the edge's; absolute values differ from production by the CPU in question.

import { writeFileSync } from "node:fs";
import { parseArgs } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const URL_ = String(args.url ?? "http://127.0.0.1:8799");
const INSPECTOR = String(args.inspector ?? "http://127.0.0.1:9230");
const N = Number(args.n ?? 30);
const WARM = Number(args.warm ?? 3);
// `--cases FILE [--index I]`: a case of a rounds.mjs cases file instead of `--call`.
let call;
if (args.cases) {
  const { readFileSync } = await import("node:fs");
  const c = JSON.parse(readFileSync(String(args.cases), "utf8"))[Number(args.index ?? 0)];
  call = { method: c.method, params: c.params };
  console.log(`case: ${c.label}`);
} else if (args.call) call = JSON.parse(String(args.call));
else throw new Error("--call '{\"method\":…,\"params\":[…]}' or --cases FILE is required");

const targets = await (await fetch(`${INSPECTOR}/json`)).json();
const target = targets.find((t) => t.webSocketDebuggerUrl);
if (!target) throw new Error("no inspector target at " + INSPECTOR);
// wrangler's inspector proxy wants an Origin from a client that sends a User-Agent (Node does).
const ws = new WebSocket(target.webSocketDebuggerUrl, { headers: { Origin: "http://localhost" } });
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
// Replies keep our ids (the proxy adds the command's `method` to them and interleaves its own
// traffic under ids above 100000000).
let nextId = 1;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (args.debug) console.error(`<- ${String(m.data).slice(0, 160)}`);
  // The proxy answers with the command's method and `params` where the protocol says `result`.
  if (msg.result === undefined && msg.error === undefined && msg.method && msg.params !== undefined && pending.has(msg.id)) msg.result = msg.params;
  if (msg.id !== undefined && pending.has(msg.id) && (msg.result !== undefined || msg.error !== undefined)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const cdp = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });

let rpcId = 1;
async function send() {
  const t0 = performance.now();
  const res = await fetch(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, ...call }) });
  const body = await res.json();
  return { ms: performance.now() - t0, exec: res.headers.get("x-nullrpc-exec"), error: body.error };
}

for (let i = 0; i < WARM; i++) {
  const r = await send();
  if (r.error) console.log(`warm-up answered an error: ${JSON.stringify(r.error).slice(0, 160)}`);
  else if (!r.exec) console.log(`warm-up answered without x-nullrpc-exec (no execution happened)`);
}
await cdp("Profiler.enable");
await cdp("Profiler.setSamplingInterval", { interval: 100 });
await cdp("Profiler.start");
const wall = [];
let exec = null;
for (let i = 0; i < N; i++) {
  const r = await send();
  wall.push(r.ms);
  exec = r.exec;
}
const { profile } = await cdp("Profiler.stop");
ws.close();
if (args.out) writeFileSync(String(args.out), JSON.stringify(profile));

// Self time per node from the sample stream.
const self = new Map();
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
for (let i = 0; i < profile.samples.length; i++) self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0));
const total = [...self.values()].reduce((a, b) => a + b, 0) / 1000;
const byFunction = new Map();
const byFile = new Map();
for (const [id, us] of self) {
  const n = byId.get(id);
  const f = n.callFrame;
  const file = (f.url || "(native)").replace(/^.*\/(apps|packages)\//, "$1/").replace(/\?.*$/, "");
  const name = `${f.functionName || "(anonymous)"} ${file}:${f.lineNumber + 1}`;
  byFunction.set(name, (byFunction.get(name) ?? 0) + us);
  byFile.set(file, (byFile.get(file) ?? 0) + us);
}
const top = (m, k) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k);
wall.sort((a, b) => a - b);
console.log(`${N} requests; client wall p50 ${wall[Math.floor(N / 2)].toFixed(0)}ms; last x-nullrpc-exec: ${exec}`);
console.log(`profiled CPU ${total.toFixed(1)}ms total, ${(total / N).toFixed(2)}ms per request (sampled at 100µs)\n`);
console.log("by file (ms per request):");
for (const [file, us] of top(byFile, 15)) console.log(`  ${(us / 1000 / N).toFixed(2).padStart(7)}  ${file}`);
console.log("\nby function (ms per request, self time):");
for (const [name, us] of top(byFunction, 30)) console.log(`  ${(us / 1000 / N).toFixed(2).padStart(7)}  ${name}`);
process.exit(0);
