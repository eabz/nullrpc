// Heavy-plus-cheap loop against one endpoint: debug_traceBlockByNumber (callTracer) for one
// block, back to back `--heavy` times, while eth_chainId is sent every `--interval` ms. Reports
// every cheap call that failed or took long, with the heavy call it overlapped. Reproduces the
// workerd cancellation ("the Workers runtime canceled this request because it detected that
// your Worker's code had hung") that a request awaiting another request's promise triggers.
//
//   node bench/blocking.mjs --url http://127.0.0.1:8799 [--block 0x…] [--heavy 3] [--interval 50]

import { parseArgs, rpc } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const url = args.url ?? "http://127.0.0.1:8799";
const heavyCount = Number(args.heavy ?? 3);
const interval = Number(args.interval ?? 50);
const slowMs = Number(args.slow ?? 500);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// With --block the worker is not touched before the loop: the first heavy call then finds the
// isolate's caches cold (the case the cancellation was seen in). Each heavy call traces its own
// block (block, block-1, ...), so every one is a response-cache miss.
let first;
if (args.block) first = Number(args.block);
else {
  const latest = await rpc(url, "eth_blockNumber");
  if (!latest.ok) throw new Error(`eth_blockNumber: ${JSON.stringify(latest.error)}`);
  first = Number(latest.result) - 2;
}
console.log(`target ${url}, blocks ${first} down to ${first - heavyCount + 1}, a cheap call every ${interval} ms`);

let failures = 0;
let cheapTotal = 0;
for (let i = 0; i < heavyCount; i++) {
  const t0 = performance.now();
  let heavyDone = false;
  const block = "0x" + (first - i).toString(16);
  const heavy = rpc(url, "debug_traceBlockByNumber", [block, { tracer: "callTracer" }], { timeoutMs: 120_000 }).then((r) => {
    heavyDone = true;
    return r;
  });
  const cheap = [];
  const pending = [];
  while (!heavyDone) {
    const at = performance.now() - t0;
    pending.push(rpc(url, "eth_chainId", [], { timeoutMs: 30_000 }).then((r) => cheap.push({ at, ...r })));
    await sleep(interval);
  }
  const h = await heavy;
  await Promise.all(pending);
  cheapTotal += cheap.length;
  const bad = cheap.filter((c) => !c.ok || c.ms > slowMs);
  failures += cheap.filter((c) => !c.ok).length;
  const sorted = cheap.map((c) => c.ms).sort((a, b) => a - b);
  const pct = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(0) : "-");
  console.log(`heavy #${i + 1} (${Number(block)}): ${h.ok ? "ok" : "FAILED " + JSON.stringify(h.error).slice(0, 160)} in ${h.ms.toFixed(0)} ms; ${cheap.length} cheap calls (p50 ${pct(0.5)} p90 ${pct(0.9)} max ${pct(1)} ms), ${bad.length} failed or slow`);
  for (const c of bad) console.log(`  cheap at +${c.at.toFixed(0)} ms: http ${c.http} in ${c.ms.toFixed(1)} ms ${c.ok ? "" : JSON.stringify(c.error).slice(0, 220)}`);
}
console.log(`${failures} of ${cheapTotal} cheap calls failed`);
process.exitCode = failures ? 1 : 0;
