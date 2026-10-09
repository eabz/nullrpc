# Cost of run live-state-after

Cloudflare metrics per run window (sampled, with a 30s tail). Prices: Workers $0.30/M requests and $0.02/M CPU-ms, Durable Objects $0.15/M requests and $12.50/M GB-s plus SQL rows, R2 $0.36/M Class B and $4.50/M Class A.

Service-binding and RPC calls between Workers are not billed as requests (their CPU is), so only the RPC Worker's edge requests count. Per-request units are divided by the client's request count; other traffic in the window (dashboards, other clients) inflates them.

| window | client req | rpc req/req | live calls/req | app calls/req | DO req/req | R2 B/req | cpu ms/req | rpc cpu p50/p99 | $ per 1M req | biggest cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| stress builder | 5237 | 4.01 | 3.0 | 0.41 | 5.6 | 0.2 | 197.1 | 6.1 / 475.6 ms | 6.046 | Workers CPU 65% |
| stress growth | 19849 | 0.85 | 0.6 | 0.07 | 1.3 | 0.0 | 38.7 | 5.1 / 478.6 ms | 1.221 | Workers CPU 63% |

## Margin per plan

Revenue per 1M requests is the plan price over the requests its quota buys at 20.8 credits per request (the measured user mix). Cost per 1M requests is the stress growth window's. Free plans have no revenue: their column is the cost of serving a full quota.

| plan | $/mo | revenue $ per 1M req | cost $ per 1M req (stress growth) | margin per 1M req | cost of the full quota | margin at full quota |
|---|---|---|---|---|---|---|
| public | 0 | 0.000 | 1.221 | -1.221 | 0.59 | -0.59 |
| free | 0 | 0.000 | 1.221 | -1.221 | 1.17 | -1.17 |
| builder | 19 | 0.659 | 1.221 | -0.561 | 35.18 | -16.18 |
| growth | 89 | 0.618 | 1.221 | -0.603 | 175.89 | -86.89 |
| scale | 599 | 0.624 | 1.221 | -0.597 | 1172.59 | -573.59 |
