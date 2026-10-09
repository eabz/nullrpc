// Cheap calls while a heavy trace runs on the same endpoint: the heavy call (debug_traceBlockByNumber
// with callTracer at a recent block, repeated back to back, one at a time) and eth_chainId every
// 50 ms for --seconds; prints the cheap calls' p50/p95/p99/max alone and under the trace.
//   node blocking.mjs --url http://127.0.0.1:8799 [--key nr_] [--seconds 30] [--block 0x…]
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : null)).filter(Boolean));
const base = (args.url ?? "http://127.0.0.1:8799").replace(/\/$/, "");
const url = args.key ? `${base}/${args.key}` : base;
const SECONDS = Number(args.seconds ?? 30);
let id = 1;
async function rpc(method, params, tag) {
  const t0 = performance.now();
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-nullrpc-bench": tag }, body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }) });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { error: { message: `HTTP ${res.status}: ${text.slice(0, 60)}` } }; }
  return { ms: performance.now() - t0, exec: res.headers.get("x-nullrpc-exec"), error: body.error?.message ?? null, result: body.result };
}
let cheapErrors = 0;
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const stats = (xs) => `n=${xs.length} p50 ${pct(xs, 50).toFixed(0)} p95 ${pct(xs, 95).toFixed(0)} p99 ${pct(xs, 99).toFixed(0)} max ${Math.max(...xs).toFixed(0)} ms`;
async function cheapFor(seconds, tag) {
  const out = [];
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) {
    const r = await rpc("eth_chainId", [], tag);
    if (r.error) { cheapErrors++; console.log(`cheap error: ${r.error}`); continue; }
    out.push(r.ms);
    await new Promise((r) => setTimeout(r, 50));
  }
  return out;
}
const head = Number((await rpc("eth_blockNumber", [], "blocking head")).result);
const block = args.block ?? "0x" + (head - 3).toString(16);
// Warm the trace once (the block's state into the isolate's caches), then measure.
const warm = await rpc("debug_traceBlockByNumber", [block, { tracer: "callTracer" }], "blocking heavy warm");
console.log(`block ${block}; heavy warm-up ${warm.ms.toFixed(0)}ms ${warm.exec ?? ""} ${warm.error ?? ""}`);
console.log(`cheap alone: ${stats(await cheapFor(SECONDS / 3, "blocking cheap alone"))}`);
let heavy = [];
let stop = false;
const heavyLoop = (async () => { while (!stop) { const r = await rpc("debug_traceBlockByNumber", [block, { tracer: "callTracer" }], "blocking heavy"); heavy.push(r.ms); if (r.error) console.log("heavy error", r.error); } })();
const under = await cheapFor(SECONDS, "blocking cheap under trace");
stop = true;
await heavyLoop;
console.log(`cheap under trace: ${stats(under)}`);
console.log(`heavy: ${stats(heavy)}; cheap errors ${cheapErrors}`);
