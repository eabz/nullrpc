# Cost of run stress

Cloudflare metrics per run window (sampled, with a 30s tail). Prices: Workers $0.30/M requests and $0.02/M CPU-ms, Durable Objects $0.15/M requests and $12.50/M GB-s plus SQL rows, R2 $0.36/M Class B and $4.50/M Class A.

Service-binding and RPC calls between Workers are not billed as requests (their CPU is), so only the RPC Worker's edge requests count. Per-request units are divided by the client's request count; other traffic in the window (dashboards, other clients) inflates them.

| window | client req | rpc req/req | live calls/req | app calls/req | DO req/req | R2 B/req | cpu ms/req | rpc cpu p50/p99 | $ per 1M req | biggest cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| stress free | 420 | 12.46 | 12.4 | 4.42 | 24.7 | 3.8 | 942.6 | 12.2 / 862.7 ms | 28.378 | Workers CPU 66% |
| stress builder | 4727 | 2.86 | 3.0 | 1.40 | 6.0 | 0.9 | 216.6 | 9.3 / 790.7 ms | 6.615 | Workers CPU 65% |
| stress growth | 8609 | 2.58 | 2.4 | 0.91 | 4.6 | 0.5 | 158.2 | 5.7 / 732.0 ms | 4.911 | Workers CPU 64% |
| stress scale | 13456 | 1.01 | 0.8 | 0.22 | 1.6 | 0.2 | 53.3 | 4.8 / 704.0 ms | 1.731 | Workers CPU 62% |

## Margin per plan

Revenue per 1M requests is the plan price over the requests its quota buys at 20.8 credits per request (the measured user mix). Cost per 1M requests is the stress scale window's. Free plans have no revenue: their column is the cost of serving a full quota.

| plan | $/mo | revenue $ per 1M req | cost $ per 1M req (stress scale) | margin per 1M req | cost of the full quota | margin at full quota |
|---|---|---|---|---|---|---|
| public | 0 | 0.000 | 1.731 | -1.731 | 0.83 | -0.83 |
| free | 0 | 0.000 | 1.731 | -1.731 | 1.67 | -1.67 |
| builder | 19 | 0.658 | 1.731 | -1.073 | 49.98 | -30.98 |
| growth | 89 | 0.616 | 1.731 | -1.114 | 249.92 | -160.92 |
| scale | 599 | 0.622 | 1.731 | -1.108 | 1666.12 | -1067.12 |
