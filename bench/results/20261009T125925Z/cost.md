# Cost of run 20261009T125925Z

Cloudflare metrics per run window (sampled, with a 30s tail). Prices: Workers $0.30/M requests and $0.02/M CPU-ms, Durable Objects $0.15/M requests and $12.50/M GB-s plus SQL rows, R2 $0.36/M Class B and $4.50/M Class A.

Service-binding and RPC calls between Workers are not billed as requests (their CPU is), so only the RPC Worker's edge requests count. Per-request units are divided by the client's request count; other traffic in the window (dashboards, other clients) inflates them.

| window | client req | rpc req/req | live calls/req | app calls/req | DO req/req | R2 B/req | cpu ms/req | rpc cpu p50/p99 | $ per 1M req | biggest cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| calls | 432 | 2.78 | 19.0 | 0.32 | 18.0 | 14.6 | 587.8 | 7.3 / 5122.8 ms | 23.478 | Workers CPU 50% |
| user | 1343 | 1.32 | 10.8 | 0.16 | 11.1 | 0.5 | 191.9 | 5.1 / 4564.0 ms | 6.982 | Workers CPU 55% |
| stress free | 420 | 4.39 | 30.9 | 1.31 | 28.8 | 1.8 | 486.0 | 8.9 / 2713.2 ms | 18.975 | Workers CPU 51% |
| stress builder | 1395 | 2.78 | 17.7 | 1.07 | 14.8 | 1.1 | 297.3 | 6.7 / 2661.0 ms | 10.282 | Workers CPU 58% |
| stress growth | 2471 | 1.00 | 6.3 | 0.40 | 5.3 | 0.4 | 103.4 | 4.4 / 2571.5 ms | 3.542 | Workers CPU 58% |

## Margin per plan

Revenue per 1M requests is the plan price over the requests its quota buys at 20.3 credits per request (the measured user mix). Cost per 1M requests is the stress free window's. Free plans have no revenue: their column is the cost of serving a full quota.

| plan | $/mo | revenue $ per 1M req | cost $ per 1M req (stress free) | margin per 1M req | cost of the full quota | margin at full quota |
|---|---|---|---|---|---|---|
| public | 0 | 0.000 | 18.975 | -18.975 | 9.36 | -9.36 |
| free | 0 | 0.000 | 18.975 | -18.975 | 18.73 | -18.73 |
| builder | 19 | 0.642 | 18.975 | -18.333 | 561.89 | -542.89 |
| growth | 89 | 0.601 | 18.975 | -18.374 | 2809.43 | -2720.43 |
| scale | 599 | 0.607 | 18.975 | -18.368 | 18729.57 | -18130.57 |
