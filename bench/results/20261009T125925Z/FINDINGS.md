# Findings: Hoodi benchmark 2026-10-09T12:59Z

Keyed run (internal plan), after the day's fixes: archive key and format reader, compaction
(generation 88 to 168 during the day), edge cache, in-process execution, live head in R2.
Full tables: report.md; Cloudflare metrics and the cost model: cost.md.

## Latency and success

| class | typical | worst cases |
|---|---|---|
| normal (cheap, head) | 55 to 300ms, all succeed | eth_call balanceOf 0.6s |
| heavy (expensive, head) | blocks and receipts 90 to 110ms | wide logs 0.5 to 17s with 25 to 545 R2 reads and HTTP 503 under load; real-calldata eth_call p50 0.7s but p95 25s (timeouts); eth_estimateGas p50 4.6s; trace_call p95 19s |
| deep (cheap, archive) | 75 to 710ms, all succeed, 0 to 9 R2 reads | hash lookups and balances at 0.5 to 0.7s |
| deep-heavy | blocks and receipts 70 to 100ms (edge cache) | 1,000-block logs 12s and 6 of 8 HTTP 503; replays at n-1 p50 2 to 3s |
| wallet user (25 users) | every step under 0.7s at the median | transfer-history eth_getLogs 4s p50, 7 failures; a 15-step session 16s p50 |

## Throughput

| plan rate | achieved | p50 | p99 | errors |
|---|---:|---:|---:|---:|
| free, 20 req/s | 14 | 231ms | 6.4s | 0 |
| builder, 250 req/s | 30 | 11.4s | 40s | 6.8% (timeouts, HTTP 503) |
| growth, 1,000 req/s | 47 | 2.0s | 40s | 35% (`internal error`) |

The `internal error`s are "Durable Object is overloaded. Requests queued for too long." from the
live Worker's single ChainDO, reached through Live.block by every head-dependent call (latest
block, gas price, fee history, eth_call at latest, recent receipts). A controlled 150 req/s
burst reproduced it: 30% of calls failed. The platform's ceiling for the user mix is therefore
about 30 to 50 req/s today, below the Builder plan's cap.

## Cost per request (Cloudflare metrics, sampled; small windows include other traffic)

| window | live calls/req | DO req/req | R2 reads/req | CPU ms/req | $ per 1M req | biggest line |
|---|---:|---:|---:|---:|---:|---|
| calls (all classes) | 19.0 | 18.0 | 14.6 | 588 | 23.48 | Workers CPU 50% |
| wallet user | 10.8 | 11.1 | 0.5 | 192 | 6.98 | Workers CPU 55%, DO 37% |
| stress growth (largest sample) | 6.3 | 5.3 | 0.4 | 103 | 3.54 | Workers CPU 58%, DO 29% |

Revenue per 1M requests at 20.3 credits per request: Builder $0.64, Growth $0.60, Scale $0.61
(every plan prices credits at about $0.03 per million). Cost per 1M requests on the wallet mix
is about $7, so serving a paid customer's full quota costs roughly 10 times what it earns:
Builder's 600M credits cost about $200 to serve against $19.

Two lines make the gap. Workers CPU: in-process execution spends 100 to 600ms of CPU per
request averaged over the mix (WebAssembly instantiation per request and long calls). Durable
Objects: 5 to 11 DO requests per client request (live state and block reads per key, per round,
plus SQL rows), where the predecessor project measured 0.5. R2 reads are already cheap thanks
to the edge cache (2 to 4% of cost outside the archive-heavy class).

The predecessor measured $0.75 to $1.24 per 1M requests on the same hostname with the same
plan prices, so the price list is not the problem; the per-request fan-out is. Getting DO
requests to about 1 per request and CPU to tens of milliseconds brings cost under revenue.

## Follow-ups proposed

1. Live block records in R2 through the edge cache, ChainDO off the read path (throughput and DO cost).
2. eth_getLogs read budget and batching for wide ranges (no HTTP 503, seconds to sub-second).
3. Execution: witness prefetch, one WebAssembly compile per isolate, estimateGas reuse (latency and CPU cost).
