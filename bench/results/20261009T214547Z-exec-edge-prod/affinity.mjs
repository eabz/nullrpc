// Same call repeated against production: sequentially on one keep-alive connection, then with
// 4 in flight. Prints ms, the exec header and the response-cache header per call, so a warm
// isolate (no header: the module's snapshot; hints=0: the isolate's hints cache) is visible.
//   node affinity.mjs --url https://hoodi.nullrpc.dev --key nr_ --report <report.json>
import { readFileSync, writeFileSync } from "node:fs";
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : null)).filter(Boolean));
const url = `${(args.url ?? "https://hoodi.nullrpc.dev").replace(/\/$/, "")}/${args.key}`;
let id = 1;
async function rpc(method, params, tag) {
  const t0 = performance.now();
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-nullrpc-bench": tag }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }) });
  const body = await res.json();
  return { ms: performance.now() - t0, exec: res.headers.get("x-nullrpc-exec"), resp: res.headers.get("x-nullrpc-response-cache"), err: body.error?.message?.slice(0, 40) ?? "", result: body.result };
}
const show = (tag, r) => console.log(`${tag} | ${r.ms.toFixed(0)}ms | ${r.exec ?? "(no exec header)"} | ${r.resp} | ${r.err}`);
// A deep replay from the report (a failed sample keeps its params), and a balanceOf at latest from recent Transfer logs.
const report = JSON.parse(readFileSync(args.report, "utf8"));
const replay = report.samples.calls.find((s) => s.label === "eth_call replay at n-1" && s.params);
const head = Number((await rpc("eth_blockNumber", [], "affinity head")).result);
const logs = (await rpc("eth_getLogs", [{ fromBlock: "0x" + (head - 30).toString(16), toBlock: "0x" + head.toString(16), topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"] }], "affinity logs")).result ?? [];
const lg = logs.find((l) => l.topics.length === 3);
const balanceOf = lg ? { to: lg.address, data: "0x70a08231" + lg.topics[2].slice(26) } : null;
if (balanceOf) writeFileSync(args.out ?? "balanceOf-call.json", JSON.stringify({ method: "eth_call", params: [balanceOf, "latest"] }));
console.log(`head ${head}; replay ${JSON.stringify(replay?.params).slice(0, 70)}…; balanceOf ${JSON.stringify(balanceOf)}`);
console.log("\n== deep replay, 10 sequential on one connection");
for (let i = 0; i < 10; i++) show(`replay #${i + 1}`, await rpc(replay.method, replay.params, "affinity replay seq"));
console.log("\n== balanceOf latest, 10 sequential on one connection");
for (let i = 0; i < 10; i++) show(`balanceOf #${i + 1}`, await rpc("eth_call", [balanceOf, "latest"], "affinity balanceOf seq"));
console.log("\n== balanceOf latest, 8 with 4 in flight");
const rs = await Promise.all(Array.from({ length: 8 }, () => rpc("eth_call", [balanceOf, "latest"], "affinity balanceOf par")));
rs.forEach((r, i) => show(`balanceOf par #${i + 1}`, r));
