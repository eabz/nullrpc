# Cost of run 20261009T172605Z-milestone

Cloudflare metrics per run window (sampled, with a 30s tail). Prices: Workers $0.30/M requests and $0.02/M CPU-ms, Durable Objects $0.15/M requests and $12.50/M GB-s plus SQL rows, R2 $0.36/M Class B and $4.50/M Class A.

Service-binding and RPC calls between Workers are not billed as requests (their CPU is), so only the RPC Worker's edge requests count. Per-request units are divided by the client's request count; other traffic in the window (dashboards, other clients) inflates them.

| window | client req | rpc req/req | live calls/req | app calls/req | DO req/req | R2 B/req | cpu ms/req | rpc cpu p50/p99 | $ per 1M req | biggest cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| calls | 536 | 3.11 | 3.5 | 0.56 | 6.4 | 2.6 | 240.1 | 8.7 / 779.7 ms | 8.613 | Workers CPU 56% |
| user | 2207 | 1.01 | 1.0 | 0.14 | 2.1 | 0.3 | 65.0 | 6.7 / 722.7 ms | 2.149 | Workers CPU 60% |

## Margin per plan

Revenue per 1M requests is the plan price over the requests its quota buys at 20.7 credits per request (the measured user mix). Cost per 1M requests is the user window's. Free plans have no revenue: their column is the cost of serving a full quota.

| plan | $/mo | revenue $ per 1M req | cost $ per 1M req (user) | margin per 1M req | cost of the full quota | margin at full quota |
|---|---|---|---|---|---|---|
| public | 0 | 0.000 | 2.149 | -2.149 | 1.04 | -1.04 |
| free | 0 | 0.000 | 2.149 | -2.149 | 2.07 | -2.07 |
| builder | 19 | 0.656 | 2.149 | -1.493 | 62.23 | -43.23 |
| growth | 89 | 0.615 | 2.149 | -1.534 | 311.15 | -222.15 |
| scale | 599 | 0.620 | 2.149 | -1.528 | 2074.34 | -1475.34 |
