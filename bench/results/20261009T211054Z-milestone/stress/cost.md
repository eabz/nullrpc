# Cost of run stress

Cloudflare metrics per run window (sampled, with a 30s tail). Prices: Workers $0.30/M requests and $0.02/M CPU-ms, Durable Objects $0.15/M requests and $12.50/M GB-s plus SQL rows, R2 $0.36/M Class B and $4.50/M Class A.

Service-binding and RPC calls between Workers are not billed as requests (their CPU is), so only the RPC Worker's edge requests count. Per-request units are divided by the client's request count; other traffic in the window (dashboards, other clients) inflates them.

| window | client req | rpc req/req | live calls/req | app calls/req | DO req/req | R2 B/req | cpu ms/req | rpc cpu p50/p99 | $ per 1M req | biggest cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| stress free | 420 | 31.72 | 5.0 | 2.38 | 9.7 | 4.4 | 567.9 | 1.9 / 517.1 ms | 24.426 | Workers CPU 46% |
| stress builder | 5250 | 4.52 | 0.4 | 0.74 | 0.9 | 0.5 | 50.7 | 1.7 / 234.4 ms | 2.709 | Workers requests 50% |
| stress growth | 18489 | 3.41 | 0.3 | 0.44 | 0.5 | 0.3 | 29.4 | 1.4 / 173.7 ms | 1.791 | Workers requests 57% |
| stress scale | 44564 | 1.00 | 0.1 | 0.11 | 0.2 | 0.1 | 8.4 | 1.3 / 181.4 ms | 0.522 | Workers requests 57% |

## Margin per plan

Revenue per 1M requests is the plan price over the requests its quota buys at 20.8 credits per request (the measured user mix). Cost per 1M requests is the stress scale window's. Free plans have no revenue: their column is the cost of serving a full quota.

| plan | $/mo | revenue $ per 1M req | cost $ per 1M req (stress scale) | margin per 1M req | cost of the full quota | margin at full quota |
|---|---|---|---|---|---|---|
| public | 0 | 0.000 | 0.522 | -0.522 | 0.25 | -0.25 |
| free | 0 | 0.000 | 0.522 | -0.522 | 0.50 | -0.50 |
| builder | 19 | 0.658 | 0.522 | 0.136 | 15.07 | 3.93 |
| growth | 89 | 0.616 | 0.522 | 0.094 | 75.37 | 13.63 |
| scale | 599 | 0.622 | 0.522 | 0.100 | 502.48 | 96.52 |
