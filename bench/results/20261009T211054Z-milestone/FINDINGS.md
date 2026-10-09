# Milestone: Hoodi, 2026-10-09 21:10 UTC

After the full day's work, with the daemon on the receipts-pack writer (first layout-2 segment
at generation 200) and the last Worker change, hints and witnesses shared per data center through
the edge cache, deployed at 19:48. Keyed; stress first on a fresh uplink, then calls and the user
scenario; cost pulls five minutes later. Tables: report.md, stress/report.md, cost.md in each.

## Throughput: the first run where the plan rates are served

| plan rate | achieved | p50 | p95 | p99 | errors |
|---|---:|---:|---:|---:|---|
| free, 20 | 21 req/s | 100ms | 1.0s | 1.6s | 0 |
| builder, 250 | 248 req/s | 78ms | 1.3s | 2.0s | 0 |
| growth, 1,000 | 564 req/s | 75ms | 821ms | 3.2s | 1 budget timeout |
| scale, 3,000 | 1,630 req/s | 73ms | 601ms | 6.3s | 0, plus 2,121 (4.8%) 429s |

The Builder rate is served in full with no errors and a 78ms median, where the first run of the
day managed 30 req/s with 6.8% errors and an 11s median. Growth and Scale are bounded by the
client (2,500 and 18,400 sends dropped at its in-flight cap), not the endpoint. The 429s at the
Scale stage carry the plan limiter's message on an internal-plan key: at that request rate the
RPC Worker's ledger falls back to the Free plan's per-location limit when its lease calls to the
account app degrade. Not a capacity problem, but a customer on Scale would be refused the same
way; the ledger should keep the last known plan on a lease error.

## Wallet user (25 users, 60s)

175 sessions, 175 clean. Median session 8.8s; balanceOf 159ms and 82ms, estimateGas 311ms,
transfer history 881ms.

## Calls

All 67 cases answer on every repeat. The tails improved: no 25s budget hits this run (worst
15.7s on the keccak-walking contract, 22.8s on one trace_call p95). Medians for execution moved
the other way against 19:36 (balanceOf 542ms vs 426ms, historical replays 626ms vs 128ms,
trace_call 2.2s vs 508ms); the two differences since are the per-data-center hints sharing and
colder caches after the 19:48 deploy, and the execution session should check which. Reads are
unchanged: deep block 173ms, deep receipt 614ms, deep balance 366ms.

## Cost

| window | live calls/req | DO req/req | R2 B/req | CPU ms/req | $ per 1M req |
|---|---:|---:|---:|---:|---:|
| wallet user (2,540 req) | 0.3 | 0.7 | 0.4 | 42 | 1.50 |
| stress builder (5,250) | 0.4 | 0.9 | 0.5 | 51 | 2.71 |
| stress growth (18,489) | 0.3 | 0.5 | 0.3 | 29 | 1.79 |
| stress scale (44,564) | 0.1 | 0.2 | 0.1 | 8.4 | 0.52 |

Revenue is $0.62 to $0.66 per 1M requests. The largest window is under it ($0.52: Builder +$0.14,
Growth +$0.09, Scale +$0.10 per 1M); the wallet mix at $1.50 is still above, with CPU 60% of it.

## Day summary (first run 12:59 UTC to now)

| | 12:59 | 21:10 |
|---|---:|---:|
| builder rate | 30 req/s, 6.8% errors, p50 11.4s | 248 req/s, 0 errors, p50 78ms |
| eth_call real calldata p50 | 2.8s, timeouts | 1.7s, no timeouts |
| wallet session p50 | 16s, 7 failures | 8.8s, 0 failures |
| cost per 1M requests, wallet mix | $6.98 | $1.50 |
| cost per 1M requests, largest window | $4.43 | $0.52 |

## Next

1. Ledger fallback under load: keep the granted plan when a lease renewal fails (the Scale-stage 429s).
2. Execution medians: find what moved them between 19:36 and 21:10.
3. A benchmark client with a real uplink for the Growth and Scale rates.
4. Price execution and wide-log methods by measured CPU, or cap the walker-style calls earlier.
