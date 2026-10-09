# Milestone: Hoodi, 2026-10-09 19:36 UTC

After the second round of work: head-tier response cache, per-isolate live state cache,
execution module cache (blocks and state kept by hash), receipts-pack reader (writer awaits the
daemon restart). Keyed; stress first on a fresh uplink, then calls and the user scenario; cost
pulls five minutes later. Tables: report.md, stress/report.md, cost.md in each.

## Against the 17:26 milestone

| measure | 17:26 | 19:36 |
|---|---:|---:|
| wallet session, p50 | 9.2s | 8.2s |
| balanceOf eth_call inside a session, p50 | 396ms | 101ms |
| gas price / fee history / latest block, p50 | 56 to 97ms | 90 to 97ms, served from the head tier |
| transfer history (eth_getLogs), p50 | 957ms | 275ms |
| wallet sessions with a failed step | 5 of 159 | 0 of 193 |
| live calls per request, wallet mix | 1.0 | 0.3 |
| DO requests per request, wallet mix | 2.1 | 0.5 |
| CPU per request, wallet mix | 65ms | 33ms |
| cost per 1M requests, wallet mix | $2.15 | $1.14 |
| cost per 1M requests, largest window | $1.73 (13k req) | $0.50 (19k req, scale stage) |
| scale stage (3,000 rps target) | 231 req/s, 0.25% errors | 920 req/s, 0 errors, p50 400ms |

## Calls

All 67 cases answer on every repeat except documented refusals. Deep block 109ms, deep receipt
394ms, deep balance 291ms, deep 1,000-block logs 322ms (was 484ms), historical eth_call replay
128ms (was 846ms), estimateGas replay 162ms (was 936ms). Still slow: the keccak-walking
contract puts real-calldata eth_call, estimateGas and debug_traceCall at the 25s budget once in
eight; 1,000-block Transfer-topic logs at the head 1.77s (the receipts pack will cut this once
the daemon writes new-layout segments).

## Throughput

| plan rate | achieved | p50 | p95 | errors |
|---|---:|---:|---:|---|
| free, 20 | 21 req/s | 107ms | 1.25s | 0 |
| builder, 250 | 111 req/s | 454ms | 10.3s | 6.4%, all client-side "fetch failed" |
| growth, 1,000 | 306 req/s | 502ms | 9.4s | 0.65%, all client-side |
| scale, 3,000 | 920 req/s | 400ms | 1.7s | 0 |

Every error this run was the client's connection failing, none from the endpoint; the Scale
stage, the largest sample, had none. The "state could not be read" errors of earlier runs are
gone with the per-isolate state cache. The achieved rate is still bounded by one laptop.

## Cost and margin

Revenue is $0.62 to $0.66 per 1M requests. On the wallet mix the cost is $1.14, on the scale
window $0.50 with 7.5ms of CPU, 0.1 live calls and 0.1 DO requests per request: the first
window of the day under revenue. The wallet mix is still above it because of its balanceOf and
estimateGas calls (CPU 33ms per request, 60% of its cost); the execution module cache took the
fixed overhead out, so what remains is the EVM work of real calls and the slow contract's tail.

## Next

1. Receipts pack: rebuild and restart the daemon; re-run the log cases after the first promotion.
2. State shards above 300 req/s: measure from a client with a real uplink; the per-isolate cache may already have moved the ceiling.
3. Price execution and wide-log methods by measured CPU, or cap the walker-style calls earlier.
