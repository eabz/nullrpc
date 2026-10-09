# nullrpc benchmark 20261009T220008Z

Target https://hoodi.nullrpc.dev (internal key), head 3785420, archived through 3785298, generation 205.

## Stress at each plan's rate

The user mix sent open-loop at each plan's requests-per-second cap for 20s with one internal key (no limits), from one client (at most 600 in flight; "dropped" counts sends the client skipped because it was full, a client limit, not the endpoint's).

| plan | target rps | achieved | n | ok | refused | 429 | err | err % | p50 | p95 | p99 | credits/req | r2/call | client dropped |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| scale | 3000 | 2198 | 44784 | 44514 | 270 | 0 | 0 | 0.00 | 199ms | 397ms | 1.73s | 20.9 | 0.00 | 18168 |

## Plan economics

Credits per request from the measured user mix (20.9). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.9 | 477,589 | 13.3 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.9 | 955,178 | 13.3 | 0 | 0 | - |
| builder | 19 | 600,000,000 | 250 | 20.9 | 28,655,341 | 31.8 | 0.663 | 0.0317 | - |
| growth | 89 | 3,000,000,000 | 1000 | 20.9 | 143,276,706 | 39.8 | 0.621 | 0.0297 | - |
| scale | 599 | 20,000,000,000 | 3000 | 20.9 | 955,178,040 | 88.4 | 0.627 | 0.0300 | 199ms / 1.73s / 0.0% |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/20261009T214144Z-ledger-fallback/after-2` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
