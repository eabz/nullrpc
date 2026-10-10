# nullrpc benchmark 20261010T022757Z

Target https://hoodi.nullrpc.dev (internal key), head 3786607, archived through 3786375, generation 221.

## Calls

Each case repeated 8 times, 4 in flight, shuffled. p50, p95 and max are over successful answers (refusals and failures are counted in their columns, not timed). `r2/call` is the Worker's reported R2 misses per call; `resp-cache` the share of answers served from the response cache.

### normal

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_chainId | 8 | 8 | 0 | 0 | 62ms | 214ms | 214ms | 5 | 0.0 | - |
| eth_blockNumber | 8 | 8 | 0 | 0 | 70ms | 221ms | 221ms | 10 | 0.0 | 50% |
| eth_gasPrice | 8 | 8 | 0 | 0 | 119ms | 390ms | 390ms | 10 | 0.0 | 50% |
| eth_maxPriorityFeePerGas | 8 | 8 | 0 | 0 | 89ms | 327ms | 327ms | 10 | 0.1 | 75% |
| eth_feeHistory 4 | 8 | 8 | 0 | 0 | 84ms | 250ms | 250ms | 20 | 0.0 | 50% |
| eth_getBlockByNumber latest hashes | 8 | 8 | 0 | 0 | 66ms | 246ms | 246ms | 20 | 0.1 | 50% |
| eth_getBlockByNumber recent hashes | 8 | 8 | 0 | 0 | 78ms | 187ms | 187ms | 20 | 0.0 | 13% |
| eth_getBlockByHash recent | 8 | 8 | 0 | 0 | 69ms | 180ms | 180ms | 20 | 0.0 | 0% |
| eth_getBlockTransactionCountByNumber | 8 | 8 | 0 | 0 | 68ms | 179ms | 179ms | 15 | 0.0 | 38% |
| eth_getBalance latest | 8 | 8 | 0 | 0 | 268ms | 323ms | 323ms | 15 | 0.0 | 0% |
| eth_getTransactionCount latest | 8 | 8 | 0 | 0 | 308ms | 472ms | 472ms | 15 | 0.0 | 0% |
| eth_getCode latest | 8 | 8 | 0 | 0 | 346ms | 449ms | 449ms | 15 | 0.0 | 38% |
| eth_getStorageAt latest | 8 | 8 | 0 | 0 | 234ms | 451ms | 451ms | 15 | 0.0 | 13% |
| eth_getTransactionByHash recent | 8 | 8 | 0 | 0 | 94ms | 256ms | 256ms | 15 | 0.0 | 0% |
| eth_getTransactionReceipt recent | 8 | 8 | 0 | 0 | 173ms | 407ms | 407ms | 15 | 0.1 | 0% |
| eth_getTransactionByBlockNumberAndIndex | 8 | 8 | 0 | 0 | 164ms | 573ms | 573ms | 15 | 0.0 | 0% |
| eth_getLogs 10 blocks, token | 8 | 8 | 0 | 0 | 96ms | 529ms | 529ms | 50 | 0.1 | 25% |
| eth_call balanceOf | 8 | 8 | 0 | 0 | 327ms | 573ms | 573ms | 30 | 0.8 | 0% |
| eth_estimateGas transfer | 8 | 7 | 1 | 0 | 359ms | 1.04s | 1.04s | 50 | 0.4 | 0% |
| web3_clientVersion | 8 | 8 | 0 | 0 | 149ms | 222ms | 222ms | 5 | 0.0 | - |
| net_version | 8 | 8 | 0 | 0 | 59ms | 215ms | 215ms | 5 | 0.0 | - |

### heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber recent full | 8 | 8 | 0 | 0 | 88ms | 254ms | 254ms | 20 | 0.0 | 0% |
| eth_getBlockReceipts recent | 8 | 8 | 0 | 0 | 84ms | 331ms | 331ms | 30 | 0.0 | 0% |
| eth_getLogs 1000 blocks, no filter | 8 | 0 | 8 | 0 | 276ms | 638ms | 638ms | 50 | 0.3 | - |
| eth_getLogs 10000 blocks, token | 8 | 7 | 1 | 0 | 1.50s | 4.17s | 4.17s | 95 | 8.6 | 14% |
| eth_getLogs 1000 blocks, Transfer topic | 8 | 8 | 0 | 0 | 577ms | 1.21s | 1.21s | 50 | 0.8 | 25% |
| eth_call real calldata latest | 8 | 2 | 6 | 0 | 619ms | 1.63s | 1.63s | 30 | 1.5 | 0% |
| eth_estimateGas real calldata | 8 | 5 | 2 | 1 | 20.72s | 21.00s | 21.00s | 50 | 3.1 | 0% |
| eth_createAccessList | 8 | 8 | 0 | 0 | 898ms | 20.93s | 20.93s | 20 | 2.8 | - |
| debug_traceCall callTracer | 8 | 8 | 0 | 0 | 474ms | 1.30s | 1.30s | 40 | 1.9 | - |
| trace_call | 8 | 8 | 0 | 0 | 770ms | 21.40s | 21.40s | 40 | 3.1 | - |
| debug_traceTransaction recent | 8 | 8 | 0 | 0 | 442ms | 811ms | 811ms | 40 | 1.0 | - |
| trace_transaction recent | 8 | 8 | 0 | 0 | 340ms | 957ms | 957ms | 40 | 1.0 | - |
| trace_replayTransaction recent | 8 | 8 | 0 | 0 | 464ms | 1.04s | 1.04s | 80 | 1.1 | - |
| debug_traceBlockByNumber recent | 8 | 8 | 0 | 0 | 704ms | 1.06s | 1.06s | 40 | 0.0 | - |
| debug_traceBlockByHash recent | 8 | 8 | 0 | 0 | 566ms | 1.20s | 1.20s | 40 | 1.5 | - |
| trace_block recent | 8 | 8 | 0 | 0 | 658ms | 1.20s | 1.20s | 40 | 0.0 | - |
| trace_replayBlockTransactions recent | 8 | 8 | 0 | 0 | 362ms | 1.37s | 1.37s | 80 | 0.0 | - |
| debug_getRawBlock recent | 8 | 8 | 0 | 0 | 96ms | 379ms | 379ms | 20 | 0.0 | 0% |
| debug_getRawReceipts recent | 8 | 8 | 0 | 0 | 72ms | 214ms | 214ms | 30 | 0.0 | 13% |
| batch of 10 mixed | 8 | 7 | 0 | 1 | 360ms | 715ms | 715ms | 170 | 0.3 | 100% |

### deep

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep hashes | 8 | 8 | 0 | 0 | 162ms | 258ms | 258ms | 20 | 0.0 | 13% |
| eth_getBlockByHash deep | 8 | 8 | 0 | 0 | 257ms | 965ms | 965ms | 20 | 1.5 | 38% |
| eth_getBalance deep | 8 | 8 | 0 | 0 | 249ms | 547ms | 547ms | 15 | 1.0 | 0% |
| eth_getTransactionCount deep | 8 | 8 | 0 | 0 | 293ms | 645ms | 645ms | 15 | 0.8 | 0% |
| eth_getCode deep | 8 | 8 | 0 | 0 | 109ms | 480ms | 480ms | 15 | 0.1 | 13% |
| eth_getStorageAt deep | 8 | 8 | 0 | 0 | 122ms | 280ms | 280ms | 15 | 0.0 | 13% |
| eth_getTransactionByHash deep | 8 | 8 | 0 | 0 | 285ms | 796ms | 796ms | 15 | 2.4 | 13% |
| eth_getTransactionReceipt deep | 8 | 8 | 0 | 0 | 417ms | 617ms | 617ms | 15 | 2.5 | 13% |
| eth_getLogs 10 blocks deep | 8 | 8 | 0 | 0 | 294ms | 702ms | 702ms | 50 | 0.6 | 25% |
| eth_feeHistory 4 deep | 8 | 8 | 0 | 0 | 303ms | 607ms | 607ms | 20 | 2.0 | 38% |
| debug_getRawHeader deep | 8 | 8 | 0 | 0 | 70ms | 420ms | 420ms | 15 | 0.0 | 25% |

### deep-heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep full | 8 | 8 | 0 | 0 | 100ms | 267ms | 267ms | 20 | 0.0 | 100% |
| eth_getBlockReceipts deep | 8 | 8 | 0 | 0 | 82ms | 245ms | 245ms | 30 | 0.0 | 50% |
| eth_getLogs 1000 blocks deep | 8 | 2 | 6 | 0 | 157ms | 161ms | 161ms | 50 | 2.3 | 50% |
| eth_getLogs 10000 blocks deep, Transfer | 8 | 0 | 8 | 0 | 92ms | 381ms | 381ms | 95 | 0.0 | - |
| eth_call replay at n-1 | 8 | 5 | 3 | 0 | 536ms | 782ms | 782ms | 30 | 2.4 | 0% |
| eth_estimateGas replay at n-1 | 8 | 7 | 1 | 0 | 867ms | 2.40s | 2.40s | 50 | 5.0 | 0% |
| debug_traceCall replay at n-1 | 8 | 8 | 0 | 0 | 911ms | 1.99s | 1.99s | 40 | 8.0 | - |
| debug_traceTransaction deep | 8 | 8 | 0 | 0 | 636ms | 1.27s | 1.27s | 40 | 3.3 | - |
| trace_transaction deep | 8 | 8 | 0 | 0 | 1.07s | 2.95s | 2.95s | 40 | 5.4 | - |
| trace_replayTransaction deep | 8 | 8 | 0 | 0 | 885ms | 2.13s | 2.13s | 80 | 4.1 | - |
| debug_traceBlockByNumber deep | 8 | 8 | 0 | 0 | 713ms | 2.18s | 2.18s | 40 | 2.3 | - |
| trace_block deep | 8 | 8 | 0 | 0 | 525ms | 1.58s | 1.58s | 40 | 2.9 | - |
| trace_replayBlockTransactions deep | 8 | 8 | 0 | 0 | 816ms | 1.73s | 1.73s | 80 | 5.1 | - |
| debug_getRawBlock deep | 8 | 8 | 0 | 0 | 190ms | 410ms | 410ms | 20 | 0.0 | 25% |
| debug_getRawReceipts deep | 8 | 8 | 0 | 0 | 205ms | 411ms | 411ms | 30 | 0.0 | 25% |

### Failures

- 1× eth_estimateGas real calldata: HTTP 200, code -32005, execution exceeded its time budget (timeout)
- 1× batch of 10 mixed: HTTP 200, code undefined, insufficient funds for gas * price + value: address 0xfAf7d06e0Bb850755F6AAd6b011e45C2D9d8

Parameters of each failed call are in report.json (`samples.calls[].params` where `ok` is false).

## Normal user scenario

25 simulated wallet users for 60s, each looping a 15-step session (connect, balances, fee quote, estimate, confirmation, history) with 150 to 600ms of think time between steps. 175 complete sessions (25 cut by the deadline, not counted), 175 without a failed step (a refused estimateGas, such as insufficient funds, is a refusal, not a failure); a session costs about 298 credits and takes 7.82s at the median.

| step | n | ok | refused | err | p50 | p95 | max | credits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| connect: eth_chainId | 200 | 200 | 0 | 0 | 57ms | 611ms | 673ms | 5 |
| connect: eth_blockNumber | 200 | 200 | 0 | 0 | 62ms | 255ms | 660ms | 10 |
| balance: eth_getBalance | 200 | 200 | 0 | 0 | 195ms | 394ms | 495ms | 15 |
| balance: eth_call balanceOf | 200 | 200 | 0 | 0 | 152ms | 817ms | 1.29s | 30 |
| balance: eth_call balanceOf 2 | 200 | 200 | 0 | 0 | 68ms | 630ms | 1.88s | 30 |
| send: eth_getTransactionCount | 199 | 199 | 0 | 0 | 193ms | 354ms | 529ms | 15 |
| send: eth_gasPrice | 196 | 196 | 0 | 0 | 65ms | 291ms | 799ms | 10 |
| send: eth_maxPriorityFeePerGas | 195 | 195 | 0 | 0 | 63ms | 333ms | 827ms | 10 |
| send: eth_feeHistory | 192 | 192 | 0 | 0 | 64ms | 243ms | 607ms | 20 |
| send: eth_estimateGas | 190 | 171 | 19 | 0 | 271ms | 679ms | 1.23s | 50 |
| confirm: eth_getTransactionReceipt | 182 | 182 | 0 | 0 | 74ms | 208ms | 379ms | 15 |
| confirm: eth_getTransactionByHash | 179 | 179 | 0 | 0 | 73ms | 205ms | 289ms | 15 |
| confirm: eth_getBlockByNumber latest | 177 | 177 | 0 | 0 | 64ms | 209ms | 456ms | 20 |
| history: eth_getLogs transfers to me | 177 | 177 | 0 | 0 | 114ms | 577ms | 783ms | 50 |
| history: eth_getBlockByNumber recent | 175 | 175 | 0 | 0 | 67ms | 173ms | 436ms | 20 |

Free plan: 20M credits is about 67,182 such sessions a month; Builder: 2,015,452.

## Plan economics

Credits per request from the measured user mix (20.8). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.8 | 480,685 | 13.4 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.8 | 961,371 | 13.4 | 0 | 0 | - |
| builder | 19 | 600,000,000 | 250 | 20.8 | 28,841,115 | 32.0 | 0.659 | 0.0317 | - |
| growth | 89 | 3,000,000,000 | 1000 | 20.8 | 144,205,576 | 40.1 | 0.617 | 0.0297 | - |
| scale | 599 | 20,000,000,000 | 3000 | 20.8 | 961,370,507 | 89.0 | 0.623 | 0.0300 | - |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/20261010T022332Z-milestone-560048` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
