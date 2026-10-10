# nullrpc benchmark 20261010T024432Z

Target https://eth.nullrpc.dev (internal key), head 26159122, archived through 26158987, generation 885.

## Calls

Each case repeated 8 times, 4 in flight, shuffled. p50, p95 and max are over successful answers (refusals and failures are counted in their columns, not timed). `r2/call` is the Worker's reported R2 misses per call; `resp-cache` the share of answers served from the response cache.

### normal

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_chainId | 8 | 8 | 0 | 0 | 77ms | 751ms | 751ms | 5 | 0.1 | - |
| eth_blockNumber | 8 | 8 | 0 | 0 | 58ms | 594ms | 594ms | 10 | 0.1 | 25% |
| eth_gasPrice | 8 | 8 | 0 | 0 | 728ms | 2.10s | 2.10s | 10 | 0.6 | 13% |
| eth_maxPriorityFeePerGas | 8 | 8 | 0 | 0 | 814ms | 1.24s | 1.24s | 10 | 0.5 | 13% |
| eth_feeHistory 4 | 8 | 8 | 0 | 0 | 426ms | 887ms | 887ms | 20 | 0.5 | 25% |
| eth_getBlockByNumber latest hashes | 8 | 8 | 0 | 0 | 291ms | 487ms | 487ms | 20 | 0.4 | 25% |
| eth_getBlockByNumber recent hashes | 8 | 8 | 0 | 0 | 141ms | 518ms | 518ms | 20 | 0.0 | 13% |
| eth_getBlockByHash recent | 8 | 8 | 0 | 0 | 152ms | 335ms | 335ms | 20 | 0.0 | 0% |
| eth_getBlockTransactionCountByNumber | 8 | 8 | 0 | 0 | 90ms | 402ms | 402ms | 15 | 0.0 | 13% |
| eth_getBalance latest | 8 | 8 | 0 | 0 | 304ms | 470ms | 470ms | 15 | 0.0 | 0% |
| eth_getTransactionCount latest | 8 | 8 | 0 | 0 | 313ms | 598ms | 598ms | 15 | 0.0 | 0% |
| eth_getCode latest | 8 | 8 | 0 | 0 | 400ms | 729ms | 729ms | 15 | 0.0 | 0% |
| eth_getStorageAt latest | 8 | 8 | 0 | 0 | 323ms | 632ms | 632ms | 15 | 0.8 | 13% |
| eth_getTransactionByHash recent | 8 | 8 | 0 | 0 | 332ms | 893ms | 893ms | 15 | 0.8 | 0% |
| eth_getTransactionReceipt recent | 8 | 8 | 0 | 0 | 368ms | 597ms | 597ms | 15 | 0.3 | 0% |
| eth_getTransactionByBlockNumberAndIndex | 8 | 8 | 0 | 0 | 196ms | 709ms | 709ms | 15 | 0.0 | 0% |
| eth_getLogs 10 blocks, token | 8 | 8 | 0 | 0 | 650ms | 801ms | 801ms | 50 | 0.8 | 0% |
| eth_call balanceOf | 8 | 8 | 0 | 0 | 3.12s | 5.26s | 5.26s | 30 | 24.5 | 0% |
| eth_estimateGas transfer | 8 | 7 | 0 | 1 | 1.17s | 3.22s | 3.22s | 50 | 0.5 | 0% |
| web3_clientVersion | 8 | 8 | 0 | 0 | 66ms | 716ms | 716ms | 5 | 0.0 | - |
| net_version | 8 | 8 | 0 | 0 | 58ms | 450ms | 450ms | 5 | 0.0 | - |

### heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber recent full | 8 | 8 | 0 | 0 | 147ms | 415ms | 415ms | 20 | 0.0 | 0% |
| eth_getBlockReceipts recent | 8 | 8 | 0 | 0 | 284ms | 907ms | 907ms | 30 | 0.0 | 0% |
| eth_getLogs 1000 blocks, no filter | 8 | 0 | 8 | 0 | 710ms | 1.10s | 1.10s | 50 | 0.9 | - |
| eth_getLogs 10000 blocks, token | 8 | 0 | 8 | 0 | 168ms | 558ms | 558ms | 95 | 0.0 | - |
| eth_getLogs 1000 blocks, Transfer topic | 8 | 0 | 8 | 0 | 891ms | 1.06s | 1.06s | 50 | 0.6 | - |
| eth_call real calldata latest | 8 | 4 | 3 | 1 | 7.13s | 13.76s | 13.76s | 30 | 36.9 | 0% |
| eth_estimateGas real calldata | 8 | 3 | 1 | 4 | 6.04s | 7.24s | 7.24s | 50 | 37.4 | 0% |
| eth_createAccessList | 8 | 7 | 0 | 1 | 2.48s | 4.97s | 4.97s | 20 | 16.4 | - |
| debug_traceCall callTracer | 8 | 5 | 0 | 3 | 7.91s | 13.90s | 13.90s | 40 | 66.4 | - |
| trace_call | 8 | 7 | 1 | 0 | 4.16s | 12.26s | 12.26s | 40 | 33.0 | - |
| debug_traceTransaction recent | 8 | 7 | 0 | 1 | 5.35s | 24.60s | 24.60s | 40 | 164.3 | - |
| trace_transaction recent | 8 | 8 | 0 | 0 | 4.53s | 12.79s | 12.79s | 40 | 8.1 | - |
| trace_replayTransaction recent | 8 | 7 | 0 | 1 | 4.41s | 14.37s | 14.37s | 80 | 146.4 | - |
| debug_traceBlockByNumber recent | 8 | 8 | 0 | 0 | 4.49s | 17.52s | 17.52s | 40 | 91.9 | - |
| debug_traceBlockByHash recent | 8 | 6 | 0 | 2 | 4.79s | 14.81s | 14.81s | 40 | 245.8 | - |
| trace_block recent | 8 | 8 | 0 | 0 | 5.93s | 23.87s | 23.87s | 40 | 59.5 | - |
| trace_replayBlockTransactions recent | 8 | 8 | 0 | 0 | 4.19s | 5.54s | 5.54s | 80 | 8.9 | - |
| debug_getRawBlock recent | 8 | 8 | 0 | 0 | 136ms | 517ms | 517ms | 20 | 0.0 | 0% |
| debug_getRawReceipts recent | 8 | 8 | 0 | 0 | 204ms | 1.10s | 1.10s | 30 | 0.3 | 0% |
| batch of 10 mixed | 8 | 5 | 0 | 3 | 1.32s | 2.33s | 2.33s | 170 | 2.8 | 100% |

### deep

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep hashes | 8 | 8 | 0 | 0 | 231ms | 710ms | 710ms | 20 | 0.0 | 13% |
| eth_getBlockByHash deep | 8 | 8 | 0 | 0 | 880ms | 5.23s | 5.23s | 20 | 18.8 | 38% |
| eth_getBalance deep | 8 | 8 | 0 | 0 | 572ms | 1.09s | 1.09s | 15 | 1.9 | 0% |
| eth_getTransactionCount deep | 8 | 8 | 0 | 0 | 633ms | 1.15s | 1.15s | 15 | 2.0 | 0% |
| eth_getCode deep | 8 | 8 | 0 | 0 | 539ms | 768ms | 768ms | 15 | 0.8 | 13% |
| eth_getStorageAt deep | 8 | 8 | 0 | 0 | 280ms | 2.07s | 2.07s | 15 | 0.5 | 13% |
| eth_getTransactionByHash deep | 8 | 8 | 0 | 0 | 948ms | 1.94s | 1.94s | 15 | 27.8 | 0% |
| eth_getTransactionReceipt deep | 8 | 8 | 0 | 0 | 1.29s | 4.24s | 4.24s | 15 | 38.6 | 0% |
| eth_getLogs 10 blocks deep | 8 | 8 | 0 | 0 | 374ms | 1.04s | 1.04s | 50 | 1.3 | 25% |
| eth_feeHistory 4 deep | 8 | 8 | 0 | 0 | 311ms | 934ms | 934ms | 20 | 2.0 | 38% |
| debug_getRawHeader deep | 8 | 8 | 0 | 0 | 229ms | 727ms | 727ms | 15 | 0.0 | 25% |

### deep-heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep full | 8 | 8 | 0 | 0 | 120ms | 357ms | 357ms | 20 | 0.0 | 100% |
| eth_getBlockReceipts deep | 8 | 8 | 0 | 0 | 175ms | 588ms | 588ms | 30 | 0.0 | 50% |
| eth_getLogs 1000 blocks deep | 8 | 2 | 6 | 0 | 61ms | 354ms | 354ms | 50 | 5.3 | 50% |
| eth_getLogs 10000 blocks deep, Transfer | 8 | 0 | 8 | 0 | 884ms | 1.09s | 1.09s | 95 | 1.8 | - |
| eth_call replay at n-1 | 8 | 8 | 0 | 0 | 933ms | 11.00s | 11.00s | 30 | 5.6 | 0% |
| eth_estimateGas replay at n-1 | 8 | 7 | 0 | 1 | 1.07s | 7.62s | 7.62s | 50 | 25.5 | 0% |
| debug_traceCall replay at n-1 | 8 | 8 | 0 | 0 | 1.91s | 12.14s | 12.14s | 40 | 35.5 | - |
| debug_traceTransaction deep | 8 | 7 | 0 | 1 | 2.29s | 6.56s | 6.56s | 40 | 28.8 | - |
| trace_transaction deep | 8 | 8 | 0 | 0 | 2.82s | 10.86s | 10.86s | 40 | 46.4 | - |
| trace_replayTransaction deep | 8 | 7 | 0 | 1 | 4.52s | 24.53s | 24.53s | 80 | 123.6 | - |
| debug_traceBlockByNumber deep | 8 | 7 | 0 | 1 | 2.60s | 9.89s | 9.89s | 40 | 68.3 | - |
| trace_block deep | 8 | 7 | 0 | 1 | 1.43s | 7.33s | 7.33s | 40 | 26.1 | - |
| trace_replayBlockTransactions deep | 8 | 7 | 0 | 1 | 3.46s | 13.87s | 13.87s | 80 | 184.4 | - |
| debug_getRawBlock deep | 8 | 8 | 0 | 0 | 106ms | 414ms | 414ms | 20 | 0.0 | 25% |
| debug_getRawReceipts deep | 8 | 8 | 0 | 0 | 127ms | 647ms | 647ms | 30 | 0.0 | 25% |

### Failures

- 1× eth_call real calldata latest: HTTP 503, code 0, non-JSON (503)
- 1× eth_estimateGas replay at n-1: HTTP 503, code 0, non-JSON (503)
- 2× debug_traceBlockByHash recent: HTTP 200, code -32005, execution exceeded its time budget (timeout)
- 3× eth_estimateGas real calldata: HTTP 200, code -32000, invalid opcode: INVALID
- 1× debug_traceTransaction recent: HTTP 200, code -32005, execution exceeded its time budget (timeout)
- 1× eth_estimateGas real calldata: HTTP 503, code 0, non-JSON (503)
- 1× trace_replayTransaction recent: HTTP 503, code 0, non-JSON (503)
- 1× eth_estimateGas transfer: HTTP 503, code 0, non-JSON (503)
- 1× trace_replayTransaction deep: HTTP 503, code 0, non-JSON (503)
- 3× debug_traceCall callTracer: HTTP 503, code 0, non-JSON (503)
- 1× eth_createAccessList: HTTP 503, code 0, non-JSON (503)
- 1× debug_traceTransaction deep: HTTP 503, code 0, non-JSON (503)
- 2× batch of 10 mixed: HTTP 0, code undefined, Unexpected token '<', "<!DOCTYPE "... is not valid JSON
- 1× trace_block deep: HTTP 503, code 0, non-JSON (503)
- 1× trace_replayBlockTransactions deep: HTTP 200, code -32005, execution exceeded its time budget (timeout)
- 1× debug_traceBlockByNumber deep: HTTP 503, code 0, non-JSON (503)
- 1× batch of 10 mixed: HTTP 200, code undefined, insufficient funds for gas * price + value: address 0xE9DcbaCc91dB0e37562a8455c80d0734D7CF

Parameters of each failed call are in report.json (`samples.calls[].params` where `ok` is false).

## Normal user scenario

25 simulated wallet users for 60s, each looping a 15-step session (connect, balances, fee quote, estimate, confirmation, history) with 150 to 600ms of think time between steps. 92 complete sessions (21 cut by the deadline, not counted), 81 without a failed step (a refused estimateGas, such as insufficient funds, is a refusal, not a failure); a session costs about 280 credits and takes 14.21s at the median.

| step | n | ok | refused | err | p50 | p95 | max | credits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| connect: eth_chainId | 113 | 113 | 0 | 0 | 130ms | 673ms | 832ms | 5 |
| connect: eth_blockNumber | 111 | 111 | 0 | 0 | 64ms | 453ms | 563ms | 10 |
| balance: eth_getBalance | 111 | 111 | 0 | 0 | 205ms | 557ms | 724ms | 15 |
| balance: eth_call balanceOf | 110 | 108 | 0 | 2 | 2.44s | 7.39s | 25.08s | 30 |
| balance: eth_call balanceOf 2 | 106 | 99 | 0 | 7 | 962ms | 4.68s | 11.89s | 30 |
| send: eth_getTransactionCount | 103 | 103 | 0 | 0 | 205ms | 619ms | 897ms | 15 |
| send: eth_gasPrice | 102 | 102 | 0 | 0 | 63ms | 500ms | 923ms | 10 |
| send: eth_maxPriorityFeePerGas | 102 | 102 | 0 | 0 | 62ms | 564ms | 1.19s | 10 |
| send: eth_feeHistory | 101 | 101 | 0 | 0 | 65ms | 520ms | 966ms | 20 |
| send: eth_estimateGas | 99 | 76 | 20 | 3 | 807ms | 3.68s | 28.96s | 50 |
| confirm: eth_getTransactionReceipt | 95 | 95 | 0 | 0 | 132ms | 580ms | 799ms | 15 |
| confirm: eth_getTransactionByHash | 95 | 95 | 0 | 0 | 126ms | 490ms | 738ms | 15 |
| confirm: eth_getBlockByNumber latest | 95 | 95 | 0 | 0 | 68ms | 426ms | 499ms | 20 |
| history: eth_getLogs transfers to me | 94 | 94 | 0 | 0 | 809ms | 2.34s | 3.67s | 50 |
| history: eth_getBlockByNumber recent | 92 | 92 | 0 | 0 | 90ms | 466ms | 583ms | 20 |

Free plan: 20M credits is about 71,372 such sessions a month; Builder: 2,141,165.

## Plan economics

Credits per request from the measured user mix (20.7). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.7 | 482,868 | 13.4 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.7 | 965,735 | 13.4 | 0 | 0 | - |
| builder | 19 | 600,000,000 | 250 | 20.7 | 28,972,051 | 32.2 | 0.656 | 0.0317 | - |
| growth | 89 | 3,000,000,000 | 1000 | 20.7 | 144,860,256 | 40.2 | 0.614 | 0.0297 | - |
| scale | 599 | 20,000,000,000 | 3000 | 20.7 | 965,735,039 | 89.4 | 0.620 | 0.0300 | - |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/20261010T022332Z-milestone-1` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
