# nullrpc benchmark 20261009T193934Z

Target https://hoodi.nullrpc.dev (internal key), head 3784784, archived through 3784493, generation 192.

## Calls

Each case repeated 8 times, 4 in flight, shuffled. `r2/call` is the Worker's reported R2 misses per call; `resp-cache` the share of answers served from the response cache.

### normal

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_chainId | 8 | 8 | 0 | 0 | 108ms | 585ms | 585ms | 5 | 0.0 | - |
| eth_blockNumber | 8 | 8 | 0 | 0 | 108ms | 130ms | 130ms | 10 | 0.0 | 63% |
| eth_gasPrice | 8 | 8 | 0 | 0 | 140ms | 254ms | 254ms | 10 | 0.1 | 50% |
| eth_maxPriorityFeePerGas | 8 | 8 | 0 | 0 | 93ms | 128ms | 128ms | 10 | 0.0 | 75% |
| eth_feeHistory 4 | 8 | 8 | 0 | 0 | 106ms | 210ms | 210ms | 20 | 0.1 | 50% |
| eth_getBlockByNumber latest hashes | 8 | 8 | 0 | 0 | 99ms | 179ms | 179ms | 20 | 0.0 | 50% |
| eth_getBlockByNumber recent hashes | 8 | 8 | 0 | 0 | 101ms | 181ms | 181ms | 20 | 0.0 | 13% |
| eth_getBlockByHash recent | 8 | 8 | 0 | 0 | 107ms | 199ms | 199ms | 20 | 0.0 | 25% |
| eth_getBlockTransactionCountByNumber | 8 | 8 | 0 | 0 | 94ms | 120ms | 120ms | 15 | 0.0 | 25% |
| eth_getBalance latest | 8 | 8 | 0 | 0 | 246ms | 270ms | 270ms | 15 | 0.0 | 0% |
| eth_getTransactionCount latest | 8 | 8 | 0 | 0 | 258ms | 760ms | 760ms | 15 | 0.0 | 0% |
| eth_getCode latest | 8 | 8 | 0 | 0 | 110ms | 407ms | 407ms | 15 | 0.0 | 38% |
| eth_getStorageAt latest | 8 | 8 | 0 | 0 | 276ms | 458ms | 458ms | 15 | 0.0 | 25% |
| eth_getTransactionByHash recent | 8 | 8 | 0 | 0 | 119ms | 254ms | 254ms | 15 | 0.0 | 0% |
| eth_getTransactionReceipt recent | 8 | 8 | 0 | 0 | 106ms | 202ms | 202ms | 15 | 0.0 | 0% |
| eth_getTransactionByBlockNumberAndIndex | 8 | 8 | 0 | 0 | 98ms | 209ms | 209ms | 15 | 0.0 | 13% |
| eth_getLogs 10 blocks, token | 8 | 8 | 0 | 0 | 144ms | 184ms | 184ms | 50 | 0.0 | 25% |
| eth_call balanceOf | 8 | 8 | 0 | 0 | 426ms | 858ms | 858ms | 30 | 0.8 | 0% |
| eth_estimateGas transfer | 8 | 6 | 2 | 0 | 243ms | 438ms | 438ms | 50 | 0.1 | 0% |
| web3_clientVersion | 8 | 8 | 0 | 0 | 95ms | 269ms | 269ms | 5 | 0.0 | - |
| net_version | 8 | 8 | 0 | 0 | 91ms | 153ms | 153ms | 5 | 0.0 | - |

### heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber recent full | 8 | 8 | 0 | 0 | 112ms | 210ms | 210ms | 20 | 0.0 | 13% |
| eth_getBlockReceipts recent | 8 | 8 | 0 | 0 | 104ms | 482ms | 482ms | 30 | 0.0 | 0% |
| eth_getLogs 1000 blocks, no filter | 8 | 0 | 8 | 0 | 106ms | 194ms | 194ms | 55 | 0.0 | - |
| eth_getLogs 10000 blocks, token | 8 | 1 | 7 | 0 | 134ms | 8.63s | 8.63s | 95 | 17.8 | 0% |
| eth_getLogs 1000 blocks, Transfer topic | 8 | 8 | 0 | 0 | 1.77s | 2.04s | 2.04s | 55 | 0.1 | 25% |
| eth_call real calldata latest | 8 | 2 | 5 | 1 | 569ms | 25.22s | 25.22s | 30 | 0.6 | 0% |
| eth_estimateGas real calldata | 8 | 5 | 2 | 1 | 646ms | 25.10s | 25.10s | 50 | 3.6 | 0% |
| eth_createAccessList | 8 | 7 | 0 | 1 | 718ms | 25.21s | 25.21s | 20 | 2.0 | - |
| debug_traceCall callTracer | 8 | 7 | 0 | 1 | 575ms | 25.23s | 25.23s | 40 | 2.5 | - |
| trace_call | 8 | 8 | 0 | 0 | 508ms | 979ms | 979ms | 40 | 1.5 | - |
| debug_traceTransaction recent | 8 | 8 | 0 | 0 | 359ms | 450ms | 450ms | 40 | 0.4 | - |
| trace_transaction recent | 8 | 8 | 0 | 0 | 131ms | 629ms | 629ms | 40 | 0.8 | - |
| trace_replayTransaction recent | 8 | 8 | 0 | 0 | 373ms | 665ms | 665ms | 80 | 1.9 | - |
| debug_traceBlockByNumber recent | 8 | 8 | 0 | 0 | 496ms | 912ms | 912ms | 40 | 0.4 | - |
| debug_traceBlockByHash recent | 8 | 8 | 0 | 0 | 770ms | 1.03s | 1.03s | 40 | 1.3 | - |
| trace_block recent | 8 | 8 | 0 | 0 | 179ms | 787ms | 787ms | 40 | 0.6 | - |
| trace_replayBlockTransactions recent | 8 | 8 | 0 | 0 | 367ms | 868ms | 868ms | 80 | 0.0 | - |
| debug_getRawBlock recent | 8 | 8 | 0 | 0 | 104ms | 122ms | 122ms | 20 | 0.0 | 25% |
| debug_getRawReceipts recent | 8 | 8 | 0 | 0 | 115ms | 166ms | 166ms | 30 | 0.0 | 13% |
| batch of 10 mixed | 8 | 8 | 0 | 0 | 284ms | 845ms | 845ms | 170 | 0.8 | 100% |

### deep

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep hashes | 8 | 8 | 0 | 0 | 108ms | 134ms | 134ms | 20 | 0.0 | 13% |
| eth_getBlockByHash deep | 8 | 8 | 0 | 0 | 290ms | 936ms | 936ms | 20 | 2.3 | 38% |
| eth_getBalance deep | 8 | 8 | 0 | 0 | 291ms | 621ms | 621ms | 15 | 0.9 | 0% |
| eth_getTransactionCount deep | 8 | 8 | 0 | 0 | 263ms | 383ms | 383ms | 15 | 1.4 | 0% |
| eth_getCode deep | 8 | 8 | 0 | 0 | 119ms | 342ms | 342ms | 15 | 0.1 | 13% |
| eth_getStorageAt deep | 8 | 8 | 0 | 0 | 112ms | 296ms | 296ms | 15 | 0.1 | 13% |
| eth_getTransactionByHash deep | 8 | 8 | 0 | 0 | 380ms | 534ms | 534ms | 15 | 6.5 | 0% |
| eth_getTransactionReceipt deep | 8 | 8 | 0 | 0 | 394ms | 861ms | 861ms | 15 | 6.0 | 0% |
| eth_getLogs 10 blocks deep | 8 | 8 | 0 | 0 | 203ms | 348ms | 348ms | 50 | 0.8 | 25% |
| eth_feeHistory 4 deep | 8 | 8 | 0 | 0 | 179ms | 264ms | 264ms | 20 | 2.3 | 38% |
| debug_getRawHeader deep | 8 | 8 | 0 | 0 | 103ms | 200ms | 200ms | 15 | 0.0 | 25% |

### deep-heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep full | 8 | 8 | 0 | 0 | 109ms | 140ms | 140ms | 20 | 0.0 | 100% |
| eth_getBlockReceipts deep | 8 | 8 | 0 | 0 | 124ms | 140ms | 140ms | 30 | 0.0 | 50% |
| eth_getLogs 1000 blocks deep | 8 | 2 | 6 | 0 | 322ms | 662ms | 662ms | 50 | 3.1 | 50% |
| eth_getLogs 10000 blocks deep, Transfer | 8 | 0 | 8 | 0 | 149ms | 426ms | 426ms | 95 | 0.5 | - |
| eth_call replay at n-1 | 8 | 7 | 1 | 0 | 128ms | 706ms | 706ms | 30 | 0.6 | 0% |
| eth_estimateGas replay at n-1 | 8 | 7 | 1 | 0 | 162ms | 1.02s | 1.02s | 50 | 2.9 | 0% |
| debug_traceCall replay at n-1 | 8 | 8 | 0 | 0 | 240ms | 2.13s | 2.13s | 40 | 9.1 | - |
| debug_traceTransaction deep | 8 | 8 | 0 | 0 | 644ms | 987ms | 987ms | 40 | 3.9 | - |
| trace_transaction deep | 8 | 8 | 0 | 0 | 648ms | 2.07s | 2.07s | 40 | 11.4 | - |
| trace_replayTransaction deep | 8 | 8 | 0 | 0 | 722ms | 965ms | 965ms | 80 | 7.0 | - |
| debug_traceBlockByNumber deep | 8 | 8 | 0 | 0 | 850ms | 1.65s | 1.65s | 40 | 3.8 | - |
| trace_block deep | 8 | 8 | 0 | 0 | 699ms | 1.02s | 1.02s | 40 | 1.9 | - |
| trace_replayBlockTransactions deep | 8 | 8 | 0 | 0 | 751ms | 1.30s | 1.30s | 80 | 6.8 | - |
| debug_getRawBlock deep | 8 | 8 | 0 | 0 | 127ms | 197ms | 197ms | 20 | 0.0 | 25% |
| debug_getRawReceipts deep | 8 | 8 | 0 | 0 | 130ms | 210ms | 210ms | 30 | 0.0 | 25% |

### Failures

- 1× eth_call real calldata latest: HTTP 200, code -32005, execution exceeded its time budget (timeout)
- 1× debug_traceCall callTracer: HTTP 200, code -32005, execution exceeded its time budget (timeout)
- 1× eth_createAccessList: HTTP 200, code -32005, execution exceeded its time budget (timeout)
- 1× eth_estimateGas real calldata: HTTP 200, code -32005, execution exceeded its time budget (timeout)

Parameters of each failed call are in report.json (`samples.calls[].params` where `ok` is false).

## Normal user scenario

25 simulated wallet users for 60s, each looping a 15-step session (connect, balances, fee quote, estimate, confirmation, history) with 150 to 600ms of think time between steps. 193 sessions completed, 193 without a failed step; a session costs about 288 credits and takes 8.18s at the median.

| step | n | ok | refused | err | p50 | p95 | max | credits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| connect: eth_chainId | 193 | 193 | 0 | 0 | 93ms | 663ms | 736ms | 5 |
| connect: eth_blockNumber | 190 | 190 | 0 | 0 | 92ms | 202ms | 654ms | 10 |
| balance: eth_getBalance | 187 | 187 | 0 | 0 | 234ms | 361ms | 727ms | 15 |
| balance: eth_call balanceOf | 182 | 182 | 0 | 0 | 101ms | 665ms | 1.47s | 30 |
| balance: eth_call balanceOf 2 | 181 | 181 | 0 | 0 | 99ms | 659ms | 1.59s | 30 |
| send: eth_getTransactionCount | 178 | 178 | 0 | 0 | 232ms | 315ms | 749ms | 15 |
| send: eth_gasPrice | 176 | 176 | 0 | 0 | 90ms | 156ms | 309ms | 10 |
| send: eth_maxPriorityFeePerGas | 174 | 174 | 0 | 0 | 90ms | 162ms | 291ms | 10 |
| send: eth_feeHistory | 174 | 174 | 0 | 0 | 93ms | 131ms | 251ms | 20 |
| send: eth_estimateGas | 174 | 153 | 21 | 0 | 237ms | 878ms | 1.73s | 50 |
| confirm: eth_getTransactionReceipt | 174 | 174 | 0 | 0 | 103ms | 206ms | 660ms | 15 |
| confirm: eth_getTransactionByHash | 174 | 174 | 0 | 0 | 104ms | 185ms | 580ms | 15 |
| confirm: eth_getBlockByNumber latest | 173 | 173 | 0 | 0 | 97ms | 188ms | 584ms | 20 |
| history: eth_getLogs transfers to me | 172 | 172 | 0 | 0 | 275ms | 1.92s | 2.95s | 50 |
| history: eth_getBlockByNumber recent | 169 | 169 | 0 | 0 | 101ms | 190ms | 377ms | 20 |

Free plan: 20M credits is about 69,462 such sessions a month; Builder: 2,083,858.

## Plan economics

Credits per request from the measured user mix (20.8). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.8 | 480,655 | 13.4 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.8 | 961,310 | 13.4 | 0 | 0 | - |
| builder | 19 | 600,000,000 | 250 | 20.8 | 28,839,302 | 32.0 | 0.659 | 0.0317 | - |
| growth | 89 | 3,000,000,000 | 1000 | 20.8 | 144,196,509 | 40.1 | 0.617 | 0.0297 | - |
| scale | 599 | 20,000,000,000 | 3000 | 20.8 | 961,310,059 | 89.0 | 0.623 | 0.0300 | - |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/20261009T193659Z-milestone` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
