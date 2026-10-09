# nullrpc benchmark 20261009T211054Z

Target https://hoodi.nullrpc.dev (internal key), head 3785195, archived through 3785012, generation 201.

## Stress at each plan's rate

The user mix sent open-loop at each plan's requests-per-second cap for 20s with one internal key (no limits), from one client (at most 600 in flight; "dropped" counts sends the client skipped because it was full, a client limit, not the endpoint's).

| plan | target rps | achieved | n | ok | refused | 429 | err | err % | p50 | p95 | p99 | credits/req | r2/call | client dropped |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| free | 20 | 21 | 420 | 416 | 4 | 0 | 0 | 0.00 | 100ms | 1.00s | 1.61s | 20.8 | 0.31 | 0 |
| builder | 250 | 248 | 5250 | 5221 | 29 | 0 | 0 | 0.00 | 78ms | 1.31s | 1.95s | 20.8 | 0.01 | 0 |
| growth | 1000 | 564 | 18489 | 18398 | 90 | 0 | 1 | 0.01 | 75ms | 821ms | 3.22s | 21.0 | 0.00 | 2511 |
| scale | 3000 | 1630 | 44564 | 42222 | 221 | 2121 | 0 | 0.00 | 73ms | 601ms | 6.29s | 21.0 | 0.00 | 18428 |

## Plan economics

Credits per request from the measured user mix (20.8). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.8 | 481,375 | 13.4 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.8 | 962,751 | 13.4 | 0 | 0 | 100ms / 1.61s / 0.0% |
| builder | 19 | 600,000,000 | 250 | 20.8 | 28,882,521 | 32.1 | 0.658 | 0.0317 | 78ms / 1.95s / 0.0% |
| growth | 89 | 3,000,000,000 | 1000 | 20.8 | 144,412,607 | 40.1 | 0.616 | 0.0297 | 75ms / 3.22s / 0.0% |
| scale | 599 | 20,000,000,000 | 3000 | 20.8 | 962,750,716 | 89.1 | 0.622 | 0.0300 | 73ms / 6.29s / 0.0% |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/20261009T211054Z-milestone/stress` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
