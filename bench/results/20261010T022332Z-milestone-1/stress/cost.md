# Cost of run stress

Cloudflare metrics per run window (sampled, with a 30s tail). Prices: Workers $0.30/M requests and $0.02/M CPU-ms, Durable Objects $0.15/M requests and $12.50/M GB-s plus SQL rows, R2 $0.36/M Class B and $4.50/M Class A.

Service-binding and RPC calls between Workers are not billed as requests (their CPU is), so only the RPC Worker's edge requests count. Per-request units are divided by the client's request count; other traffic in the window (dashboards, other clients) inflates them.

| window | client req | rpc req/req | live calls/req | app calls/req | DO req/req | R2 B/req | cpu ms/req | rpc cpu p50/p99 | $ per 1M req | biggest cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| stress free | 420 | 0.99 | 1.0 | 0.28 | 8.1 | 67.2 | 373.3 | 26.0 / 4864.3 ms | 35.048 | R2 Class B 69% |
| stress builder | 5160 | 1.00 | 0.5 | 0.22 | 2.7 | 4.6 | 209.5 | 19.0 / 3346.0 ms | 6.648 | Workers CPU 63% |
| stress growth | 14233 | 1.00 | 0.4 | 0.12 | 2.3 | 1.9 | 148.8 | 2.8 / 2783.0 ms | 4.402 | Workers CPU 68% |
| stress scale | 23561 | 1.00 | 0.4 | 0.08 | 2.3 | 0.7 | 125.0 | 2.1 / 2695.9 ms | 3.429 | Workers CPU 73% |

## Margin per plan

Revenue per 1M requests is the plan price over the requests its quota buys at 20.8 credits per request (the measured user mix). Cost per 1M requests is the stress scale window's. Free plans have no revenue: their column is the cost of serving a full quota.

| plan | $/mo | revenue $ per 1M req | cost $ per 1M req (stress scale) | margin per 1M req | cost of the full quota | margin at full quota |
|---|---|---|---|---|---|---|
| public | 0 | 0.000 | 3.429 | -3.429 | 1.65 | -1.65 |
| free | 0 | 0.000 | 3.429 | -3.429 | 3.30 | -3.30 |
| builder | 19 | 0.658 | 3.429 | -2.772 | 99.05 | -80.05 |
| growth | 89 | 0.616 | 3.429 | -2.813 | 495.26 | -406.26 |
| scale | 599 | 0.622 | 3.429 | -2.807 | 3301.71 | -2702.71 |
