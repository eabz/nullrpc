# nullrpc benchmark 20261010T022333Z

Target https://hoodi.nullrpc.dev (internal key), head 3786587, archived through 3786375, generation 221.

## Stress at each plan's rate

The user mix sent open-loop at each plan's requests-per-second cap for 20s with one internal key (no limits), from one client (at most 600 in flight; "dropped" counts sends the client skipped because it was full, a client limit, not the endpoint's).

| plan | target rps | achieved | n | ok | refused | 429 | err | err % | p50 | p95 | p99 | credits/req | r2/call | client dropped |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| free | 20 | 21 | 420 | 418 | 2 | 0 | 0 | 0.00 | 74ms | 807ms | 2.01s | 20.8 | 0.96 | 0 |
| builder | 250 | 258 | 5250 | 5232 | 18 | 0 | 0 | 0.00 | 63ms | 1.34s | 2.23s | 20.8 | 0.03 | 0 |
| growth | 1000 | 908 | 18856 | 18789 | 66 | 0 | 1 | 0.01 | 58ms | 1.21s | 2.51s | 20.9 | 0.01 | 2144 |
| scale | 3000 | 2299 | 47257 | 47075 | 182 | 0 | 0 | 0.00 | 63ms | 471ms | 2.31s | 21.0 | 0.01 | 15739 |

## Plan economics

Credits per request from the measured user mix (20.8). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.8 | 481,375 | 13.4 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.8 | 962,751 | 13.4 | 0 | 0 | 74ms / 2.01s / 0.0% |
| builder | 19 | 600,000,000 | 250 | 20.8 | 28,882,521 | 32.1 | 0.658 | 0.0317 | 63ms / 2.23s / 0.0% |
| growth | 89 | 3,000,000,000 | 1000 | 20.8 | 144,412,607 | 40.1 | 0.616 | 0.0297 | 58ms / 2.51s / 0.0% |
| scale | 599 | 20,000,000,000 | 3000 | 20.8 | 962,750,716 | 89.1 | 0.622 | 0.0300 | 63ms / 2.31s / 0.0% |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/20261010T022332Z-milestone-560048/stress` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
