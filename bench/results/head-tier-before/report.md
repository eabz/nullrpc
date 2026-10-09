# nullrpc benchmark 20261009T175914Z

Target https://hoodi.nullrpc.dev (keyless), head 3784334, archived through 3784234, generation 188.

## Normal user scenario

4 simulated wallet users for 60s, each looping a 15-step session (connect, balances, fee quote, estimate, confirmation, history) with 150 to 600ms of think time between steps. 31 sessions completed, 31 without a failed step; a session costs about 292 credits and takes 8.08s at the median.

| step | n | ok | refused | err | p50 | p95 | max | credits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| connect: eth_chainId | 31 | 31 | 0 | 0 | 51ms | 505ms | 506ms | 5 |
| connect: eth_blockNumber | 31 | 31 | 0 | 0 | 46ms | 212ms | 260ms | 10 |
| balance: eth_getBalance | 30 | 30 | 0 | 0 | 196ms | 421ms | 429ms | 15 |
| balance: eth_call balanceOf | 30 | 30 | 0 | 0 | 382ms | 952ms | 1.01s | 30 |
| balance: eth_call balanceOf 2 | 30 | 30 | 0 | 0 | 347ms | 522ms | 722ms | 30 |
| send: eth_getTransactionCount | 30 | 30 | 0 | 0 | 185ms | 462ms | 521ms | 15 |
| send: eth_gasPrice | 29 | 29 | 0 | 0 | 59ms | 257ms | 554ms | 10 |
| send: eth_maxPriorityFeePerGas | 28 | 28 | 0 | 0 | 63ms | 467ms | 1.17s | 10 |
| send: eth_feeHistory | 28 | 28 | 0 | 0 | 56ms | 362ms | 583ms | 20 |
| send: eth_estimateGas | 28 | 26 | 2 | 0 | 193ms | 1.21s | 1.35s | 50 |
| confirm: eth_getTransactionReceipt | 28 | 28 | 0 | 0 | 68ms | 262ms | 464ms | 15 |
| confirm: eth_getTransactionByHash | 28 | 28 | 0 | 0 | 66ms | 354ms | 360ms | 15 |
| confirm: eth_getBlockByNumber latest | 28 | 28 | 0 | 0 | 53ms | 236ms | 308ms | 20 |
| history: eth_getLogs transfers to me | 28 | 28 | 0 | 0 | 396ms | 702ms | 777ms | 50 |
| history: eth_getBlockByNumber recent | 28 | 28 | 0 | 0 | 55ms | 216ms | 586ms | 20 |

Free plan: 20M credits is about 68,470 such sessions a month; Builder: 2,054,114.

## Plan economics

Credits per request from the measured user mix (20.8). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.8 | 480,398 | 13.3 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.8 | 960,795 | 13.3 | 0 | 0 | - |
| builder | 19 | 600,000,000 | 250 | 20.8 | 28,823,854 | 32.0 | 0.659 | 0.0317 | - |
| growth | 89 | 3,000,000,000 | 1000 | 20.8 | 144,119,271 | 40.0 | 0.618 | 0.0297 | - |
| scale | 599 | 20,000,000,000 | 3000 | 20.8 | 960,795,141 | 89.0 | 0.623 | 0.0300 | - |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/head-tier-before` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
