# nullrpc benchmark 20261009T134808Z

Target https://hoodi.nullrpc.dev (internal key), head 3783220, archived through 3782923, generation 168.

## Stress at each plan's rate

The user mix sent open-loop at each plan's requests-per-second cap for 20s with one internal key (no limits), from one client (at most 600 in flight; "dropped" counts sends the client skipped because it was full, a client limit, not the endpoint's).

| plan | target rps | achieved | n | ok | refused | 429 | err | err % | p50 | p95 | p99 | credits/req | r2/call | client dropped |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| free | 20 | 12 | 420 | 415 | 3 | 0 | 2 | 0.48 | 900ms | 3.53s | 25.26s | 20.8 | 1.69 | 0 |
| builder | 250 | 48 | 1272 | 1058 | 10 | 0 | 204 | 16.04 | 10.97s | 23.36s | 23.97s | 21.2 | 0.03 | 3978 |

## Plan economics

Credits per request from the measured user mix (20.8). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.8 | 481,375 | 13.4 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.8 | 962,751 | 13.4 | 0 | 0 | 900ms / 25.26s / 0.5% |
| builder | 19 | 600,000,000 | 250 | 20.8 | 28,882,521 | 32.1 | 0.658 | 0.0317 | 10.97s / 23.97s / 16.0% |
| growth | 89 | 3,000,000,000 | 1000 | 20.8 | 144,412,607 | 40.1 | 0.616 | 0.0297 | - |
| scale | 599 | 20,000,000,000 | 3000 | 20.8 | 962,750,716 | 89.1 | 0.622 | 0.0300 | - |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/live-records-before` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.

## Live records in R2: before

This is the "before" half of the live-records change (docs/storage.md, "Live records"): the
Worker reads blocks above P through the `LiveReads.block` service binding (one ChainDO request
per block read). The -32603 answers are the sanitized form of the Durable Object overload. The
"after" run goes in `bench/results/live-records-after/` once the daemon is rebuilt and restarted
with the record writer (`node bench/scenario.mjs --chain 560048 --phase stress --plans free,builder --stress-seconds 20`).
