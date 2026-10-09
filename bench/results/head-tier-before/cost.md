# Cost of run head-tier-before

Cloudflare metrics per run window (sampled, with a 30s tail). Prices: Workers $0.30/M requests and $0.02/M CPU-ms, Durable Objects $0.15/M requests and $12.50/M GB-s plus SQL rows, R2 $0.36/M Class B and $4.50/M Class A.

Service-binding and RPC calls between Workers are not billed as requests (their CPU is), so only the RPC Worker's edge requests count. Per-request units are divided by the client's request count; other traffic in the window (dashboards, other clients) inflates them.

| window | client req | rpc req/req | live calls/req | app calls/req | DO req/req | R2 B/req | cpu ms/req | rpc cpu p50/p99 | $ per 1M req | biggest cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| user | 435 | 11.11 | 8.9 | 2.24 | 18.1 | 2.7 | 660.3 | 10.0 / 470.6 ms | 21.909 | Workers CPU 60% |

## Margin per plan

Revenue per 1M requests is the plan price over the requests its quota buys at 20.8 credits per request (the measured user mix). Cost per 1M requests is the user window's. Free plans have no revenue: their column is the cost of serving a full quota.

| plan | $/mo | revenue $ per 1M req | cost $ per 1M req (user) | margin per 1M req | cost of the full quota | margin at full quota |
|---|---|---|---|---|---|---|
| public | 0 | 0.000 | 21.909 | -21.909 | 10.53 | -10.53 |
| free | 0 | 0.000 | 21.909 | -21.909 | 21.05 | -21.05 |
| builder | 19 | 0.659 | 21.909 | -21.250 | 631.51 | -612.51 |
| growth | 89 | 0.618 | 21.909 | -21.292 | 3157.53 | -3068.53 |
| scale | 599 | 0.623 | 21.909 | -21.286 | 21050.21 | -20451.21 |
