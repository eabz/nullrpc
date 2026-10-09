# nullrpc benchmark 20261009T172945Z

Target https://hoodi.nullrpc.dev (internal key), head 3784205, archived through 3783974, generation 184.

## Calls

Each case repeated 8 times, 4 in flight, shuffled. `r2/call` is the Worker's reported R2 misses per call; `resp-cache` the share of answers served from the response cache.

### normal

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_chainId | 8 | 8 | 0 | 0 | 70ms | 205ms | 205ms | 5 | 0.0 | - |
| eth_blockNumber | 8 | 8 | 0 | 0 | 57ms | 235ms | 235ms | 10 | 0.0 | - |
| eth_gasPrice | 8 | 8 | 0 | 0 | 172ms | 305ms | 305ms | 10 | 0.0 | - |
| eth_maxPriorityFeePerGas | 8 | 8 | 0 | 0 | 178ms | 323ms | 323ms | 10 | 0.0 | - |
| eth_feeHistory 4 | 8 | 8 | 0 | 0 | 106ms | 336ms | 336ms | 20 | 0.1 | - |
| eth_getBlockByNumber latest hashes | 8 | 8 | 0 | 0 | 158ms | 709ms | 709ms | 20 | 0.1 | - |
| eth_getBlockByNumber recent hashes | 8 | 8 | 0 | 0 | 58ms | 219ms | 219ms | 20 | 0.0 | - |
| eth_getBlockByHash recent | 8 | 8 | 0 | 0 | 137ms | 308ms | 308ms | 20 | 0.0 | 0% |
| eth_getBlockTransactionCountByNumber | 8 | 8 | 0 | 0 | 85ms | 560ms | 560ms | 15 | 0.0 | - |
| eth_getBalance latest | 8 | 8 | 0 | 0 | 232ms | 289ms | 289ms | 15 | 0.0 | - |
| eth_getTransactionCount latest | 8 | 8 | 0 | 0 | 272ms | 512ms | 512ms | 15 | 0.0 | - |
| eth_getCode latest | 8 | 8 | 0 | 0 | 352ms | 648ms | 648ms | 15 | 0.0 | - |
| eth_getStorageAt latest | 8 | 8 | 0 | 0 | 225ms | 353ms | 353ms | 15 | 0.0 | - |
| eth_getTransactionByHash recent | 8 | 8 | 0 | 0 | 72ms | 307ms | 307ms | 15 | 0.0 | 0% |
| eth_getTransactionReceipt recent | 8 | 8 | 0 | 0 | 154ms | 260ms | 260ms | 15 | 0.0 | 0% |
| eth_getTransactionByBlockNumberAndIndex | 8 | 8 | 0 | 0 | 70ms | 230ms | 230ms | 15 | 0.0 | - |
| eth_getLogs 10 blocks, token | 8 | 8 | 0 | 0 | 198ms | 301ms | 301ms | 50 | 0.0 | - |
| eth_call balanceOf | 8 | 8 | 0 | 0 | 427ms | 1.64s | 1.64s | 30 | 0.0 | - |
| eth_estimateGas transfer | 8 | 8 | 0 | 0 | 288ms | 698ms | 698ms | 50 | 0.1 | - |
| web3_clientVersion | 8 | 8 | 0 | 0 | 58ms | 264ms | 264ms | 5 | 0.0 | - |
| net_version | 8 | 8 | 0 | 0 | 163ms | 357ms | 357ms | 5 | 0.0 | - |

### heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber recent full | 8 | 8 | 0 | 0 | 64ms | 689ms | 689ms | 20 | 0.0 | - |
| eth_getBlockReceipts recent | 8 | 8 | 0 | 0 | 165ms | 221ms | 221ms | 30 | 0.0 | - |
| eth_getLogs 1000 blocks, no filter | 8 | 0 | 8 | 0 | 74ms | 565ms | 565ms | 55 | 0.0 | - |
| eth_getLogs 10000 blocks, token | 8 | 1 | 7 | 0 | 141ms | 3.40s | 3.40s | 95 | 0.0 | - |
| eth_getLogs 1000 blocks, Transfer topic | 8 | 8 | 0 | 0 | 1.45s | 2.49s | 2.49s | 55 | 0.0 | - |
| eth_call real calldata latest | 8 | 6 | 2 | 0 | 383ms | 23.30s | 23.30s | 30 | 1.3 | - |
| eth_estimateGas real calldata | 8 | 7 | 1 | 0 | 894ms | 2.65s | 2.65s | 50 | 3.4 | - |
| eth_createAccessList | 8 | 8 | 0 | 0 | 917ms | 2.61s | 2.61s | 20 | 2.0 | - |
| debug_traceCall callTracer | 8 | 8 | 0 | 0 | 776ms | 9.05s | 9.05s | 40 | 1.6 | - |
| trace_call | 8 | 8 | 0 | 0 | 556ms | 1.09s | 1.09s | 40 | 0.6 | - |
| debug_traceTransaction recent | 8 | 8 | 0 | 0 | 404ms | 1.11s | 1.11s | 40 | 1.1 | - |
| trace_transaction recent | 8 | 8 | 0 | 0 | 494ms | 1.08s | 1.08s | 40 | 0.5 | - |
| trace_replayTransaction recent | 8 | 8 | 0 | 0 | 734ms | 1.42s | 1.42s | 80 | 0.5 | - |
| debug_traceBlockByNumber recent | 8 | 8 | 0 | 0 | 519ms | 1.94s | 1.94s | 40 | 0.0 | - |
| debug_traceBlockByHash recent | 8 | 8 | 0 | 0 | 882ms | 2.42s | 2.42s | 40 | 1.3 | - |
| trace_block recent | 8 | 8 | 0 | 0 | 508ms | 1.46s | 1.46s | 40 | 0.4 | - |
| trace_replayBlockTransactions recent | 8 | 8 | 0 | 0 | 421ms | 1.12s | 1.12s | 80 | 0.0 | - |
| debug_getRawBlock recent | 8 | 8 | 0 | 0 | 66ms | 179ms | 179ms | 20 | 0.0 | - |
| debug_getRawReceipts recent | 8 | 8 | 0 | 0 | 70ms | 298ms | 298ms | 30 | 0.0 | - |
| batch of 10 mixed | 8 | 8 | 0 | 0 | 506ms | 995ms | 995ms | 170 | 0.0 | - |

### deep

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep hashes | 8 | 8 | 0 | 0 | 80ms | 307ms | 307ms | 20 | 0.0 | 13% |
| eth_getBlockByHash deep | 8 | 8 | 0 | 0 | 264ms | 1.16s | 1.16s | 20 | 2.3 | 38% |
| eth_getBalance deep | 8 | 8 | 0 | 0 | 268ms | 512ms | 512ms | 15 | 0.9 | 0% |
| eth_getTransactionCount deep | 8 | 8 | 0 | 0 | 281ms | 832ms | 832ms | 15 | 1.1 | 0% |
| eth_getCode deep | 8 | 8 | 0 | 0 | 86ms | 568ms | 568ms | 15 | 0.1 | 13% |
| eth_getStorageAt deep | 8 | 8 | 0 | 0 | 131ms | 780ms | 780ms | 15 | 0.1 | 13% |
| eth_getTransactionByHash deep | 8 | 8 | 0 | 0 | 408ms | 901ms | 901ms | 15 | 4.8 | 13% |
| eth_getTransactionReceipt deep | 8 | 8 | 0 | 0 | 494ms | 947ms | 947ms | 15 | 4.8 | 0% |
| eth_getLogs 10 blocks deep | 8 | 8 | 0 | 0 | 89ms | 328ms | 328ms | 50 | 0.5 | 50% |
| eth_feeHistory 4 deep | 8 | 8 | 0 | 0 | 166ms | 489ms | 489ms | 20 | 2.0 | - |
| debug_getRawHeader deep | 8 | 8 | 0 | 0 | 151ms | 305ms | 305ms | 15 | 0.0 | 25% |

### deep-heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep full | 8 | 8 | 0 | 0 | 80ms | 310ms | 310ms | 20 | 0.0 | 100% |
| eth_getBlockReceipts deep | 8 | 8 | 0 | 0 | 166ms | 459ms | 459ms | 30 | 0.0 | 75% |
| eth_getLogs 1000 blocks deep | 8 | 2 | 6 | 0 | 484ms | 1.01s | 1.01s | 50 | 1.5 | 100% |
| eth_getLogs 10000 blocks deep, Transfer | 8 | 0 | 8 | 0 | 166ms | 282ms | 282ms | 95 | 0.0 | - |
| eth_call replay at n-1 | 8 | 6 | 2 | 0 | 846ms | 1.16s | 1.16s | 30 | 2.1 | - |
| eth_estimateGas replay at n-1 | 8 | 6 | 2 | 0 | 936ms | 2.28s | 2.28s | 50 | 10.5 | - |
| debug_traceCall replay at n-1 | 8 | 8 | 0 | 0 | 800ms | 2.69s | 2.69s | 40 | 7.8 | - |
| debug_traceTransaction deep | 8 | 8 | 0 | 0 | 1.12s | 1.89s | 1.89s | 40 | 4.9 | - |
| trace_transaction deep | 8 | 8 | 0 | 0 | 951ms | 3.60s | 3.60s | 40 | 10.4 | - |
| trace_replayTransaction deep | 8 | 8 | 0 | 0 | 1.55s | 2.24s | 2.24s | 80 | 8.0 | - |
| debug_traceBlockByNumber deep | 8 | 8 | 0 | 0 | 873ms | 2.34s | 2.34s | 40 | 3.3 | - |
| trace_block deep | 8 | 8 | 0 | 0 | 329ms | 1.33s | 1.33s | 40 | 1.0 | - |
| trace_replayBlockTransactions deep | 8 | 8 | 0 | 0 | 432ms | 2.55s | 2.55s | 80 | 2.6 | - |
| debug_getRawBlock deep | 8 | 8 | 0 | 0 | 173ms | 284ms | 284ms | 20 | 0.0 | 25% |
| debug_getRawReceipts deep | 8 | 8 | 0 | 0 | 99ms | 255ms | 255ms | 30 | 0.0 | 25% |

## Normal user scenario

25 simulated wallet users for 60s, each looping a 15-step session (connect, balances, fee quote, estimate, confirmation, history) with 150 to 600ms of think time between steps. 159 sessions completed, 154 without a failed step; a session costs about 288 credits and takes 9.19s at the median.

| step | n | ok | refused | err | p50 | p95 | max | credits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| connect: eth_chainId | 159 | 159 | 0 | 0 | 51ms | 764ms | 847ms | 5 |
| connect: eth_blockNumber | 159 | 159 | 0 | 0 | 54ms | 199ms | 353ms | 10 |
| balance: eth_getBalance | 156 | 156 | 0 | 0 | 200ms | 428ms | 614ms | 15 |
| balance: eth_call balanceOf | 153 | 151 | 0 | 2 | 396ms | 914ms | 25.14s | 30 |
| balance: eth_call balanceOf 2 | 151 | 148 | 0 | 3 | 435ms | 997ms | 25.22s | 30 |
| send: eth_getTransactionCount | 150 | 150 | 0 | 0 | 195ms | 377ms | 466ms | 15 |
| send: eth_gasPrice | 149 | 149 | 0 | 0 | 97ms | 376ms | 543ms | 10 |
| send: eth_maxPriorityFeePerGas | 147 | 147 | 0 | 0 | 93ms | 232ms | 519ms | 10 |
| send: eth_feeHistory | 145 | 145 | 0 | 0 | 66ms | 315ms | 406ms | 20 |
| send: eth_estimateGas | 144 | 134 | 10 | 0 | 300ms | 685ms | 2.09s | 50 |
| confirm: eth_getTransactionReceipt | 143 | 143 | 0 | 0 | 68ms | 272ms | 595ms | 15 |
| confirm: eth_getTransactionByHash | 142 | 142 | 0 | 0 | 72ms | 266ms | 632ms | 15 |
| confirm: eth_getBlockByNumber latest | 137 | 137 | 0 | 0 | 56ms | 280ms | 1.55s | 20 |
| history: eth_getLogs transfers to me | 137 | 137 | 0 | 0 | 957ms | 1.61s | 2.78s | 50 |
| history: eth_getBlockByNumber recent | 135 | 135 | 0 | 0 | 56ms | 271ms | 421ms | 20 |

Free plan: 20M credits is about 69,554 such sessions a month; Builder: 2,086,614.

## Plan economics

Credits per request from the measured user mix (20.7). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.7 | 482,721 | 13.4 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.7 | 965,442 | 13.4 | 0 | 0 | - |
| builder | 19 | 600,000,000 | 250 | 20.7 | 28,963,255 | 32.2 | 0.656 | 0.0317 | - |
| growth | 89 | 3,000,000,000 | 1000 | 20.7 | 144,816,273 | 40.2 | 0.615 | 0.0297 | - |
| scale | 599 | 20,000,000,000 | 3000 | 20.7 | 965,441,820 | 89.4 | 0.620 | 0.0300 | - |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/20261009T172605Z-milestone` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
