# nullrpc benchmark 20261009T172606Z

Target https://hoodi.nullrpc.dev (internal key), head 3784190, archived through 3783974, generation 184.

## Stress at each plan's rate

The user mix sent open-loop at each plan's requests-per-second cap for 20s with one internal key (no limits), from one client (at most 600 in flight; "dropped" counts sends the client skipped because it was full, a client limit, not the endpoint's).

| plan | target rps | achieved | n | ok | refused | 429 | err | err % | p50 | p95 | p99 | credits/req | r2/call | client dropped |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| free | 20 | 13 | 420 | 413 | 5 | 0 | 2 | 0.48 | 155ms | 956ms | 2.19s | 20.8 | 0.16 | 0 |
| builder | 250 | 97 | 4727 | 4704 | 22 | 0 | 1 | 0.02 | 299ms | 6.29s | 7.26s | 20.8 | 0.04 | 523 |
| growth | 1000 | 191 | 8609 | 8146 | 36 | 0 | 427 | 4.96 | 165ms | 10.75s | 16.68s | 20.9 | 0.07 | 12390 |
| scale | 3000 | 231 | 13456 | 13350 | 73 | 0 | 33 | 0.25 | 179ms | 6.43s | 12.85s | 21.0 | 0.01 | 49541 |

## Plan economics

Credits per request from the measured user mix (20.8). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.8 | 481,375 | 13.4 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.8 | 962,751 | 13.4 | 0 | 0 | 155ms / 2.19s / 0.5% |
| builder | 19 | 600,000,000 | 250 | 20.8 | 28,882,521 | 32.1 | 0.658 | 0.0317 | 299ms / 7.26s / 0.0% |
| growth | 89 | 3,000,000,000 | 1000 | 20.8 | 144,412,607 | 40.1 | 0.616 | 0.0297 | 165ms / 16.68s / 5.0% |
| scale | 599 | 20,000,000,000 | 3000 | 20.8 | 962,750,716 | 89.1 | 0.622 | 0.0300 | 179ms / 12.85s / 0.2% |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/20261009T172605Z-milestone/stress` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
