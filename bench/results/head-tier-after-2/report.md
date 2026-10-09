# nullrpc benchmark 20261009T180451Z

Target https://hoodi.nullrpc.dev (keyless), head 3784361, archived through 3784234, generation 188.

## Normal user scenario

4 simulated wallet users for 60s, each looping a 15-step session (connect, balances, fee quote, estimate, confirmation, history) with 150 to 600ms of think time between steps. 28 sessions completed, 28 without a failed step; a session costs about 284 credits and takes 8.55s at the median.

| step | n | ok | refused | err | p50 | p95 | max | credits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| connect: eth_chainId | 28 | 28 | 0 | 0 | 69ms | 506ms | 868ms | 5 |
| connect: eth_blockNumber | 28 | 28 | 0 | 0 | 89ms | 355ms | 372ms | 10 |
| balance: eth_getBalance | 28 | 28 | 0 | 0 | 209ms | 350ms | 467ms | 15 |
| balance: eth_call balanceOf | 27 | 27 | 0 | 0 | 451ms | 1.01s | 1.51s | 30 |
| balance: eth_call balanceOf 2 | 27 | 27 | 0 | 0 | 145ms | 698ms | 808ms | 30 |
| send: eth_getTransactionCount | 27 | 27 | 0 | 0 | 145ms | 542ms | 1.20s | 15 |
| send: eth_gasPrice | 27 | 27 | 0 | 0 | 99ms | 462ms | 463ms | 10 |
| send: eth_maxPriorityFeePerGas | 26 | 26 | 0 | 0 | 56ms | 270ms | 276ms | 10 |
| send: eth_feeHistory | 24 | 24 | 0 | 0 | 66ms | 358ms | 1.47s | 20 |
| send: eth_estimateGas | 24 | 21 | 3 | 0 | 95ms | 1.15s | 1.30s | 50 |
| confirm: eth_getTransactionReceipt | 24 | 24 | 0 | 0 | 73ms | 622ms | 2.25s | 15 |
| confirm: eth_getTransactionByHash | 24 | 24 | 0 | 0 | 73ms | 394ms | 431ms | 15 |
| confirm: eth_getBlockByNumber latest | 24 | 24 | 0 | 0 | 71ms | 420ms | 840ms | 20 |
| history: eth_getLogs transfers to me | 24 | 24 | 0 | 0 | 775ms | 1.67s | 4.12s | 50 |
| history: eth_getBlockByNumber recent | 24 | 24 | 0 | 0 | 76ms | 330ms | 1.67s | 20 |

Free plan: 20M credits is about 70,396 such sessions a month; Builder: 2,111,879.

## Plan economics

Credits per request from the measured user mix (20.6). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.6 | 485,229 | 13.5 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.6 | 970,459 | 13.5 | 0 | 0 | - |
| builder | 19 | 600,000,000 | 250 | 20.6 | 29,113,765 | 32.3 | 0.653 | 0.0317 | - |
| growth | 89 | 3,000,000,000 | 1000 | 20.6 | 145,568,825 | 40.4 | 0.611 | 0.0297 | - |
| scale | 599 | 20,000,000,000 | 3000 | 20.6 | 970,458,831 | 89.9 | 0.617 | 0.0300 | - |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/head-tier-after-2` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
