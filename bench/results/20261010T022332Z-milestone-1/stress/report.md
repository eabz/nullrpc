# nullrpc benchmark 20261010T023841Z

Target https://eth.nullrpc.dev (internal key), head 26159092, archived through 26158987, generation 859.

## Stress at each plan's rate

The user mix sent open-loop at each plan's requests-per-second cap for 20s with one internal key (no limits), from one client (at most 600 in flight; "dropped" counts sends the client skipped because it was full, a client limit, not the endpoint's).

| plan | target rps | achieved | n | ok | refused | 429 | err | err % | p50 | p95 | p99 | credits/req | r2/call | client dropped |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| free | 20 | 11 | 420 | 384 | 7 | 0 | 29 | 6.90 | 329ms | 13.57s | 25.29s | 20.8 | 31.00 | 0 |
| builder | 250 | 189 | 5160 | 5010 | 96 | 0 | 54 | 1.05 | 207ms | 4.02s | 8.24s | 20.8 | 3.29 | 90 |
| growth | 1000 | 356 | 14233 | 13784 | 228 | 0 | 221 | 1.55 | 107ms | 4.26s | 7.00s | 21.1 | 0.95 | 6766 |
| scale | 3000 | 397 | 23561 | 22709 | 378 | 0 | 474 | 2.01 | 73ms | 3.36s | 7.17s | 20.9 | 0.33 | 39434 |

## Plan economics

Credits per request from the measured user mix (20.8). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.8 | 481,375 | 13.4 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.8 | 962,751 | 13.4 | 0 | 0 | 329ms / 25.29s / 6.9% |
| builder | 19 | 600,000,000 | 250 | 20.8 | 28,882,521 | 32.1 | 0.658 | 0.0317 | 207ms / 8.24s / 1.0% |
| growth | 89 | 3,000,000,000 | 1000 | 20.8 | 144,412,607 | 40.1 | 0.616 | 0.0297 | 107ms / 7.00s / 1.6% |
| scale | 599 | 20,000,000,000 | 3000 | 20.8 | 962,750,716 | 89.1 | 0.622 | 0.0300 | 73ms / 7.17s / 2.0% |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/20261010T022332Z-milestone-1/stress` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
