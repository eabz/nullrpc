// Once-per-block cost: waits for the head to move, sends the call (cold for that block in this
// isolate), then the same call again (warm), for --n blocks. Prints each pair and the medians.
//   node probe.mjs --url http://127.0.0.1:8799 --report <report.json> --label "eth_call balanceOf" [--n 8] [--key nr_]
import { readFileSync } from "node:fs";
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : null)).filter(Boolean));
const base = args.url ?? "http://127.0.0.1:8799";
const url = args.key ? `${base.replace(/\/$/, "")}/${args.key}` : base;
const N = Number(args.n ?? 8);
let call;
if (args.report) {
  const r = JSON.parse(readFileSync(args.report, "utf8"));
  const s = r.samples.calls.find((s) => s.label === args.label && s.ok);
  if (!s) throw new Error("no ok sample for " + args.label);
  call = { method: s.method, params: s.params };
} else call = JSON.parse(args.call);
let id = 1;
async function rpc(method, params) {
  const t0 = performance.now();
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-nullrpc-bench": `probe ${args.label ?? method}` }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }) });
  const body = await res.json();
  return { ms: performance.now() - t0, exec: res.headers.get("x-nullrpc-exec"), archive: res.headers.get("x-nullrpc-archive-cache"), error: body.error?.message ?? null, result: body.result };
}
const head = async () => Number((await rpc("eth_blockNumber", [])).result);
let last = await head();
const cold = [], warm = [];
console.log(`call ${call.method} ${JSON.stringify(call.params).slice(0, 80)}…; ${N} blocks`);
console.log("block | cold ms | warm ms | cold exec | cold archive-cache | error");
while (cold.length < N) {
  await new Promise((r) => setTimeout(r, 500));
  const h = await head();
  if (h === last) continue;
  last = h;
  const a = await rpc(call.method, call.params);
  const b = await rpc(call.method, call.params);
  cold.push(a.ms); warm.push(b.ms);
  console.log(`${h} | ${a.ms.toFixed(0)} | ${b.ms.toFixed(0)} | ${a.exec} | ${a.archive} | ${a.error ?? ""}`);
}
const med = (xs) => { const s = [...xs].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log(`cold: p50 ${med(cold).toFixed(0)}ms mean ${mean(cold).toFixed(0)}ms; warm: p50 ${med(warm).toFixed(0)}ms mean ${mean(warm).toFixed(0)}ms`);
