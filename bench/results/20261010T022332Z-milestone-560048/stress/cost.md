# Cost of run stress

Cloudflare metrics per run window (sampled, with a 30s tail). Prices: Workers $0.30/M requests and $0.02/M CPU-ms, Durable Objects $0.15/M requests and $12.50/M GB-s plus SQL rows, R2 $0.36/M Class B and $4.50/M Class A.

Service-binding and RPC calls between Workers are not billed as requests (their CPU is), so only the RPC Worker's edge requests count. Per-request units are divided by the client's request count; other traffic in the window (dashboards, other clients) inflates them.

| window | client req | rpc req/req | live calls/req | app calls/req | DO req/req | R2 B/req | cpu ms/req | rpc cpu p50/p99 | $ per 1M req | biggest cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| stress free | 420 | 0.99 | 0.4 | 0.04 | 0.7 | 1.5 | 20.1 | 2.9 / 367.6 ms | 2.064 | R2 Class A 28% |
| stress builder | 5250 | 1.00 | 0.2 | 0.07 | 0.4 | 0.2 | 12.0 | 2.0 / 213.2 ms | 0.766 | Workers requests 39% |
| stress growth | 18856 | 1.01 | 0.1 | 0.04 | 0.1 | 0.1 | 5.8 | 1.5 / 130.4 ms | 0.496 | Workers requests 61% |
| stress scale | 47257 | 1.00 | 0.1 | 0.03 | 0.1 | 0.1 | 4.5 | 1.3 / 82.7 ms | 0.445 | Workers requests 68% |

## Margin per plan

Revenue per 1M requests is the plan price over the requests its quota buys at 20.8 credits per request (the measured user mix). Cost per 1M requests is the stress scale window's. Free plans have no revenue: their column is the cost of serving a full quota.

| plan | $/mo | revenue $ per 1M req | cost $ per 1M req (stress scale) | margin per 1M req | cost of the full quota | margin at full quota |
|---|---|---|---|---|---|---|
| public | 0 | 0.000 | 0.445 | -0.445 | 0.21 | -0.21 |
| free | 0 | 0.000 | 0.445 | -0.445 | 0.43 | -0.43 |
| builder | 19 | 0.658 | 0.445 | 0.213 | 12.85 | 6.15 |
| growth | 89 | 0.616 | 0.445 | 0.172 | 64.23 | 24.77 |
| scale | 599 | 0.622 | 0.445 | 0.177 | 428.17 | 170.83 |
