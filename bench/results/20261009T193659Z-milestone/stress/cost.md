# Cost of run stress

Cloudflare metrics per run window (sampled, with a 30s tail). Prices: Workers $0.30/M requests and $0.02/M CPU-ms, Durable Objects $0.15/M requests and $12.50/M GB-s plus SQL rows, R2 $0.36/M Class B and $4.50/M Class A.

Service-binding and RPC calls between Workers are not billed as requests (their CPU is), so only the RPC Worker's edge requests count. Per-request units are divided by the client's request count; other traffic in the window (dashboards, other clients) inflates them.

| window | client req | rpc req/req | live calls/req | app calls/req | DO req/req | R2 B/req | cpu ms/req | rpc cpu p50/p99 | $ per 1M req | biggest cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| stress free | 420 | 12.57 | 5.0 | 1.28 | 10.7 | 5.1 | 422.7 | 2.0 / 823.6 ms | 15.983 | Workers CPU 53% |
| stress builder | 5223 | 2.56 | 0.8 | 0.66 | 1.6 | 0.4 | 75.6 | 1.9 / 818.4 ms | 2.762 | Workers CPU 55% |
| stress growth | 8016 | 3.44 | 0.4 | 0.41 | 0.8 | 0.2 | 43.6 | 1.4 / 249.5 ms | 2.172 | Workers requests 47% |
| stress scale | 19355 | 1.01 | 0.1 | 0.02 | 0.1 | 0.1 | 7.5 | 1.3 / 94.6 ms | 0.500 | Workers requests 60% |

## Margin per plan

Revenue per 1M requests is the plan price over the requests its quota buys at 20.8 credits per request (the measured user mix). Cost per 1M requests is the stress scale window's. Free plans have no revenue: their column is the cost of serving a full quota.

| plan | $/mo | revenue $ per 1M req | cost $ per 1M req (stress scale) | margin per 1M req | cost of the full quota | margin at full quota |
|---|---|---|---|---|---|---|
| public | 0 | 0.000 | 0.500 | -0.500 | 0.24 | -0.24 |
| free | 0 | 0.000 | 0.500 | -0.500 | 0.48 | -0.48 |
| builder | 19 | 0.658 | 0.500 | 0.158 | 14.44 | 4.56 |
| growth | 89 | 0.616 | 0.500 | 0.116 | 72.20 | 16.80 |
| scale | 599 | 0.622 | 0.500 | 0.122 | 481.33 | 117.67 |
