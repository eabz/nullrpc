# Cost of run head-tier-after

Cloudflare metrics per run window (sampled, with a 30s tail). Prices: Workers $0.30/M requests and $0.02/M CPU-ms, Durable Objects $0.15/M requests and $12.50/M GB-s plus SQL rows, R2 $0.36/M Class B and $4.50/M Class A.

Service-binding and RPC calls between Workers are not billed as requests (their CPU is), so only the RPC Worker's edge requests count. Per-request units are divided by the client's request count; other traffic in the window (dashboards, other clients) inflates them.

| window | client req | rpc req/req | live calls/req | app calls/req | DO req/req | R2 B/req | cpu ms/req | rpc cpu p50/p99 | $ per 1M req | biggest cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| user | 391 | 1.01 | 0.5 | 0.03 | 1.1 | 0.4 | 34.6 | 3.3 / 406.1 ms | 2.257 | Workers CPU 31% |

## Margin per plan

Revenue per 1M requests is the plan price over the requests its quota buys at 20.7 credits per request (the measured user mix). Cost per 1M requests is the user window's. Free plans have no revenue: their column is the cost of serving a full quota.

| plan | $/mo | revenue $ per 1M req | cost $ per 1M req (user) | margin per 1M req | cost of the full quota | margin at full quota |
|---|---|---|---|---|---|---|
| public | 0 | 0.000 | 2.257 | -2.257 | 1.09 | -1.09 |
| free | 0 | 0.000 | 2.257 | -2.257 | 2.18 | -2.18 |
| builder | 19 | 0.655 | 2.257 | -1.602 | 65.49 | -46.49 |
| growth | 89 | 0.613 | 2.257 | -1.644 | 327.46 | -238.46 |
| scale | 599 | 0.619 | 2.257 | -1.638 | 2183.07 | -1584.07 |
