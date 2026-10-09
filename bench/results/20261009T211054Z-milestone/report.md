# nullrpc benchmark 20261009T211316Z

Target https://hoodi.nullrpc.dev (internal key), head 3785206, archived through 3785012, generation 201.

## Calls

Each case repeated 8 times, 4 in flight, shuffled. `r2/call` is the Worker's reported R2 misses per call; `resp-cache` the share of answers served from the response cache.

### normal

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_chainId | 8 | 8 | 0 | 0 | 154ms | 252ms | 252ms | 5 | 0.0 | - |
| eth_blockNumber | 8 | 8 | 0 | 0 | 157ms | 193ms | 193ms | 10 | 0.0 | 75% |
| eth_gasPrice | 8 | 8 | 0 | 0 | 79ms | 249ms | 249ms | 10 | 0.0 | 63% |
| eth_maxPriorityFeePerGas | 8 | 8 | 0 | 0 | 108ms | 411ms | 411ms | 10 | 0.0 | 75% |
| eth_feeHistory 4 | 8 | 8 | 0 | 0 | 181ms | 467ms | 467ms | 20 | 0.1 | 63% |
| eth_getBlockByNumber latest hashes | 8 | 8 | 0 | 0 | 175ms | 269ms | 269ms | 20 | 0.0 | 63% |
| eth_getBlockByNumber recent hashes | 8 | 8 | 0 | 0 | 176ms | 275ms | 275ms | 20 | 0.0 | 13% |
| eth_getBlockByHash recent | 8 | 8 | 0 | 0 | 181ms | 267ms | 267ms | 20 | 0.0 | 13% |
| eth_getBlockTransactionCountByNumber | 8 | 8 | 0 | 0 | 80ms | 210ms | 210ms | 15 | 0.0 | 38% |
| eth_getBalance latest | 8 | 8 | 0 | 0 | 226ms | 364ms | 364ms | 15 | 0.0 | 0% |
| eth_getTransactionCount latest | 8 | 8 | 0 | 0 | 217ms | 610ms | 610ms | 15 | 0.0 | 0% |
| eth_getCode latest | 8 | 8 | 0 | 0 | 370ms | 492ms | 492ms | 15 | 0.0 | 38% |
| eth_getStorageAt latest | 8 | 8 | 0 | 0 | 339ms | 447ms | 447ms | 15 | 0.0 | 0% |
| eth_getTransactionByHash recent | 8 | 8 | 0 | 0 | 106ms | 281ms | 281ms | 15 | 0.0 | 0% |
| eth_getTransactionReceipt recent | 8 | 8 | 0 | 0 | 192ms | 458ms | 458ms | 15 | 0.1 | 0% |
| eth_getTransactionByBlockNumberAndIndex | 8 | 8 | 0 | 0 | 163ms | 286ms | 286ms | 15 | 0.0 | 0% |
| eth_getLogs 10 blocks, token | 8 | 8 | 0 | 0 | 145ms | 288ms | 288ms | 50 | 0.0 | 25% |
| eth_call balanceOf | 8 | 8 | 0 | 0 | 542ms | 860ms | 860ms | 30 | 0.5 | 0% |
| eth_estimateGas transfer | 8 | 7 | 1 | 0 | 378ms | 10.63s | 10.63s | 50 | 1.5 | 0% |
| web3_clientVersion | 8 | 8 | 0 | 0 | 150ms | 300ms | 300ms | 5 | 0.0 | - |
| net_version | 8 | 8 | 0 | 0 | 81ms | 268ms | 268ms | 5 | 0.0 | - |

### heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber recent full | 8 | 8 | 0 | 0 | 176ms | 359ms | 359ms | 20 | 0.0 | 0% |
| eth_getBlockReceipts recent | 8 | 8 | 0 | 0 | 113ms | 330ms | 330ms | 30 | 0.0 | 0% |
| eth_getLogs 1000 blocks, no filter | 8 | 0 | 8 | 0 | 132ms | 357ms | 357ms | 55 | 0.0 | - |
| eth_getLogs 10000 blocks, token | 8 | 7 | 1 | 0 | 2.38s | 4.89s | 4.89s | 95 | 10.0 | 14% |
| eth_getLogs 1000 blocks, Transfer topic | 8 | 8 | 0 | 0 | 445ms | 2.75s | 2.75s | 55 | 0.1 | 63% |
| eth_call real calldata latest | 8 | 4 | 4 | 0 | 1.66s | 15.65s | 15.65s | 30 | 0.5 | 0% |
| eth_estimateGas real calldata | 8 | 2 | 6 | 0 | 712ms | 10.86s | 10.86s | 50 | 1.1 | 0% |
| eth_createAccessList | 8 | 8 | 0 | 0 | 1.19s | 5.45s | 5.45s | 20 | 6.4 | - |
| debug_traceCall callTracer | 8 | 8 | 0 | 0 | 496ms | 8.37s | 8.37s | 40 | 3.3 | - |
| trace_call | 8 | 8 | 0 | 0 | 2.16s | 22.83s | 22.83s | 40 | 7.0 | - |
| debug_traceTransaction recent | 8 | 8 | 0 | 0 | 604ms | 791ms | 791ms | 40 | 0.9 | - |
| trace_transaction recent | 8 | 8 | 0 | 0 | 514ms | 10.64s | 10.64s | 40 | 0.4 | - |
| trace_replayTransaction recent | 8 | 8 | 0 | 0 | 409ms | 1.21s | 1.21s | 80 | 1.1 | - |
| debug_traceBlockByNumber recent | 8 | 8 | 0 | 0 | 874ms | 1.43s | 1.43s | 40 | 0.4 | - |
| debug_traceBlockByHash recent | 8 | 8 | 0 | 0 | 798ms | 1.95s | 1.95s | 40 | 1.3 | - |
| trace_block recent | 8 | 8 | 0 | 0 | 684ms | 812ms | 812ms | 40 | 0.0 | - |
| trace_replayBlockTransactions recent | 8 | 8 | 0 | 0 | 498ms | 1.17s | 1.17s | 80 | 0.0 | - |
| debug_getRawBlock recent | 8 | 8 | 0 | 0 | 97ms | 259ms | 259ms | 20 | 0.0 | 13% |
| debug_getRawReceipts recent | 8 | 8 | 0 | 0 | 96ms | 413ms | 413ms | 30 | 0.0 | 13% |
| batch of 10 mixed | 8 | 8 | 0 | 0 | 495ms | 755ms | 755ms | 170 | 0.3 | 100% |

### deep

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep hashes | 8 | 8 | 0 | 0 | 149ms | 460ms | 460ms | 20 | 0.0 | 13% |
| eth_getBlockByHash deep | 8 | 8 | 0 | 0 | 271ms | 958ms | 958ms | 20 | 1.8 | 38% |
| eth_getBalance deep | 8 | 8 | 0 | 0 | 366ms | 696ms | 696ms | 15 | 0.9 | 0% |
| eth_getTransactionCount deep | 8 | 8 | 0 | 0 | 311ms | 477ms | 477ms | 15 | 0.9 | 0% |
| eth_getCode deep | 8 | 8 | 0 | 0 | 148ms | 484ms | 484ms | 15 | 0.1 | 13% |
| eth_getStorageAt deep | 8 | 8 | 0 | 0 | 197ms | 455ms | 455ms | 15 | 0.1 | 13% |
| eth_getTransactionByHash deep | 8 | 8 | 0 | 0 | 503ms | 1.06s | 1.06s | 15 | 3.9 | 13% |
| eth_getTransactionReceipt deep | 8 | 8 | 0 | 0 | 614ms | 1.15s | 1.15s | 15 | 5.5 | 13% |
| eth_getLogs 10 blocks deep | 8 | 8 | 0 | 0 | 185ms | 488ms | 488ms | 50 | 0.5 | 50% |
| eth_feeHistory 4 deep | 8 | 8 | 0 | 0 | 187ms | 342ms | 342ms | 20 | 1.9 | 38% |
| debug_getRawHeader deep | 8 | 8 | 0 | 0 | 103ms | 325ms | 325ms | 15 | 0.0 | 25% |

### deep-heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep full | 8 | 8 | 0 | 0 | 173ms | 566ms | 566ms | 20 | 0.0 | 100% |
| eth_getBlockReceipts deep | 8 | 8 | 0 | 0 | 127ms | 269ms | 269ms | 30 | 0.0 | 50% |
| eth_getLogs 1000 blocks deep | 8 | 2 | 6 | 0 | 448ms | 983ms | 983ms | 50 | 2.0 | 100% |
| eth_getLogs 10000 blocks deep, Transfer | 8 | 0 | 8 | 0 | 119ms | 310ms | 310ms | 95 | 0.0 | - |
| eth_call replay at n-1 | 8 | 8 | 0 | 0 | 626ms | 1.62s | 1.62s | 30 | 1.8 | 0% |
| eth_estimateGas replay at n-1 | 8 | 8 | 0 | 0 | 479ms | 1.66s | 1.66s | 50 | 2.9 | 13% |
| debug_traceCall replay at n-1 | 8 | 8 | 0 | 0 | 818ms | 1.84s | 1.84s | 40 | 5.6 | - |
| debug_traceTransaction deep | 8 | 8 | 0 | 0 | 993ms | 2.01s | 2.01s | 40 | 3.8 | - |
| trace_transaction deep | 8 | 8 | 0 | 0 | 854ms | 2.09s | 2.09s | 40 | 8.4 | - |
| trace_replayTransaction deep | 8 | 8 | 0 | 0 | 909ms | 2.05s | 2.05s | 80 | 6.8 | - |
| debug_traceBlockByNumber deep | 8 | 8 | 0 | 0 | 886ms | 1.68s | 1.68s | 40 | 1.1 | - |
| trace_block deep | 8 | 8 | 0 | 0 | 646ms | 1.45s | 1.45s | 40 | 0.6 | - |
| trace_replayBlockTransactions deep | 8 | 8 | 0 | 0 | 673ms | 2.33s | 2.33s | 80 | 4.4 | - |
| debug_getRawBlock deep | 8 | 8 | 0 | 0 | 193ms | 409ms | 409ms | 20 | 0.0 | 25% |
| debug_getRawReceipts deep | 8 | 8 | 0 | 0 | 213ms | 425ms | 425ms | 30 | 0.0 | 25% |

## Normal user scenario

25 simulated wallet users for 60s, each looping a 15-step session (connect, balances, fee quote, estimate, confirmation, history) with 150 to 600ms of think time between steps. 175 sessions completed, 175 without a failed step; a session costs about 303 credits and takes 8.79s at the median.

| step | n | ok | refused | err | p50 | p95 | max | credits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| connect: eth_chainId | 175 | 175 | 0 | 0 | 70ms | 553ms | 660ms | 5 |
| connect: eth_blockNumber | 175 | 175 | 0 | 0 | 77ms | 308ms | 437ms | 10 |
| balance: eth_getBalance | 175 | 175 | 0 | 0 | 218ms | 483ms | 1.15s | 15 |
| balance: eth_call balanceOf | 175 | 175 | 0 | 0 | 159ms | 790ms | 5.49s | 30 |
| balance: eth_call balanceOf 2 | 174 | 174 | 0 | 0 | 82ms | 538ms | 1.14s | 30 |
| send: eth_getTransactionCount | 174 | 174 | 0 | 0 | 214ms | 407ms | 688ms | 15 |
| send: eth_gasPrice | 171 | 171 | 0 | 0 | 74ms | 393ms | 1.12s | 10 |
| send: eth_maxPriorityFeePerGas | 170 | 170 | 0 | 0 | 74ms | 260ms | 1.82s | 10 |
| send: eth_feeHistory | 170 | 170 | 0 | 0 | 78ms | 284ms | 1.24s | 20 |
| send: eth_estimateGas | 170 | 154 | 16 | 0 | 311ms | 683ms | 2.45s | 50 |
| confirm: eth_getTransactionReceipt | 168 | 168 | 0 | 0 | 89ms | 312ms | 1.63s | 15 |
| confirm: eth_getTransactionByHash | 165 | 165 | 0 | 0 | 90ms | 407ms | 1.48s | 15 |
| confirm: eth_getBlockByNumber latest | 165 | 165 | 0 | 0 | 77ms | 291ms | 1.91s | 20 |
| history: eth_getLogs transfers to me | 162 | 162 | 0 | 0 | 881ms | 1.75s | 2.32s | 50 |
| history: eth_getBlockByNumber recent | 151 | 151 | 0 | 0 | 79ms | 276ms | 1.70s | 20 |

Free plan: 20M credits is about 65,969 such sessions a month; Builder: 1,979,078.

## Plan economics

Credits per request from the measured user mix (20.9). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.9 | 478,748 | 13.3 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.9 | 957,497 | 13.3 | 0 | 0 | - |
| builder | 19 | 600,000,000 | 250 | 20.9 | 28,724,908 | 31.9 | 0.661 | 0.0317 | - |
| growth | 89 | 3,000,000,000 | 1000 | 20.9 | 143,624,541 | 39.9 | 0.620 | 0.0297 | - |
| scale | 599 | 20,000,000,000 | 3000 | 20.9 | 957,496,937 | 88.7 | 0.626 | 0.0300 | - |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/20261009T211054Z-milestone` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
