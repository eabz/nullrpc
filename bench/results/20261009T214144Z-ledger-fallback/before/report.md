# nullrpc benchmark 20261009T214144Z

Target https://hoodi.nullrpc.dev (internal key), head 3785336, archived through 3785012, generation 201.

## Stress at each plan's rate

The user mix sent open-loop at each plan's requests-per-second cap for 20s with one internal key (no limits), from one client (at most 600 in flight; "dropped" counts sends the client skipped because it was full, a client limit, not the endpoint's).

| plan | target rps | achieved | n | ok | refused | 429 | err | err % | p50 | p95 | p99 | credits/req | r2/call | client dropped |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| free | 20 | 21 | 420 | 414 | 5 | 0 | 1 | 0.24 | 153ms | 949ms | 1.67s | 20.8 | 0.08 | 0 |
| builder | 250 | 149 | 5250 | 5221 | 28 | 0 | 1 | 0.02 | 60ms | 1.76s | 2.34s | 20.8 | 0.01 | 0 |
| growth | 1000 | 417 | 11235 | 11177 | 58 | 0 | 0 | 0.00 | 50ms | 9.83s | 18.03s | 21.0 | 0.01 | 9765 |
| scale | 3000 | 1163 | 52440 | 52067 | 278 | 90 | 5 | 0.01 | 52ms | 758ms | 3.12s | 21.0 | 0.01 | 10552 |

## Plan economics

Credits per request from the measured user mix (20.8). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.8 | 481,375 | 13.4 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.8 | 962,751 | 13.4 | 0 | 0 | 153ms / 1.67s / 0.2% |
| builder | 19 | 600,000,000 | 250 | 20.8 | 28,882,521 | 32.1 | 0.658 | 0.0317 | 60ms / 2.34s / 0.0% |
| growth | 89 | 3,000,000,000 | 1000 | 20.8 | 144,412,607 | 40.1 | 0.616 | 0.0297 | 50ms / 18.03s / 0.0% |
| scale | 599 | 20,000,000,000 | 3000 | 20.8 | 962,750,716 | 89.1 | 0.622 | 0.0300 | 52ms / 3.12s / 0.0% |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report /private/tmp/claude-501/-Users-eabz-Documents-GitHub-nullrpc--claude-worktrees-reverent-gates-ba9fa8/35898cc2-7ad3-40ea-82fc-13fd63fd3f95/scratchpad/before-ramp2` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
