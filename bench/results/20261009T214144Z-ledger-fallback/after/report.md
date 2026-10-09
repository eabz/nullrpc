# nullrpc benchmark 20261009T215808Z

Target https://hoodi.nullrpc.dev (internal key), head 3785411, archived through 3785298, generation 205.

## Stress at each plan's rate

The user mix sent open-loop at each plan's requests-per-second cap for 20s with one internal key (no limits), from one client (at most 600 in flight; "dropped" counts sends the client skipped because it was full, a client limit, not the endpoint's).

| plan | target rps | achieved | n | ok | refused | 429 | err | err % | p50 | p95 | p99 | credits/req | r2/call | client dropped |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| scale | 3000 | 429 | 23416 | 22711 | 105 | 0 | 600 | 2.56 | 278ms | 1.72s | 40.03s | 20.9 | 0.03 | 38994 |

## Plan economics

Credits per request from the measured user mix (20.9). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.9 | 478,327 | 13.3 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.9 | 956,653 | 13.3 | 0 | 0 | - |
| builder | 19 | 600,000,000 | 250 | 20.9 | 28,699,596 | 31.9 | 0.662 | 0.0317 | - |
| growth | 89 | 3,000,000,000 | 1000 | 20.9 | 143,497,978 | 39.9 | 0.620 | 0.0297 | - |
| scale | 599 | 20,000,000,000 | 3000 | 20.9 | 956,653,185 | 88.6 | 0.626 | 0.0300 | 278ms / 40.03s / 2.6% |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/20261009T214144Z-ledger-fallback/after` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
