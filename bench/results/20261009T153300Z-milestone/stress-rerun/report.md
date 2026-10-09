# nullrpc benchmark 20261009T153829Z

Target https://hoodi.nullrpc.dev (internal key), head 3783705, archived through 3783458, generation 176.

## Stress at each plan's rate

The user mix sent open-loop at each plan's requests-per-second cap for 20s with one internal key (no limits), from one client (at most 600 in flight; "dropped" counts sends the client skipped because it was full, a client limit, not the endpoint's).

| plan | target rps | achieved | n | ok | refused | 429 | err | err % | p50 | p95 | p99 | credits/req | r2/call | client dropped |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| free | 20 | 14 | 420 | 416 | 3 | 0 | 1 | 0.24 | 509ms | 2.30s | 2.94s | 20.8 | 0.05 | 0 |
| builder | 250 | 103 | 4340 | 4309 | 18 | 0 | 13 | 0.30 | 590ms | 7.30s | 10.12s | 20.7 | 0.05 | 910 |
| growth | 1000 | 133 | 5850 | 5803 | 27 | 0 | 20 | 0.34 | 1.50s | 6.03s | 12.71s | 20.9 | 0.01 | 15149 |
| scale | 3000 | 50 | 2633 | 2614 | 10 | 0 | 9 | 0.34 | 4.73s | 15.17s | 20.52s | 21.1 | 0.02 | 60344 |

## Plan economics

Credits per request from the measured user mix (20.8). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.8 | 481,375 | 13.4 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.8 | 962,751 | 13.4 | 0 | 0 | 509ms / 2.94s / 0.2% |
| builder | 19 | 600,000,000 | 250 | 20.8 | 28,882,521 | 32.1 | 0.658 | 0.0317 | 590ms / 10.12s / 0.3% |
| growth | 89 | 3,000,000,000 | 1000 | 20.8 | 144,412,607 | 40.1 | 0.616 | 0.0297 | 1.50s / 12.71s / 0.3% |
| scale | 599 | 20,000,000,000 | 3000 | 20.8 | 962,750,716 | 89.1 | 0.622 | 0.0300 | 4.73s / 20.52s / 0.3% |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/20261009T153300Z-milestone/stress-rerun` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
