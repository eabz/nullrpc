# Cost of run 20261010T022332Z-milestone-560048

Cloudflare metrics per run window (sampled, with a 30s tail). Prices: Workers $0.30/M requests and $0.02/M CPU-ms, Durable Objects $0.15/M requests and $12.50/M GB-s plus SQL rows, R2 $0.36/M Class B and $4.50/M Class A.

Service-binding and RPC calls between Workers are not billed as requests (their CPU is), so only the RPC Worker's edge requests count. Per-request units are divided by the client's request count; other traffic in the window (dashboards, other clients) inflates them.

| window | client req | rpc req/req | live calls/req | app calls/req | DO req/req | R2 B/req | cpu ms/req | rpc cpu p50/p99 | $ per 1M req | biggest cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| calls | 536 | 3.65 | 3.5 | 0.46 | 5.3 | 2.9 | 152.9 | 3.6 / 605.6 ms | 11.538 | R2 Class A 42% |
| user | 2862 | 0.99 | 0.3 | 0.08 | 0.6 | 0.3 | 15.8 | 2.5 / 219.4 ms | 1.669 | R2 Class A 46% |

## Margin per plan

Revenue per 1M requests is the plan price over the requests its quota buys at 20.8 credits per request (the measured user mix). Cost per 1M requests is the user window's. Free plans have no revenue: their column is the cost of serving a full quota.

| plan | $/mo | revenue $ per 1M req | cost $ per 1M req (user) | margin per 1M req | cost of the full quota | margin at full quota |
|---|---|---|---|---|---|---|
| public | 0 | 0.000 | 1.669 | -1.669 | 0.80 | -0.80 |
| free | 0 | 0.000 | 1.669 | -1.669 | 1.60 | -1.60 |
| builder | 19 | 0.659 | 1.669 | -1.011 | 48.14 | -29.14 |
| growth | 89 | 0.617 | 1.669 | -1.052 | 240.72 | -151.72 |
| scale | 599 | 0.623 | 1.669 | -1.046 | 1604.82 | -1005.82 |
