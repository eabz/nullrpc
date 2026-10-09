# nullrpc benchmark 20261009T125925Z

Target https://hoodi.nullrpc.dev (internal key), head 3783001, archived through 3782923, generation 168.

## Calls

Each case repeated 8 times, 4 in flight, shuffled. `r2/call` is the Worker's reported R2 misses per call; `resp-cache` the share of answers served from the response cache.

### normal

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_chainId | 8 | 8 | 0 | 0 | 65ms | 248ms | 248ms | 5 | 0.0 | - |
| eth_blockNumber | 8 | 8 | 0 | 0 | 57ms | 158ms | 158ms | 10 | 0.0 | - |
| eth_gasPrice | 8 | 8 | 0 | 0 | 258ms | 627ms | 627ms | 10 | 0.0 | - |
| eth_maxPriorityFeePerGas | 8 | 8 | 0 | 0 | 284ms | 882ms | 882ms | 10 | 0.0 | - |
| eth_feeHistory 4 | 8 | 8 | 0 | 0 | 149ms | 325ms | 325ms | 20 | 0.0 | - |
| eth_getBlockByNumber latest hashes | 8 | 8 | 0 | 0 | 81ms | 391ms | 391ms | 20 | 0.0 | - |
| eth_getBlockByNumber recent hashes | 8 | 8 | 0 | 0 | 75ms | 177ms | 177ms | 20 | 0.0 | - |
| eth_getBlockByHash recent | 8 | 8 | 0 | 0 | 104ms | 304ms | 304ms | 20 | 0.0 | 0% |
| eth_getBlockTransactionCountByNumber | 8 | 8 | 0 | 0 | 90ms | 294ms | 294ms | 15 | 0.0 | - |
| eth_getBalance latest | 8 | 8 | 0 | 0 | 195ms | 224ms | 224ms | 15 | 0.0 | - |
| eth_getTransactionCount latest | 8 | 8 | 0 | 0 | 201ms | 356ms | 356ms | 15 | 0.0 | - |
| eth_getCode latest | 8 | 8 | 0 | 0 | 395ms | 936ms | 936ms | 15 | 0.8 | - |
| eth_getStorageAt latest | 8 | 8 | 0 | 0 | 278ms | 850ms | 850ms | 15 | 0.4 | - |
| eth_getTransactionByHash recent | 8 | 8 | 0 | 0 | 112ms | 248ms | 248ms | 15 | 0.0 | 0% |
| eth_getTransactionReceipt recent | 8 | 8 | 0 | 0 | 171ms | 355ms | 355ms | 15 | 0.0 | 0% |
| eth_getTransactionByBlockNumberAndIndex | 8 | 8 | 0 | 0 | 83ms | 157ms | 157ms | 15 | 0.0 | - |
| eth_getLogs 10 blocks, token | 8 | 8 | 0 | 0 | 196ms | 435ms | 435ms | 50 | 0.0 | - |
| eth_call balanceOf | 8 | 8 | 0 | 0 | 608ms | 919ms | 919ms | 30 | 0.1 | - |
| eth_estimateGas transfer | 8 | 6 | 2 | 0 | 399ms | 1.01s | 1.01s | 50 | 0.4 | - |
| web3_clientVersion | 8 | 8 | 0 | 0 | 54ms | 478ms | 478ms | 5 | 0.0 | - |
| net_version | 8 | 8 | 0 | 0 | 55ms | 554ms | 554ms | 5 | 0.0 | - |

### heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber recent full | 8 | 8 | 0 | 0 | 94ms | 282ms | 282ms | 20 | 0.0 | - |
| eth_getBlockReceipts recent | 8 | 8 | 0 | 0 | 89ms | 204ms | 204ms | 30 | 0.0 | - |
| eth_getLogs 1000 blocks, no filter | 8 | 0 | 8 | 0 | 65ms | 490ms | 490ms | 55 | 0.0 | - |
| eth_getLogs 10000 blocks, token | 8 | 3 | 5 | 0 | 478ms | 17.69s | 17.69s | 95 | 76.9 | - |
| eth_getLogs 1000 blocks, Transfer topic | 8 | 5 | 0 | 3 | 6.67s | 12.10s | 12.10s | 55 | 25.0 | - |
| eth_call real calldata latest | 8 | 4 | 3 | 1 | 681ms | 25.46s | 25.46s | 30 | 7.6 | - |
| eth_estimateGas real calldata | 8 | 4 | 2 | 2 | 4.57s | 25.44s | 25.44s | 50 | 29.9 | - |
| eth_createAccessList | 8 | 8 | 0 | 0 | 1.20s | 4.85s | 4.85s | 20 | 3.3 | - |
| debug_traceCall callTracer | 8 | 7 | 0 | 1 | 1.74s | 25.33s | 25.33s | 40 | 8.5 | - |
| trace_call | 8 | 8 | 0 | 0 | 1.10s | 18.95s | 18.95s | 40 | 27.9 | - |
| debug_getRawBlock recent | 8 | 8 | 0 | 0 | 97ms | 244ms | 244ms | 20 | 0.0 | - |
| debug_getRawReceipts recent | 8 | 8 | 0 | 0 | 110ms | 608ms | 608ms | 30 | 0.0 | - |
| batch of 10 mixed | 8 | 8 | 0 | 0 | 351ms | 773ms | 773ms | 125 | 0.3 | - |

### deep

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep hashes | 8 | 8 | 0 | 0 | 84ms | 549ms | 549ms | 20 | 0.0 | 13% |
| eth_getBlockByHash deep | 8 | 8 | 0 | 0 | 444ms | 914ms | 914ms | 20 | 2.3 | 38% |
| eth_getBalance deep | 8 | 8 | 0 | 0 | 553ms | 894ms | 894ms | 15 | 2.4 | 0% |
| eth_getTransactionCount deep | 8 | 8 | 0 | 0 | 552ms | 711ms | 711ms | 15 | 2.5 | 0% |
| eth_getCode deep | 8 | 8 | 0 | 0 | 200ms | 439ms | 439ms | 15 | 0.6 | 0% |
| eth_getStorageAt deep | 8 | 8 | 0 | 0 | 87ms | 560ms | 560ms | 15 | 0.3 | 0% |
| eth_getTransactionByHash deep | 8 | 8 | 0 | 0 | 496ms | 1.01s | 1.01s | 15 | 7.0 | 13% |
| eth_getTransactionReceipt deep | 8 | 8 | 0 | 0 | 711ms | 865ms | 865ms | 15 | 9.3 | 0% |
| eth_getLogs 10 blocks deep | 8 | 8 | 0 | 0 | 314ms | 1.31s | 1.31s | 50 | 7.6 | 13% |
| eth_feeHistory 4 deep | 8 | 8 | 0 | 0 | 219ms | 365ms | 365ms | 20 | 1.6 | - |
| debug_getRawHeader deep | 8 | 8 | 0 | 0 | 75ms | 166ms | 166ms | 15 | 0.0 | 25% |

### deep-heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep full | 8 | 8 | 0 | 0 | 82ms | 422ms | 422ms | 20 | 0.0 | 100% |
| eth_getBlockReceipts deep | 8 | 8 | 0 | 0 | 98ms | 319ms | 319ms | 30 | 0.0 | 25% |
| eth_getLogs 1000 blocks deep | 8 | 1 | 1 | 6 | 11.78s | 20.58s | 20.58s | 50 | 151.8 | 0% |
| eth_getLogs 10000 blocks deep, Transfer | 8 | 0 | 8 | 0 | 134ms | 969ms | 969ms | 95 | 1.0 | - |
| eth_call replay at n-1 | 8 | 6 | 2 | 0 | 3.16s | 14.01s | 14.01s | 30 | 31.0 | - |
| eth_estimateGas replay at n-1 | 8 | 5 | 3 | 0 | 3.10s | 5.35s | 5.35s | 50 | 16.4 | - |
| debug_traceCall replay at n-1 | 8 | 8 | 0 | 0 | 2.19s | 4.01s | 4.01s | 40 | 11.6 | - |
| debug_getRawBlock deep | 8 | 8 | 0 | 0 | 83ms | 363ms | 363ms | 20 | 0.0 | 38% |
| debug_getRawReceipts deep | 8 | 8 | 0 | 0 | 68ms | 106ms | 106ms | 30 | 0.0 | 38% |

### Failures

- 2× eth_estimateGas real calldata: HTTP 200, code -32005, execution exceeded its time budget (timeout)
- 3× eth_getLogs 1000 blocks, Transfer topic: HTTP 503, code 0, non-JSON (503)
- 1× debug_traceCall callTracer: HTTP 200, code -32005, execution exceeded its time budget (timeout)
- 6× eth_getLogs 1000 blocks deep: HTTP 503, code 0, non-JSON (503)
- 1× eth_call real calldata latest: HTTP 200, code -32005, execution exceeded its time budget (timeout)

Parameters of each failed call are in report.json (`samples.calls[].params` where `ok` is false).

## Normal user scenario

25 simulated wallet users for 60s, each looping a 15-step session (connect, balances, fee quote, estimate, confirmation, history) with 150 to 600ms of think time between steps. 98 sessions completed, 91 without a failed step; a session costs about 284 credits and takes 16.09s at the median.

| step | n | ok | refused | err | p50 | p95 | max | credits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| connect: eth_chainId | 98 | 98 | 0 | 0 | 132ms | 433ms | 498ms | 5 |
| connect: eth_blockNumber | 97 | 97 | 0 | 0 | 57ms | 343ms | 569ms | 10 |
| balance: eth_getBalance | 96 | 96 | 0 | 0 | 204ms | 420ms | 516ms | 15 |
| balance: eth_call balanceOf | 96 | 96 | 0 | 0 | 660ms | 1.58s | 1.74s | 30 |
| balance: eth_call balanceOf 2 | 94 | 94 | 0 | 0 | 672ms | 1.58s | 1.86s | 30 |
| send: eth_getTransactionCount | 92 | 92 | 0 | 0 | 204ms | 455ms | 1.59s | 15 |
| send: eth_gasPrice | 92 | 92 | 0 | 0 | 402ms | 1.33s | 4.57s | 10 |
| send: eth_maxPriorityFeePerGas | 91 | 91 | 0 | 0 | 352ms | 1.47s | 1.90s | 10 |
| send: eth_feeHistory | 89 | 89 | 0 | 0 | 206ms | 749ms | 1.11s | 20 |
| send: eth_estimateGas | 88 | 84 | 4 | 0 | 451ms | 1.16s | 5.10s | 50 |
| confirm: eth_getTransactionReceipt | 87 | 87 | 0 | 0 | 398ms | 1.20s | 1.51s | 15 |
| confirm: eth_getTransactionByHash | 83 | 83 | 0 | 0 | 414ms | 1.29s | 1.54s | 15 |
| confirm: eth_getBlockByNumber latest | 83 | 83 | 0 | 0 | 285ms | 703ms | 1.01s | 20 |
| history: eth_getLogs transfers to me | 82 | 75 | 0 | 7 | 4.01s | 12.90s | 22.21s | 50 |
| history: eth_getBlockByNumber recent | 75 | 75 | 0 | 0 | 388ms | 1.03s | 1.31s | 20 |

Free plan: 20M credits is about 70,504 such sessions a month; Builder: 2,115,108.

## Stress at each plan's rate

The user mix sent open-loop at each plan's requests-per-second cap for 20s with one internal key (no limits), from one client (at most 600 in flight; "dropped" counts sends the client skipped because it was full, a client limit, not the endpoint's).

| plan | target rps | achieved | n | ok | refused | 429 | err | err % | p50 | p95 | p99 | credits/req | r2/call | client dropped |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| free | 20 | 14 | 420 | 419 | 1 | 0 | 0 | 0.00 | 231ms | 2.16s | 6.38s | 20.3 | 0.01 | 0 |
| builder | 250 | 30 | 1395 | 1289 | 11 | 0 | 95 | 6.81 | 11.40s | 26.90s | 40.00s | 20.6 | 0.00 | 3855 |
| growth | 1000 | 47 | 2471 | 1591 | 9 | 0 | 871 | 35.25 | 2.04s | 23.04s | 40.00s | 21.0 | 0.00 | 18528 |

## Plan economics

Credits per request from the measured user mix (20.3). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.3 | 493,537 | 13.7 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.3 | 987,074 | 13.7 | 0 | 0 | 231ms / 6.38s / 0.0% |
| builder | 19 | 600,000,000 | 250 | 20.3 | 29,612,221 | 32.9 | 0.642 | 0.0317 | 11.40s / 40.00s / 6.8% |
| growth | 89 | 3,000,000,000 | 1000 | 20.3 | 148,061,105 | 41.1 | 0.601 | 0.0297 | 2.04s / 40.00s / 35.2% |
| scale | 599 | 20,000,000,000 | 3000 | 20.3 | 987,074,031 | 91.4 | 0.607 | 0.0300 | - |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report /Users/eabz/Documents/GitHub/nullrpc/bench/results/20261009T125925Z` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
