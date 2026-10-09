# nullrpc benchmark 20261009T194911Z

Target https://hoodi.nullrpc.dev (internal key), head 3784824, archived through 3784749, generation 197.

## Stress at each plan's rate

The user mix sent open-loop at each plan's requests-per-second cap for 20s with one internal key (no limits), from one client (at most 600 in flight; "dropped" counts sends the client skipped because it was full, a client limit, not the endpoint's).

| plan | target rps | achieved | n | ok | refused | 429 | err | err % | p50 | p95 | p99 | credits/req | r2/call | client dropped |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| builder | 250 | 197 | 5250 | 5218 | 30 | 0 | 2 | 0.04 | 97ms | 1.66s | 2.23s | 20.8 | 0.02 | 0 |
| growth | 1000 | 660 | 19122 | 19015 | 105 | 0 | 2 | 0.01 | 97ms | 544ms | 4.00s | 20.9 | 0.00 | 1878 |

## Plan economics

Credits per request from the measured user mix (20.8). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.8 | 479,912 | 13.3 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.8 | 959,824 | 13.3 | 0 | 0 | - |
| builder | 19 | 600,000,000 | 250 | 20.8 | 28,794,735 | 32.0 | 0.660 | 0.0317 | 97ms / 2.23s / 0.0% |
| growth | 89 | 3,000,000,000 | 1000 | 20.8 | 143,973,673 | 40.0 | 0.618 | 0.0297 | 97ms / 4.00s / 0.0% |
| scale | 599 | 20,000,000,000 | 3000 | 20.8 | 959,824,489 | 88.9 | 0.624 | 0.0300 | - |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report /Users/eabz/Documents/GitHub/nullrpc/.claude/worktrees/live-state-shards/bench/results/live-edge-after` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
