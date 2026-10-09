# nullrpc benchmark 20261009T132807Z

Target https://hoodi.nullrpc.dev (keyless), head 3783131, archived through 3782923, generation 168.

## Calls

Each case repeated 4 times, 4 in flight, shuffled. `r2/call` is the Worker's reported R2 misses per call; `resp-cache` the share of answers served from the response cache.

### normal

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_chainId | 4 | 4 | 0 | 0 | 59ms | 142ms | 142ms | 5 | 0.0 | - |
| eth_blockNumber | 4 | 4 | 0 | 0 | 107ms | 115ms | 115ms | 10 | 0.0 | - |
| eth_gasPrice | 4 | 4 | 0 | 0 | 220ms | 603ms | 603ms | 10 | 0.0 | - |
| eth_maxPriorityFeePerGas | 4 | 4 | 0 | 0 | 247ms | 337ms | 337ms | 10 | 0.0 | - |
| eth_feeHistory 4 | 4 | 4 | 0 | 0 | 130ms | 144ms | 144ms | 20 | 0.0 | - |
| eth_getBlockByNumber latest hashes | 4 | 4 | 0 | 0 | 68ms | 223ms | 223ms | 20 | 0.0 | - |
| eth_getBlockByNumber recent hashes | 4 | 4 | 0 | 0 | 69ms | 154ms | 154ms | 20 | 0.0 | - |
| eth_getBlockByHash recent | 4 | 4 | 0 | 0 | 87ms | 475ms | 475ms | 20 | 0.0 | 0% |
| eth_getBlockTransactionCountByNumber | 4 | 4 | 0 | 0 | 74ms | 86ms | 86ms | 15 | 0.0 | - |
| eth_getBalance latest | 4 | 4 | 0 | 0 | 192ms | 274ms | 274ms | 15 | 0.0 | - |
| eth_getTransactionCount latest | 4 | 4 | 0 | 0 | 208ms | 251ms | 251ms | 15 | 0.0 | - |
| eth_getCode latest | 4 | 4 | 0 | 0 | 434ms | 438ms | 438ms | 15 | 0.0 | - |
| eth_getStorageAt latest | 4 | 4 | 0 | 0 | 349ms | 542ms | 542ms | 15 | 0.5 | - |
| eth_getTransactionByHash recent | 4 | 4 | 0 | 0 | 95ms | 367ms | 367ms | 15 | 0.0 | 0% |
| eth_getTransactionReceipt recent | 4 | 4 | 0 | 0 | 157ms | 337ms | 337ms | 15 | 0.0 | 0% |
| eth_getTransactionByBlockNumberAndIndex | 4 | 4 | 0 | 0 | 74ms | 139ms | 139ms | 15 | 0.0 | - |
| eth_getLogs 10 blocks, token | 4 | 4 | 0 | 0 | 175ms | 355ms | 355ms | 50 | 0.0 | - |
| eth_call balanceOf | 4 | 4 | 0 | 0 | 605ms | 2.91s | 2.91s | 30 | 1.8 | - |
| eth_estimateGas transfer | 4 | 4 | 0 | 0 | 253ms | 449ms | 449ms | 50 | 0.0 | - |
| web3_clientVersion | 4 | 4 | 0 | 0 | 59ms | 158ms | 158ms | 5 | 0.0 | - |
| net_version | 4 | 4 | 0 | 0 | 55ms | 311ms | 311ms | 5 | 0.0 | - |

### heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber recent full | 4 | 4 | 0 | 0 | 70ms | 75ms | 75ms | 20 | 0.0 | - |
| eth_getBlockReceipts recent | 4 | 4 | 0 | 0 | 178ms | 551ms | 551ms | 30 | 0.0 | - |
| eth_getLogs 1000 blocks, no filter | 4 | 0 | 4 | 0 | 61ms | 117ms | 117ms | 55 | 0.0 | - |
| eth_getLogs 10000 blocks, token | 4 | 2 | 1 | 1 | 7.00s | 22.16s | 22.16s | 95 | 181.0 | - |
| eth_getLogs 1000 blocks, Transfer topic | 4 | 2 | 0 | 2 | 6.87s | 7.89s | 7.89s | 55 | 0.0 | - |
| eth_call real calldata latest | 4 | 1 | 3 | 0 | 1.42s | 4.39s | 4.39s | 30 | 1.5 | - |
| eth_estimateGas real calldata | 4 | 4 | 0 | 0 | 4.04s | 20.30s | 20.30s | 50 | 12.3 | - |
| eth_createAccessList | 4 | 4 | 0 | 0 | 4.00s | 6.53s | 6.53s | 20 | 6.3 | - |
| debug_traceCall callTracer | 4 | 4 | 0 | 0 | 892ms | 14.88s | 14.88s | 40 | 0.5 | - |
| trace_call | 4 | 4 | 0 | 0 | 4.34s | 6.33s | 6.33s | 40 | 16.0 | - |
| debug_getRawBlock recent | 4 | 4 | 0 | 0 | 101ms | 266ms | 266ms | 20 | 0.0 | - |
| debug_getRawReceipts recent | 4 | 4 | 0 | 0 | 82ms | 150ms | 150ms | 30 | 0.0 | - |
| batch of 10 mixed | 4 | 4 | 0 | 0 | 511ms | 1.15s | 1.15s | 150 | 0.8 | - |

### deep

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep hashes | 4 | 4 | 0 | 0 | 56ms | 117ms | 117ms | 20 | 0.0 | 100% |
| eth_getBlockByHash deep | 4 | 4 | 0 | 0 | 206ms | 735ms | 735ms | 20 | 1.0 | 50% |
| eth_getBalance deep | 4 | 4 | 0 | 0 | 130ms | 1.00s | 1.00s | 15 | 1.3 | 0% |
| eth_getTransactionCount deep | 4 | 4 | 0 | 0 | 535ms | 1.14s | 1.14s | 15 | 1.8 | 25% |
| eth_getCode deep | 4 | 4 | 0 | 0 | 140ms | 351ms | 351ms | 15 | 0.5 | 25% |
| eth_getStorageAt deep | 4 | 4 | 0 | 0 | 134ms | 229ms | 229ms | 15 | 0.0 | 0% |
| eth_getTransactionByHash deep | 4 | 4 | 0 | 0 | 552ms | 766ms | 766ms | 15 | 5.8 | 0% |
| eth_getTransactionReceipt deep | 4 | 4 | 0 | 0 | 400ms | 1.50s | 1.50s | 15 | 2.3 | 0% |
| eth_getLogs 10 blocks deep | 4 | 4 | 0 | 0 | 178ms | 368ms | 368ms | 50 | 2.3 | 75% |
| eth_feeHistory 4 deep | 4 | 4 | 0 | 0 | 136ms | 468ms | 468ms | 20 | 0.8 | - |
| debug_getRawHeader deep | 4 | 4 | 0 | 0 | 63ms | 72ms | 72ms | 15 | 0.0 | 100% |

### deep-heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep full | 4 | 4 | 0 | 0 | 67ms | 176ms | 176ms | 20 | 0.0 | 100% |
| eth_getBlockReceipts deep | 4 | 4 | 0 | 0 | 156ms | 259ms | 259ms | 30 | 0.0 | 75% |
| eth_getLogs 1000 blocks deep | 4 | 1 | 1 | 2 | 4.83s | 11.44s | 11.44s | 50 | 9.8 | 100% |
| eth_getLogs 10000 blocks deep, Transfer | 4 | 0 | 4 | 0 | 177ms | 471ms | 471ms | 95 | 0.8 | - |
| eth_call replay at n-1 | 4 | 4 | 0 | 0 | 3.24s | 5.35s | 5.35s | 30 | 12.0 | - |
| eth_estimateGas replay at n-1 | 4 | 4 | 0 | 0 | 1.60s | 4.41s | 4.41s | 50 | 13.8 | - |
| debug_traceCall replay at n-1 | 4 | 4 | 0 | 0 | 4.14s | 8.81s | 8.81s | 40 | 35.8 | - |
| debug_getRawBlock deep | 4 | 4 | 0 | 0 | 92ms | 143ms | 143ms | 20 | 0.0 | 25% |
| debug_getRawReceipts deep | 4 | 4 | 0 | 0 | 88ms | 286ms | 286ms | 30 | 0.3 | 50% |

### Failures

- 2× eth_getLogs 1000 blocks, Transfer topic: HTTP 503, code 0, non-JSON (503)
- 2× eth_getLogs 1000 blocks deep: HTTP 503, code 0, non-JSON (503)
- 1× eth_getLogs 10000 blocks, token: HTTP 503, code 0, non-JSON (503)

Parameters of each failed call are in report.json (`samples.calls[].params` where `ok` is false).

## Plan economics

Credits per request from the measured user mix (20.0). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.0 | 500,000 | 13.9 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.0 | 1,000,000 | 13.9 | 0 | 0 | - |
| builder | 19 | 600,000,000 | 250 | 20.0 | 30,000,000 | 33.3 | 0.633 | 0.0317 | - |
| growth | 89 | 3,000,000,000 | 1000 | 20.0 | 150,000,000 | 41.7 | 0.593 | 0.0297 | - |
| scale | 599 | 20,000,000,000 | 3000 | 20.0 | 1,000,000,000 | 92.6 | 0.599 | 0.0300 | - |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/logs-before` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
