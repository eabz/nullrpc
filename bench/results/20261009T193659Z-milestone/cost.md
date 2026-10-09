# Cost of run 20261009T193659Z-milestone

Cloudflare metrics per run window (sampled, with a 30s tail). Prices: Workers $0.30/M requests and $0.02/M CPU-ms, Durable Objects $0.15/M requests and $12.50/M GB-s plus SQL rows, R2 $0.36/M Class B and $4.50/M Class A.

Service-binding and RPC calls between Workers are not billed as requests (their CPU is), so only the RPC Worker's edge requests count. Per-request units are divided by the client's request count; other traffic in the window (dashboards, other clients) inflates them.

| window | client req | rpc req/req | live calls/req | app calls/req | DO req/req | R2 B/req | cpu ms/req | rpc cpu p50/p99 | $ per 1M req | biggest cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| calls | 536 | 3.42 | 2.0 | 0.12 | 3.2 | 2.0 | 184.5 | 2.2 / 1004.0 ms | 6.814 | Workers CPU 54% |
| user | 2671 | 1.00 | 0.3 | 0.03 | 0.5 | 0.1 | 33.3 | 1.7 / 904.5 ms | 1.145 | Workers CPU 58% |

## Margin per plan

Revenue per 1M requests is the plan price over the requests its quota buys at 20.8 credits per request (the measured user mix). Cost per 1M requests is the user window's. Free plans have no revenue: their column is the cost of serving a full quota.

| plan | $/mo | revenue $ per 1M req | cost $ per 1M req (user) | margin per 1M req | cost of the full quota | margin at full quota |
|---|---|---|---|---|---|---|
| public | 0 | 0.000 | 1.145 | -1.145 | 0.55 | -0.55 |
| free | 0 | 0.000 | 1.145 | -1.145 | 1.10 | -1.10 |
| builder | 19 | 0.659 | 1.145 | -0.486 | 33.02 | -14.02 |
| growth | 89 | 0.617 | 1.145 | -0.528 | 165.09 | -76.09 |
| scale | 599 | 0.623 | 1.145 | -0.522 | 1100.63 | -501.63 |
