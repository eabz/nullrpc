# Cost of run 20261009T211054Z-milestone

Cloudflare metrics per run window (sampled, with a 30s tail). Prices: Workers $0.30/M requests and $0.02/M CPU-ms, Durable Objects $0.15/M requests and $12.50/M GB-s plus SQL rows, R2 $0.36/M Class B and $4.50/M Class A.

Service-binding and RPC calls between Workers are not billed as requests (their CPU is), so only the RPC Worker's edge requests count. Per-request units are divided by the client's request count; other traffic in the window (dashboards, other clients) inflates them.

| window | client req | rpc req/req | live calls/req | app calls/req | DO req/req | R2 B/req | cpu ms/req | rpc cpu p50/p99 | $ per 1M req | biggest cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| calls | 536 | 3.30 | 2.5 | 0.65 | 4.4 | 2.9 | 247.4 | 4.1 / 999.7 ms | 8.301 | Workers CPU 60% |
| user | 2540 | 1.00 | 0.3 | 0.15 | 0.7 | 0.4 | 42.2 | 2.6 / 838.3 ms | 1.496 | Workers CPU 56% |

## Margin per plan

Revenue per 1M requests is the plan price over the requests its quota buys at 20.9 credits per request (the measured user mix). Cost per 1M requests is the user window's. Free plans have no revenue: their column is the cost of serving a full quota.

| plan | $/mo | revenue $ per 1M req | cost $ per 1M req (user) | margin per 1M req | cost of the full quota | margin at full quota |
|---|---|---|---|---|---|---|
| public | 0 | 0.000 | 1.496 | -1.496 | 0.72 | -0.72 |
| free | 0 | 0.000 | 1.496 | -1.496 | 1.43 | -1.43 |
| builder | 19 | 0.661 | 1.496 | -0.835 | 42.97 | -23.97 |
| growth | 89 | 0.620 | 1.496 | -0.876 | 214.86 | -125.86 |
| scale | 599 | 0.626 | 1.496 | -0.870 | 1432.40 | -833.40 |
