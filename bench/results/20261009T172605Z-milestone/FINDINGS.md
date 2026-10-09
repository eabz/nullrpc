# Milestone: Hoodi, 2026-10-09 17:26 UTC

The reference run after the full day: archive reader fixes, compaction, edge caches, in-process
execution with a hard budget and prefetching, head snapshot and live block records in R2,
bounded eth_getLogs, zstd and log extraction in WebAssembly. Keyed (internal plan). Stress stages
ran first on a fresh client uplink, then calls and the user scenario. Tables: report.md and
stress/report.md; Cloudflare metrics and plan margins: cost.md in each.

## Against the previous milestone (15:33 UTC, before the WebAssembly frame work)

| measure | 15:33 | 17:26 |
|---|---:|---:|
| eth_call, real calldata, p50 | 695ms | 383ms |
| eth_getLogs 1,000 blocks Transfer topic, head, p50 | 2.97s | 1.45s |
| eth_getLogs 1,000 blocks deep, p50 | 1.29s | 484ms |
| wallet session, p50 | 10.7s | 9.2s |
| transfer history step (eth_getLogs), p50 | 1.58s | 957ms |
| CPU per request, wallet mix | 198ms | 65ms |
| cost per 1M requests, wallet mix | $5.96 | $2.15 |
| cost per 1M requests, largest window | $4.43 | $1.73 |

## Calls (67 cases × 8)

Every case answered on every repeat except documented refusals. Head reads 50 to 350ms; deep
reads 80 to 500ms with the edge cache answering up to 100% of repeats; all twelve execution
methods 0.3 to 1.6s at the median, worst p95 3.6s. Remaining tails: one keccak-walking contract
puts real-calldata eth_call at p95 23s (the 25s budget, answered as -32005), and
debug_traceCall on it at 9s.

## Wallet user (25 users, 60s)

159 sessions, 154 clean; the five failures are balanceOf calls that hit the 25s budget on the
same slow contract. Every step is under 0.45s at the median; transfer history is the slowest at
957ms.

## Throughput (stress first, fresh uplink, one laptop)

| plan rate | achieved | p50 | p95 | errors |
|---|---:|---:|---:|---|
| free, 20 | 13 req/s | 155ms | 956ms | 2 budget timeouts |
| builder, 250 | 97 req/s | 299ms | 6.3s | 1 (0.02%) |
| growth, 1,000 | 191 req/s | 165ms | 10.8s | 427 (5%): 325 "state could not be read", 84 internal |
| scale, 3,000 | 231 req/s | 179ms | 6.4s | 33 (0.25%), budget timeouts |

One residential client cannot generate the Growth and Scale rates (tens of thousands of sends
dropped at its in-flight cap), so "achieved" above about 100 req/s is a client number. The
server-side signal is consistent across today's passes: above roughly 200 req/s the live state
shards start refusing reads ("state could not be read"), which is the next ceiling. Builder-rate
traffic is served with a 300ms median and near-zero errors.

## Cost (Cloudflare metrics)

| window | live calls/req | DO req/req | R2 reads/req | CPU ms/req | $ per 1M req |
|---|---:|---:|---:|---:|---:|
| wallet user (2,207 req) | 1.0 | 2.1 | 0.3 | 65 | 2.15 |
| stress builder (4,727) | 3.0 | 6.0 | 0.9 | 217 | 6.61 |
| stress growth (8,609) | 2.4 | 4.6 | 0.5 | 158 | 4.91 |
| stress scale (13,456) | 0.8 | 1.6 | 0.2 | 53 | 1.73 |

Revenue is $0.62 to $0.66 per 1M requests at about 21 credits per request. On the wallet mix the
cost is $2.15 per 1M, down from $6.98 this morning; the gap to a positive margin is now about
3× rather than 10×. Workers CPU is still 60 to 66% of cost. Live calls and Durable Object
requests per request are at the predecessor's levels (about 1 and 2).

## Next

1. Execution CPU per call is the remaining margin gap: profile a balanceOf end to end (the EVM work is a few ms) and price execution methods by measured CPU if the fixed overhead cannot drop further.
2. The state shards above ~200 req/s: batch and cache live state reads per block hash, or shard wider.
3. A benchmark client with a real uplink, from at least one other region, for the Growth and Scale rates.
4. Wide log queries: receipts in their own pack (format change) or CPU-based pricing for ranges over 100 blocks.
