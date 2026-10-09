# nullrpc benchmark 20261009T175205Z

Target https://hoodi.nullrpc.dev (internal key), head 3784304, archived through 3784234, generation 188.

## Stress at each plan's rate

The user mix sent open-loop at each plan's requests-per-second cap for 20s with one internal key (no limits), from one client (at most 600 in flight; "dropped" counts sends the client skipped because it was full, a client limit, not the endpoint's).

| plan | target rps | achieved | n | ok | refused | 429 | err | err % | p50 | p95 | p99 | credits/req | r2/call | client dropped |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| builder | 250 | 238 | 5167 | 5135 | 32 | 0 | 0 | 0.00 | 205ms | 3.76s | 4.69s | 20.8 | 0.01 | 83 |
| growth | 1000 | 668 | 20024 | 19923 | 101 | 0 | 0 | 0.00 | 131ms | 852ms | 2.41s | 20.9 | 0.01 | 976 |

## Plan economics

Credits per request from the measured user mix (20.8). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.8 | 480,428 | 13.3 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.8 | 960,855 | 13.3 | 0 | 0 | - |
| builder | 19 | 600,000,000 | 250 | 20.8 | 28,825,662 | 32.0 | 0.659 | 0.0317 | 205ms / 4.69s / 0.0% |
| growth | 89 | 3,000,000,000 | 1000 | 20.8 | 144,128,312 | 40.0 | 0.618 | 0.0297 | 131ms / 2.41s / 0.0% |
| scale | 599 | 20,000,000,000 | 3000 | 20.8 | 960,855,416 | 89.0 | 0.623 | 0.0300 | - |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report /Users/eabz/Documents/GitHub/nullrpc/.claude/worktrees/live-state-shards/bench/results/live-state-before` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
