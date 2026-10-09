# nullrpc benchmark 20261009T180308Z

Target https://hoodi.nullrpc.dev (keyless), head 3784353, archived through 3784234, generation 188.

## Normal user scenario

4 simulated wallet users for 60s, each looping a 15-step session (connect, balances, fee quote, estimate, confirmation, history) with 150 to 600ms of think time between steps. 28 sessions completed, 28 without a failed step; a session costs about 289 credits and takes 9.14s at the median.

| step | n | ok | refused | err | p50 | p95 | max | credits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| connect: eth_chainId | 28 | 28 | 0 | 0 | 120ms | 524ms | 720ms | 5 |
| connect: eth_blockNumber | 28 | 28 | 0 | 0 | 79ms | 217ms | 339ms | 10 |
| balance: eth_getBalance | 28 | 28 | 0 | 0 | 213ms | 639ms | 661ms | 15 |
| balance: eth_call balanceOf | 28 | 28 | 0 | 0 | 448ms | 717ms | 824ms | 30 |
| balance: eth_call balanceOf 2 | 27 | 27 | 0 | 0 | 285ms | 952ms | 957ms | 30 |
| send: eth_getTransactionCount | 27 | 27 | 0 | 0 | 100ms | 451ms | 535ms | 15 |
| send: eth_gasPrice | 27 | 27 | 0 | 0 | 105ms | 271ms | 439ms | 10 |
| send: eth_maxPriorityFeePerGas | 27 | 27 | 0 | 0 | 114ms | 303ms | 309ms | 10 |
| send: eth_feeHistory | 26 | 26 | 0 | 0 | 94ms | 601ms | 603ms | 20 |
| send: eth_estimateGas | 25 | 24 | 1 | 0 | 234ms | 1.05s | 1.26s | 50 |
| confirm: eth_getTransactionReceipt | 24 | 24 | 0 | 0 | 180ms | 570ms | 682ms | 15 |
| confirm: eth_getTransactionByHash | 24 | 24 | 0 | 0 | 148ms | 387ms | 445ms | 15 |
| confirm: eth_getBlockByNumber latest | 24 | 24 | 0 | 0 | 211ms | 341ms | 362ms | 20 |
| history: eth_getLogs transfers to me | 24 | 24 | 0 | 0 | 707ms | 1.11s | 1.44s | 50 |
| history: eth_getBlockByNumber recent | 24 | 24 | 0 | 0 | 103ms | 262ms | 539ms | 20 |

Free plan: 20M credits is about 69,264 such sessions a month; Builder: 2,077,922.

## Plan economics

Credits per request from the measured user mix (20.7). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.7 | 483,612 | 13.4 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.7 | 967,223 | 13.4 | 0 | 0 | - |
| builder | 19 | 600,000,000 | 250 | 20.7 | 29,016,698 | 32.2 | 0.655 | 0.0317 | - |
| growth | 89 | 3,000,000,000 | 1000 | 20.7 | 145,083,488 | 40.3 | 0.613 | 0.0297 | - |
| scale | 599 | 20,000,000,000 | 3000 | 20.7 | 967,223,253 | 89.6 | 0.619 | 0.0300 | - |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/head-tier-after` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
