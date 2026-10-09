# nullrpc benchmark 20261009T193659Z

Target https://hoodi.nullrpc.dev (internal key), head 3784772, archived through 3784493, generation 192.

## Stress at each plan's rate

The user mix sent open-loop at each plan's requests-per-second cap for 20s with one internal key (no limits), from one client (at most 600 in flight; "dropped" counts sends the client skipped because it was full, a client limit, not the endpoint's).

| plan | target rps | achieved | n | ok | refused | 429 | err | err % | p50 | p95 | p99 | credits/req | r2/call | client dropped |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| free | 20 | 21 | 420 | 417 | 3 | 0 | 0 | 0.00 | 107ms | 1.25s | 5.55s | 20.8 | 2.51 | 0 |
| builder | 250 | 111 | 5223 | 4863 | 28 | 0 | 332 | 6.36 | 454ms | 10.34s | 12.84s | 20.8 | 0.04 | 27 |
| growth | 1000 | 306 | 8016 | 7908 | 56 | 0 | 52 | 0.65 | 502ms | 9.36s | 18.31s | 20.9 | 0.01 | 12983 |
| scale | 3000 | 920 | 19355 | 19200 | 155 | 0 | 0 | 0.00 | 400ms | 1.72s | 6.18s | 21.0 | 0.00 | 43645 |

## Plan economics

Credits per request from the measured user mix (20.8). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.8 | 481,375 | 13.4 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.8 | 962,751 | 13.4 | 0 | 0 | 107ms / 5.55s / 0.0% |
| builder | 19 | 600,000,000 | 250 | 20.8 | 28,882,521 | 32.1 | 0.658 | 0.0317 | 454ms / 12.84s / 6.4% |
| growth | 89 | 3,000,000,000 | 1000 | 20.8 | 144,412,607 | 40.1 | 0.616 | 0.0297 | 502ms / 18.31s / 0.6% |
| scale | 599 | 20,000,000,000 | 3000 | 20.8 | 962,750,716 | 89.1 | 0.622 | 0.0300 | 400ms / 6.18s / 0.0% |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/20261009T193659Z-milestone/stress` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
