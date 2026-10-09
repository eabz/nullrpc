# nullrpc benchmark 20261009T153300Z

Target https://hoodi.nullrpc.dev (internal key), head 3783680, archived through 3783458, generation 176.

## Calls

Each case repeated 8 times, 4 in flight, shuffled. `r2/call` is the Worker's reported R2 misses per call; `resp-cache` the share of answers served from the response cache.

### normal

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_chainId | 8 | 8 | 0 | 0 | 53ms | 252ms | 252ms | 5 | 0.0 | - |
| eth_blockNumber | 8 | 8 | 0 | 0 | 58ms | 155ms | 155ms | 10 | 0.0 | - |
| eth_gasPrice | 8 | 8 | 0 | 0 | 205ms | 402ms | 402ms | 10 | 0.3 | - |
| eth_maxPriorityFeePerGas | 8 | 8 | 0 | 0 | 122ms | 272ms | 272ms | 10 | 0.0 | - |
| eth_feeHistory 4 | 8 | 8 | 0 | 0 | 135ms | 293ms | 293ms | 20 | 0.0 | - |
| eth_getBlockByNumber latest hashes | 8 | 8 | 0 | 0 | 161ms | 400ms | 400ms | 20 | 0.1 | - |
| eth_getBlockByNumber recent hashes | 8 | 8 | 0 | 0 | 60ms | 271ms | 271ms | 20 | 0.0 | - |
| eth_getBlockByHash recent | 8 | 8 | 0 | 0 | 152ms | 252ms | 252ms | 20 | 0.0 | 0% |
| eth_getBlockTransactionCountByNumber | 8 | 8 | 0 | 0 | 166ms | 378ms | 378ms | 15 | 0.0 | - |
| eth_getBalance latest | 8 | 8 | 0 | 0 | 215ms | 367ms | 367ms | 15 | 0.0 | - |
| eth_getTransactionCount latest | 8 | 8 | 0 | 0 | 249ms | 386ms | 386ms | 15 | 0.0 | - |
| eth_getCode latest | 8 | 8 | 0 | 0 | 379ms | 523ms | 523ms | 15 | 0.0 | - |
| eth_getStorageAt latest | 8 | 8 | 0 | 0 | 267ms | 417ms | 417ms | 15 | 0.0 | - |
| eth_getTransactionByHash recent | 8 | 8 | 0 | 0 | 116ms | 395ms | 395ms | 15 | 0.3 | 0% |
| eth_getTransactionReceipt recent | 8 | 8 | 0 | 0 | 101ms | 261ms | 261ms | 15 | 0.0 | 0% |
| eth_getTransactionByBlockNumberAndIndex | 8 | 8 | 0 | 0 | 86ms | 222ms | 222ms | 15 | 0.0 | - |
| eth_getLogs 10 blocks, token | 8 | 8 | 0 | 0 | 149ms | 242ms | 242ms | 50 | 0.0 | - |
| eth_call balanceOf | 8 | 8 | 0 | 0 | 537ms | 838ms | 838ms | 30 | 0.6 | - |
| eth_estimateGas transfer | 8 | 7 | 1 | 0 | 409ms | 2.30s | 2.30s | 50 | 0.5 | - |
| web3_clientVersion | 8 | 8 | 0 | 0 | 133ms | 226ms | 226ms | 5 | 0.0 | - |
| net_version | 8 | 8 | 0 | 0 | 56ms | 157ms | 157ms | 5 | 0.0 | - |

### heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber recent full | 8 | 8 | 0 | 0 | 117ms | 409ms | 409ms | 20 | 0.0 | - |
| eth_getBlockReceipts recent | 8 | 8 | 0 | 0 | 173ms | 232ms | 232ms | 30 | 0.0 | - |
| eth_getLogs 1000 blocks, no filter | 8 | 0 | 8 | 0 | 190ms | 305ms | 305ms | 55 | 0.0 | - |
| eth_getLogs 10000 blocks, token | 8 | 1 | 7 | 0 | 120ms | 5.19s | 5.19s | 95 | 10.0 | - |
| eth_getLogs 1000 blocks, Transfer topic | 8 | 8 | 0 | 0 | 2.97s | 4.82s | 4.82s | 55 | 0.3 | - |
| eth_call real calldata latest | 8 | 2 | 6 | 0 | 695ms | 8.39s | 8.39s | 30 | 0.5 | - |
| eth_estimateGas real calldata | 8 | 3 | 5 | 0 | 609ms | 23.00s | 23.00s | 50 | 0.9 | - |
| eth_createAccessList | 8 | 8 | 0 | 0 | 720ms | 1.31s | 1.31s | 20 | 1.1 | - |
| debug_traceCall callTracer | 8 | 8 | 0 | 0 | 653ms | 8.24s | 8.24s | 40 | 0.5 | - |
| trace_call | 8 | 8 | 0 | 0 | 630ms | 946ms | 946ms | 40 | 0.8 | - |
| debug_traceTransaction recent | 8 | 8 | 0 | 0 | 526ms | 915ms | 915ms | 40 | 0.0 | - |
| trace_transaction recent | 8 | 8 | 0 | 0 | 323ms | 526ms | 526ms | 40 | 0.5 | - |
| trace_replayTransaction recent | 8 | 8 | 0 | 0 | 646ms | 988ms | 988ms | 80 | 0.9 | - |
| debug_traceBlockByNumber recent | 8 | 8 | 0 | 0 | 861ms | 1.49s | 1.49s | 40 | 0.5 | - |
| debug_traceBlockByHash recent | 8 | 8 | 0 | 0 | 915ms | 1.53s | 1.53s | 40 | 1.4 | - |
| trace_block recent | 8 | 8 | 0 | 0 | 672ms | 942ms | 942ms | 40 | 0.0 | - |
| trace_replayBlockTransactions recent | 8 | 8 | 0 | 0 | 603ms | 977ms | 977ms | 80 | 0.0 | - |
| debug_getRawBlock recent | 8 | 8 | 0 | 0 | 141ms | 194ms | 194ms | 20 | 0.0 | - |
| debug_getRawReceipts recent | 8 | 8 | 0 | 0 | 95ms | 237ms | 237ms | 30 | 0.0 | - |
| batch of 10 mixed | 8 | 8 | 0 | 0 | 445ms | 1.05s | 1.05s | 170 | 0.4 | - |

### deep

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep hashes | 8 | 8 | 0 | 0 | 116ms | 256ms | 256ms | 20 | 0.0 | 25% |
| eth_getBlockByHash deep | 8 | 8 | 0 | 0 | 294ms | 600ms | 600ms | 20 | 1.8 | 38% |
| eth_getBalance deep | 8 | 8 | 0 | 0 | 204ms | 719ms | 719ms | 15 | 0.6 | 0% |
| eth_getTransactionCount deep | 8 | 8 | 0 | 0 | 282ms | 474ms | 474ms | 15 | 1.1 | 0% |
| eth_getCode deep | 8 | 8 | 0 | 0 | 193ms | 390ms | 390ms | 15 | 0.1 | 13% |
| eth_getStorageAt deep | 8 | 8 | 0 | 0 | 109ms | 225ms | 225ms | 15 | 0.1 | 13% |
| eth_getTransactionByHash deep | 8 | 8 | 0 | 0 | 566ms | 865ms | 865ms | 15 | 2.8 | 25% |
| eth_getTransactionReceipt deep | 8 | 8 | 0 | 0 | 501ms | 987ms | 987ms | 15 | 3.3 | 0% |
| eth_getLogs 10 blocks deep | 8 | 8 | 0 | 0 | 235ms | 589ms | 589ms | 50 | 0.6 | 38% |
| eth_feeHistory 4 deep | 8 | 8 | 0 | 0 | 151ms | 312ms | 312ms | 20 | 1.9 | - |
| debug_getRawHeader deep | 8 | 8 | 0 | 0 | 163ms | 284ms | 284ms | 15 | 0.0 | 25% |

### deep-heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep full | 8 | 8 | 0 | 0 | 95ms | 204ms | 204ms | 20 | 0.0 | 100% |
| eth_getBlockReceipts deep | 8 | 8 | 0 | 0 | 145ms | 217ms | 217ms | 30 | 0.0 | 50% |
| eth_getLogs 1000 blocks deep | 8 | 2 | 6 | 0 | 1.29s | 2.03s | 2.03s | 50 | 2.3 | 50% |
| eth_getLogs 10000 blocks deep, Transfer | 8 | 0 | 8 | 0 | 100ms | 289ms | 289ms | 95 | 0.0 | - |
| eth_call replay at n-1 | 8 | 8 | 0 | 0 | 648ms | 986ms | 986ms | 30 | 1.8 | - |
| eth_estimateGas replay at n-1 | 8 | 6 | 2 | 0 | 820ms | 1.51s | 1.51s | 50 | 3.1 | - |
| debug_traceCall replay at n-1 | 8 | 8 | 0 | 0 | 577ms | 1.19s | 1.19s | 40 | 1.8 | - |
| debug_traceTransaction deep | 8 | 8 | 0 | 0 | 745ms | 1.48s | 1.48s | 40 | 3.8 | - |
| trace_transaction deep | 8 | 8 | 0 | 0 | 1.12s | 1.50s | 1.50s | 40 | 4.8 | - |
| trace_replayTransaction deep | 8 | 8 | 0 | 0 | 1.11s | 2.24s | 2.24s | 80 | 7.9 | - |
| debug_traceBlockByNumber deep | 8 | 8 | 0 | 0 | 710ms | 2.44s | 2.44s | 40 | 2.8 | - |
| trace_block deep | 8 | 8 | 0 | 0 | 758ms | 981ms | 981ms | 40 | 1.4 | - |
| trace_replayBlockTransactions deep | 8 | 8 | 0 | 0 | 499ms | 2.76s | 2.76s | 80 | 6.8 | - |
| debug_getRawBlock deep | 8 | 8 | 0 | 0 | 195ms | 243ms | 243ms | 20 | 0.0 | 25% |
| debug_getRawReceipts deep | 8 | 8 | 0 | 0 | 119ms | 199ms | 199ms | 30 | 0.0 | 25% |

## Normal user scenario

25 simulated wallet users for 60s, each looping a 15-step session (connect, balances, fee quote, estimate, confirmation, history) with 150 to 600ms of think time between steps. 150 sessions completed, 150 without a failed step; a session costs about 279 credits and takes 10.71s at the median.

| step | n | ok | refused | err | p50 | p95 | max | credits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| connect: eth_chainId | 150 | 150 | 0 | 0 | 129ms | 605ms | 682ms | 5 |
| connect: eth_blockNumber | 150 | 150 | 0 | 0 | 129ms | 293ms | 774ms | 10 |
| balance: eth_getBalance | 148 | 148 | 0 | 0 | 270ms | 557ms | 5.96s | 15 |
| balance: eth_call balanceOf | 146 | 146 | 0 | 0 | 496ms | 1.02s | 3.29s | 30 |
| balance: eth_call balanceOf 2 | 143 | 143 | 0 | 0 | 502ms | 1.07s | 3.23s | 30 |
| send: eth_getTransactionCount | 138 | 138 | 0 | 0 | 253ms | 441ms | 698ms | 15 |
| send: eth_gasPrice | 135 | 135 | 0 | 0 | 194ms | 539ms | 959ms | 10 |
| send: eth_maxPriorityFeePerGas | 131 | 131 | 0 | 0 | 188ms | 674ms | 1.58s | 10 |
| send: eth_feeHistory | 130 | 130 | 0 | 0 | 126ms | 369ms | 1.23s | 20 |
| send: eth_estimateGas | 127 | 118 | 9 | 0 | 373ms | 700ms | 1.05s | 50 |
| confirm: eth_getTransactionReceipt | 125 | 125 | 0 | 0 | 111ms | 514ms | 1.41s | 15 |
| confirm: eth_getTransactionByHash | 125 | 125 | 0 | 0 | 137ms | 479ms | 591ms | 15 |
| confirm: eth_getBlockByNumber latest | 125 | 125 | 0 | 0 | 91ms | 446ms | 1.48s | 20 |
| history: eth_getLogs transfers to me | 125 | 125 | 0 | 0 | 1.58s | 3.57s | 4.78s | 50 |
| history: eth_getBlockByNumber recent | 125 | 125 | 0 | 0 | 109ms | 390ms | 868ms | 20 |

Free plan: 20M credits is about 71,736 such sessions a month; Builder: 2,152,080.

## Stress at each plan's rate

The user mix sent open-loop at each plan's requests-per-second cap for 20s with one internal key (no limits), from one client (at most 600 in flight; "dropped" counts sends the client skipped because it was full, a client limit, not the endpoint's).

| plan | target rps | achieved | n | ok | refused | 429 | err | err % | p50 | p95 | p99 | credits/req | r2/call | client dropped |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| free | 20 | 18 | 420 | 416 | 4 | 0 | 0 | 0.00 | 242ms | 2.62s | 3.22s | 21.7 | 0.03 | 0 |
| builder | 250 | 76 | 2907 | 2633 | 6 | 0 | 268 | 9.22 | 3.85s | 11.12s | 11.55s | 21.1 | 0.03 | 2343 |
| growth | 1000 | 239 | 10800 | 10542 | 21 | 0 | 237 | 2.19 | 476ms | 5.99s | 9.34s | 21.1 | 0.03 | 10200 |
| scale | 3000 | 138 | 6115 | 6076 | 11 | 0 | 28 | 0.46 | 410ms | 12.44s | 16.49s | 20.9 | 0.03 | 56880 |

## Plan economics

Credits per request from the measured user mix (21.7). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 21.7 | 460,526 | 12.8 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 21.7 | 921,053 | 12.8 | 0 | 0 | 242ms / 3.22s / 0.0% |
| builder | 19 | 600,000,000 | 250 | 21.7 | 27,631,579 | 30.7 | 0.688 | 0.0317 | 3.85s / 11.55s / 9.2% |
| growth | 89 | 3,000,000,000 | 1000 | 21.7 | 138,157,895 | 38.4 | 0.644 | 0.0297 | 476ms / 9.34s / 2.2% |
| scale | 599 | 20,000,000,000 | 3000 | 21.7 | 921,052,632 | 85.3 | 0.650 | 0.0300 | 410ms / 16.49s / 0.5% |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/20261009T153300Z-milestone` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
