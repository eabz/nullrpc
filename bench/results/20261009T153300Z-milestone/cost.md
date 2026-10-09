# Cost of run 20261009T153300Z-milestone

Cloudflare metrics per run window (sampled, with a 30s tail). Prices: Workers $0.30/M requests and $0.02/M CPU-ms, Durable Objects $0.15/M requests and $12.50/M GB-s plus SQL rows, R2 $0.36/M Class B and $4.50/M Class A.

Service-binding and RPC calls between Workers are not billed as requests (their CPU is), so only the RPC Worker's edge requests count. Per-request units are divided by the client's request count; other traffic in the window (dashboards, other clients) inflates them.

| window | client req | rpc req/req | live calls/req | app calls/req | DO req/req | R2 B/req | cpu ms/req | rpc cpu p50/p99 | $ per 1M req | biggest cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| calls | 536 | 2.98 | 3.7 | 0.66 | 7.1 | 2.6 | 369.2 | 13.9 / 1797.2 ms | 11.390 | Workers CPU 65% |
| user | 2023 | 1.57 | 1.6 | 0.46 | 3.4 | 0.9 | 198.2 | 11.2 / 1918.6 ms | 5.960 | Workers CPU 66% |
| stress free | 420 | 7.37 | 7.8 | 2.40 | 16.5 | 4.2 | 914.3 | 12.0 / 1651.9 ms | 27.084 | Workers CPU 68% |
| stress builder | 2907 | 4.63 | 5.1 | 1.40 | 10.4 | 1.5 | 525.4 | 8.6 / 1508.9 ms | 14.538 | Workers CPU 72% |
| stress growth | 10800 | 1.57 | 1.7 | 0.49 | 3.3 | 0.5 | 162.0 | 7.7 / 1494.6 ms | 4.434 | Workers CPU 73% |
| stress scale | 6115 | 1.00 | 1.0 | 0.34 | 1.9 | 0.3 | 87.5 | 7.3 / 1458.6 ms | 2.491 | Workers CPU 70% |

## Margin per plan

Revenue per 1M requests is the plan price over the requests its quota buys at 21.7 credits per request (the measured user mix). Cost per 1M requests is the stress growth window's. Free plans have no revenue: their column is the cost of serving a full quota.

| plan | $/mo | revenue $ per 1M req | cost $ per 1M req (stress growth) | margin per 1M req | cost of the full quota | margin at full quota |
|---|---|---|---|---|---|---|
| public | 0 | 0.000 | 4.434 | -4.434 | 2.04 | -2.04 |
| free | 0 | 0.000 | 4.434 | -4.434 | 4.08 | -4.08 |
| builder | 19 | 0.688 | 4.434 | -3.747 | 122.53 | -103.53 |
| growth | 89 | 0.644 | 4.434 | -3.790 | 612.64 | -523.64 |
| scale | 599 | 0.650 | 4.434 | -3.784 | 4084.27 | -3485.27 |
