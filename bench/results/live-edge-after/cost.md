# Cost of run live-edge-after

Cloudflare metrics per run window (sampled, with a 30s tail). Prices: Workers $0.30/M requests and $0.02/M CPU-ms, Durable Objects $0.15/M requests and $12.50/M GB-s plus SQL rows, R2 $0.36/M Class B and $4.50/M Class A.

Service-binding and RPC calls between Workers are not billed as requests (their CPU is), so only the RPC Worker's edge requests count. Per-request units are divided by the client's request count; other traffic in the window (dashboards, other clients) inflates them.

| window | client req | rpc req/req | live calls/req | app calls/req | DO req/req | R2 B/req | cpu ms/req | rpc cpu p50/p99 | $ per 1M req | biggest cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| stress builder | 5250 | 4.67 | 0.4 | 0.67 | 0.8 | 0.2 | 33.8 | 1.3 / 191.4 ms | 2.317 | Workers requests 60% |
| stress growth | 19122 | 1.01 | 0.1 | 0.17 | 0.1 | 0.0 | 6.2 | 1.3 / 157.9 ms | 0.467 | Workers requests 65% |

## Margin per plan

Revenue per 1M requests is the plan price over the requests its quota buys at 20.8 credits per request (the measured user mix). Cost per 1M requests is the stress growth window's. Free plans have no revenue: their column is the cost of serving a full quota.

| plan | $/mo | revenue $ per 1M req | cost $ per 1M req (stress growth) | margin per 1M req | cost of the full quota | margin at full quota |
|---|---|---|---|---|---|---|
| public | 0 | 0.000 | 0.467 | -0.467 | 0.22 | -0.22 |
| free | 0 | 0.000 | 0.467 | -0.467 | 0.45 | -0.45 |
| builder | 19 | 0.660 | 0.467 | 0.192 | 13.46 | 5.54 |
| growth | 89 | 0.618 | 0.467 | 0.151 | 67.29 | 21.71 |
| scale | 599 | 0.624 | 0.467 | 0.157 | 448.58 | 150.42 |
