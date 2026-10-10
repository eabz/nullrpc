# Cost of run 20261010T022332Z-milestone-1

Cloudflare metrics per run window (sampled, with a 30s tail). Prices: Workers $0.30/M requests and $0.02/M CPU-ms, Durable Objects $0.15/M requests and $12.50/M GB-s plus SQL rows, R2 $0.36/M Class B and $4.50/M Class A.

Service-binding and RPC calls between Workers are not billed as requests (their CPU is), so only the RPC Worker's edge requests count. Per-request units are divided by the client's request count; other traffic in the window (dashboards, other clients) inflates them.

| window | client req | rpc req/req | live calls/req | app calls/req | DO req/req | R2 B/req | cpu ms/req | rpc cpu p50/p99 | $ per 1M req | biggest cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| calls | 536 | 2.40 | 2.8 | 0.58 | 19.2 | 30.5 | 1041.3 | 30.3 / 5495.3 ms | 41.770 | Workers CPU 50% |
| user | 1529 | 1.01 | 0.7 | 0.18 | 4.0 | 1.3 | 205.1 | 6.3 / 2687.8 ms | 5.965 | Workers CPU 69% |

## Margin per plan

Revenue per 1M requests is the plan price over the requests its quota buys at 20.7 credits per request (the measured user mix). Cost per 1M requests is the user window's. Free plans have no revenue: their column is the cost of serving a full quota.

| plan | $/mo | revenue $ per 1M req | cost $ per 1M req (user) | margin per 1M req | cost of the full quota | margin at full quota |
|---|---|---|---|---|---|---|
| public | 0 | 0.000 | 5.965 | -5.965 | 2.88 | -2.88 |
| free | 0 | 0.000 | 5.965 | -5.965 | 5.76 | -5.76 |
| builder | 19 | 0.656 | 5.965 | -5.309 | 172.81 | -153.81 |
| growth | 89 | 0.614 | 5.965 | -5.350 | 864.05 | -775.05 |
| scale | 599 | 0.620 | 5.965 | -5.344 | 5760.32 | -5161.32 |
