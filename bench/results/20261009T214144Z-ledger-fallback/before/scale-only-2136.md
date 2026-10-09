# nullrpc benchmark 20261009T213609Z

Target https://hoodi.nullrpc.dev (internal key), head 3785309, archived through 3785012, generation 201.

## Stress at each plan's rate

The user mix sent open-loop at each plan's requests-per-second cap for 20s with one internal key (no limits), from one client (at most 600 in flight; "dropped" counts sends the client skipped because it was full, a client limit, not the endpoint's).

| plan | target rps | achieved | n | ok | refused | 429 | err | err % | p50 | p95 | p99 | credits/req | r2/call | client dropped |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| scale | 3000 | 1630 | 34651 | 34407 | 153 | 0 | 91 | 0.26 | 51ms | 1.74s | 4.38s | 21.0 | 0.02 | 28308 |

## Plan economics

Credits per request from the measured user mix (21.0). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 21.0 | 476,883 | 13.2 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 21.0 | 953,765 | 13.2 | 0 | 0 | - |
| builder | 19 | 600,000,000 | 250 | 21.0 | 28,612,952 | 31.8 | 0.664 | 0.0317 | - |
| growth | 89 | 3,000,000,000 | 1000 | 21.0 | 143,064,759 | 39.7 | 0.622 | 0.0297 | - |
| scale | 599 | 20,000,000,000 | 3000 | 21.0 | 953,765,061 | 88.3 | 0.628 | 0.0300 | 51ms / 4.38s / 0.3% |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report /private/tmp/claude-501/-Users-eabz-Documents-GitHub-nullrpc--claude-worktrees-reverent-gates-ba9fa8/35898cc2-7ad3-40ea-82fc-13fd63fd3f95/scratchpad/before` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
