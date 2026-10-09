# Cost of run live-edge-before

Cloudflare metrics per run window (sampled, with a 30s tail). Prices: Workers $0.30/M requests and $0.02/M CPU-ms, Durable Objects $0.15/M requests and $12.50/M GB-s plus SQL rows, R2 $0.36/M Class B and $4.50/M Class A.

Service-binding and RPC calls between Workers are not billed as requests (their CPU is), so only the RPC Worker's edge requests count. Per-request units are divided by the client's request count; other traffic in the window (dashboards, other clients) inflates them.

| window | client req | rpc req/req | live calls/req | app calls/req | DO req/req | R2 B/req | cpu ms/req | rpc cpu p50/p99 | $ per 1M req | biggest cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| stress builder | 5250 | 4.31 | 0.6 | 0.40 | 1.1 | 0.3 | 29.1 | 1.3 / 177.1 ms | 2.143 | Workers requests 60% |
| stress growth | 17381 | 1.00 | 0.1 | 0.10 | 0.2 | 0.1 | 4.9 | 1.3 / 79.2 ms | 0.449 | Workers requests 67% |

## Margin per plan

Revenue per 1M requests is the plan price over the requests its quota buys at 20.8 credits per request (the measured user mix). Cost per 1M requests is the stress growth window's. Free plans have no revenue: their column is the cost of serving a full quota.

| plan | $/mo | revenue $ per 1M req | cost $ per 1M req (stress growth) | margin per 1M req | cost of the full quota | margin at full quota |
|---|---|---|---|---|---|---|
| public | 0 | 0.000 | 0.449 | -0.449 | 0.22 | -0.22 |
| free | 0 | 0.000 | 0.449 | -0.449 | 0.43 | -0.43 |
| builder | 19 | 0.660 | 0.449 | 0.211 | 12.93 | 6.07 |
| growth | 89 | 0.618 | 0.449 | 0.169 | 64.64 | 24.36 |
| scale | 599 | 0.624 | 0.449 | 0.175 | 430.94 | 168.06 |
