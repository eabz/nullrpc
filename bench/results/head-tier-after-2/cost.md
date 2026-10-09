# Cost of run head-tier-after-2

Cloudflare metrics per run window (sampled, with a 30s tail). Prices: Workers $0.30/M requests and $0.02/M CPU-ms, Durable Objects $0.15/M requests and $12.50/M GB-s plus SQL rows, R2 $0.36/M Class B and $4.50/M Class A.

Service-binding and RPC calls between Workers are not billed as requests (their CPU is), so only the RPC Worker's edge requests count. Per-request units are divided by the client's request count; other traffic in the window (dashboards, other clients) inflates them.

| window | client req | rpc req/req | live calls/req | app calls/req | DO req/req | R2 B/req | cpu ms/req | rpc cpu p50/p99 | $ per 1M req | biggest cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| user | 386 | 1.13 | 0.5 | 0.06 | 1.1 | 0.5 | 47.6 | 3.6 / 582.2 ms | 2.065 | Workers CPU 46% |

## Margin per plan

Revenue per 1M requests is the plan price over the requests its quota buys at 20.6 credits per request (the measured user mix). Cost per 1M requests is the user window's. Free plans have no revenue: their column is the cost of serving a full quota.

| plan | $/mo | revenue $ per 1M req | cost $ per 1M req (user) | margin per 1M req | cost of the full quota | margin at full quota |
|---|---|---|---|---|---|---|
| public | 0 | 0.000 | 2.065 | -2.065 | 1.00 | -1.00 |
| free | 0 | 0.000 | 2.065 | -2.065 | 2.00 | -2.00 |
| builder | 19 | 0.653 | 2.065 | -1.413 | 60.13 | -41.13 |
| growth | 89 | 0.611 | 2.065 | -1.454 | 300.63 | -211.63 |
| scale | 599 | 0.617 | 2.065 | -1.448 | 2004.22 | -1405.22 |
