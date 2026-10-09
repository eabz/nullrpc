# Milestone: Hoodi, 2026-10-09 15:33 UTC

The reference run after the day's work: archive reader fixes, compaction (generation 176),
edge caches, in-process execution with a hard budget and prefetching, head snapshot and live
block records in R2, bounded eth_getLogs. Keyed (internal plan). Tables: report.md; Cloudflare
metrics and plan margins: cost.md; a second stress-only pass: stress-rerun/.

## Calls (67 cases × 8)

Every case answered on every repeat; the only non-answers are refusals the API documents
(reverts when replaying at latest, log ranges over 10,000 logs).

| class | typical p50 | slowest |
|---|---|---|
| normal, head | 50 to 270ms | eth_call balanceOf 537ms |
| heavy, head | blocks and receipts 100 to 170ms; tracers 320 to 920ms | 1,000-block Transfer logs 2.97s; eth_estimateGas real calldata p95 23s |
| deep, archive | 110 to 570ms, edge cache up to 38% | eth_getTransactionByHash 566ms |
| deep-heavy | blocks and receipts 95 to 145ms; tracers 500ms to 1.1s | 1,000-block logs 1.29s; trace_replayTransaction p95 2.2s |

Against the morning run (bench history on main before this commit): real-calldata eth_call
2.8s to 0.7s; eth_estimateGas timeouts gone; wide logs no longer fail; deep reads 2 to 5× faster.

## Wallet user (25 users, 60s)

150 sessions, 150 clean. Median session 10.7s (was 16s). Every step under 0.5s at the median
except transfer history (eth_getLogs, 1.58s).

## Throughput

Three stress passes from one laptop within 15 minutes:

| pass | builder (250 rps) | growth (1,000) | scale (3,000) |
|---|---|---|---|
| 15:30, standalone | 228 req/s, 0 errors, p50 204ms | 322 req/s, 0.03%, p50 1.3s | 381 req/s, 0.02%, p50 887ms |
| 15:38, in the full run | 76 req/s, 9% "fetch failed" (client) | 239 req/s, 2.2% | 138 req/s, 0.5% |
| 15:41, stress-rerun | 103 req/s, 0.3% | 133 req/s, 0.3% | 50 req/s, 0.3% |

The decline is the client: during the third pass a third-party node, the static landing page and
the app each took 1.2 to 2.7s from this machine while the Worker's own wall time per request was
230 to 550ms (3 to 18ms CPU). The uplink did not recover between passes. The first pass is the
valid one: at the Builder rate the endpoint serves 228 req/s with no errors and a 204ms median,
where the morning run managed 30 req/s with 6.8% errors and an 11s median. Growth and Scale rates
exceed what one residential client can generate; measure them from a host with a real uplink.
The only server-side errors across all passes were execution time budgets (-32005) and, in the
full run's growth stage, 184 "state could not be read", which points at the state shards as the
next ceiling above about 250 req/s.

## Cost (Cloudflare metrics, cost.md)

| window | live calls/req | DO req/req | R2 reads/req | CPU ms/req | $ per 1M req |
|---|---:|---:|---:|---:|---:|
| wallet user (2,023 req) | 1.6 (was 10.8) | 3.4 (was 11.1) | 0.9 | 198 | 5.96 |
| stress growth (10,800 req) | 1.7 | 3.3 | 0.5 | 162 | 4.43 |
| stress scale (6,115 req) | 1.0 | 1.9 | 0.3 | 88 | 2.49 |

Revenue stays $0.64 to $0.69 per 1M requests at 21.7 credits per request. Cost on the largest
window is $4.43 per 1M requests, down from $6.98 on the wallet mix this morning, with the DO and
live-call lines now near the predecessor's. Workers CPU is now 65 to 73% of cost: 90 to 200ms
per request averaged over the mix, almost all of it execution (balanceOf calls dominate the
wallet mix). That is the remaining gap to a viable margin: at $0.02 per million CPU-ms, 200ms per
request alone is $4 per 1M requests against $0.65 of revenue. Either execution CPU falls by an
order of magnitude (compile-once is in; the per-call cost is now the EVM work and JSON) or
execution methods are priced by their measured CPU.

## Next

1. Execution CPU per call: profile a balanceOf (should be a few ms of EVM) and remove the fixed per-call overhead; price eth_call and tracers by measured CPU if it stays.
2. A benchmark client with a real uplink for the Growth and Scale rates; then the state shards.
3. WebAssembly zstd (in flight) for deep log and block decoding; batched live-window reads for logs.
