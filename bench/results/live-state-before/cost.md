# Cost of run live-state-before

Cloudflare metrics per run window (sampled, with a 30s tail). Prices: Workers $0.30/M requests and $0.02/M CPU-ms, Durable Objects $0.15/M requests and $12.50/M GB-s plus SQL rows, R2 $0.36/M Class B and $4.50/M Class A.

Service-binding and RPC calls between Workers are not billed as requests (their CPU is), so only the RPC Worker's edge requests count. Per-request units are divided by the client's request count; other traffic in the window (dashboards, other clients) inflates them.

| window | client req | rpc req/req | live calls/req | app calls/req | DO req/req | R2 B/req | cpu ms/req | rpc cpu p50/p99 | $ per 1M req | biggest cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| stress builder | 5167 | 4.87 | 4.0 | 0.86 | 7.8 | 0.8 | 182.5 | 5.7 / 356.0 ms | 6.689 | Workers CPU 55% |
| stress growth | 20024 | 1.00 | 0.8 | 0.18 | 1.5 | 0.1 | 34.4 | 5.0 / 353.9 ms | 1.275 | Workers CPU 54% |

## Margin per plan

Revenue per 1M requests is the plan price over the requests its quota buys at 20.8 credits per request (the measured user mix). Cost per 1M requests is the stress growth window's. Free plans have no revenue: their column is the cost of serving a full quota.

| plan | $/mo | revenue $ per 1M req | cost $ per 1M req (stress growth) | margin per 1M req | cost of the full quota | margin at full quota |
|---|---|---|---|---|---|---|
| public | 0 | 0.000 | 1.275 | -1.275 | 0.61 | -0.61 |
| free | 0 | 0.000 | 1.275 | -1.275 | 1.22 | -1.22 |
| builder | 19 | 0.659 | 1.275 | -0.616 | 36.75 | -17.75 |
| growth | 89 | 0.618 | 1.275 | -0.657 | 183.74 | -94.74 |
| scale | 599 | 0.623 | 1.275 | -0.651 | 1224.91 | -625.91 |
