# nullrpc benchmark 20261009T140205Z

Target https://hoodi.nullrpc.dev (internal key), head 3783282, archived through 3783184, generation 172.

## Calls

Each case repeated 8 times, 4 in flight, shuffled. `r2/call` is the Worker's reported R2 misses per call; `resp-cache` the share of answers served from the response cache.

### normal

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_chainId | 8 | 8 | 0 | 0 | 90ms | 281ms | 281ms | 5 | 0.0 | - |
| eth_blockNumber | 8 | 8 | 0 | 0 | 81ms | 97ms | 97ms | 10 | 0.0 | - |
| eth_gasPrice | 8 | 8 | 0 | 0 | 376ms | 606ms | 606ms | 10 | 0.0 | - |
| eth_maxPriorityFeePerGas | 8 | 8 | 0 | 0 | 437ms | 930ms | 930ms | 10 | 0.0 | - |
| eth_feeHistory 4 | 8 | 8 | 0 | 0 | 230ms | 429ms | 429ms | 20 | 0.0 | - |
| eth_getBlockByNumber latest hashes | 8 | 8 | 0 | 0 | 156ms | 431ms | 431ms | 20 | 0.0 | - |
| eth_getBlockByNumber recent hashes | 8 | 8 | 0 | 0 | 149ms | 412ms | 412ms | 20 | 0.0 | - |
| eth_getBlockByHash recent | 8 | 8 | 0 | 0 | 145ms | 412ms | 412ms | 20 | 0.0 | 0% |
| eth_getBlockTransactionCountByNumber | 8 | 8 | 0 | 0 | 126ms | 447ms | 447ms | 15 | 0.0 | - |
| eth_getBalance latest | 8 | 8 | 0 | 0 | 250ms | 388ms | 388ms | 15 | 0.3 | - |
| eth_getTransactionCount latest | 8 | 8 | 0 | 0 | 242ms | 308ms | 308ms | 15 | 0.0 | - |
| eth_getCode latest | 8 | 8 | 0 | 0 | 446ms | 483ms | 483ms | 15 | 0.0 | - |
| eth_getStorageAt latest | 8 | 8 | 0 | 0 | 263ms | 331ms | 331ms | 15 | 0.0 | - |
| eth_getTransactionByHash recent | 8 | 8 | 0 | 0 | 202ms | 748ms | 748ms | 15 | 0.0 | 0% |
| eth_getTransactionReceipt recent | 8 | 8 | 0 | 0 | 188ms | 298ms | 298ms | 15 | 0.0 | 0% |
| eth_getTransactionByBlockNumberAndIndex | 8 | 8 | 0 | 0 | 165ms | 401ms | 401ms | 15 | 0.0 | - |
| eth_getLogs 10 blocks, token | 8 | 8 | 0 | 0 | 410ms | 878ms | 878ms | 50 | 0.0 | - |
| eth_call balanceOf | 8 | 8 | 0 | 0 | 644ms | 1.57s | 1.57s | 30 | 0.1 | - |
| eth_estimateGas transfer | 8 | 8 | 0 | 0 | 303ms | 740ms | 740ms | 50 | 0.0 | - |
| web3_clientVersion | 8 | 8 | 0 | 0 | 91ms | 180ms | 180ms | 5 | 0.0 | - |
| net_version | 8 | 8 | 0 | 0 | 83ms | 145ms | 145ms | 5 | 0.0 | - |

### heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber recent full | 8 | 8 | 0 | 0 | 164ms | 427ms | 427ms | 20 | 0.0 | - |
| eth_getBlockReceipts recent | 8 | 8 | 0 | 0 | 214ms | 511ms | 511ms | 30 | 0.0 | - |
| eth_getLogs 1000 blocks, no filter | 8 | 0 | 8 | 0 | 92ms | 381ms | 381ms | 55 | 0.0 | - |
| eth_getLogs 10000 blocks, token | 8 | 0 | 8 | 0 | 122ms | 12.17s | 12.17s | 95 | 20.6 | - |
| eth_getLogs 1000 blocks, Transfer topic | 8 | 5 | 0 | 3 | 10.42s | 12.50s | 12.50s | 55 | 1.4 | - |
| eth_call real calldata latest | 8 | 5 | 3 | 0 | 2.80s | 24.68s | 24.68s | 30 | 5.0 | - |
| eth_estimateGas real calldata | 8 | 4 | 3 | 1 | 964ms | 25.36s | 25.36s | 50 | 1.6 | - |
| eth_createAccessList | 8 | 7 | 0 | 1 | 1.95s | 25.60s | 25.60s | 20 | 5.0 | - |
| debug_traceCall callTracer | 8 | 7 | 0 | 1 | 1.31s | 25.50s | 25.50s | 40 | 30.6 | - |
| trace_call | 8 | 7 | 0 | 1 | 1.37s | 25.32s | 25.32s | 40 | 1.9 | - |
| debug_getRawBlock recent | 8 | 8 | 0 | 0 | 150ms | 845ms | 845ms | 20 | 0.0 | - |
| debug_getRawReceipts recent | 8 | 8 | 0 | 0 | 150ms | 441ms | 441ms | 30 | 0.0 | - |
| batch of 10 mixed | 8 | 8 | 0 | 0 | 497ms | 1.11s | 1.11s | 125 | 0.3 | - |

### deep

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep hashes | 8 | 8 | 0 | 0 | 127ms | 184ms | 184ms | 20 | 0.0 | 13% |
| eth_getBlockByHash deep | 8 | 8 | 0 | 0 | 311ms | 933ms | 933ms | 20 | 1.5 | 38% |
| eth_getBalance deep | 8 | 8 | 0 | 0 | 494ms | 617ms | 617ms | 15 | 2.4 | 0% |
| eth_getTransactionCount deep | 8 | 8 | 0 | 0 | 426ms | 1.08s | 1.08s | 15 | 2.3 | 0% |
| eth_getCode deep | 8 | 8 | 0 | 0 | 183ms | 598ms | 598ms | 15 | 0.3 | 0% |
| eth_getStorageAt deep | 8 | 8 | 0 | 0 | 110ms | 412ms | 412ms | 15 | 0.0 | 0% |
| eth_getTransactionByHash deep | 8 | 8 | 0 | 0 | 430ms | 658ms | 658ms | 15 | 6.0 | 13% |
| eth_getTransactionReceipt deep | 8 | 8 | 0 | 0 | 455ms | 591ms | 591ms | 15 | 7.8 | 0% |
| eth_getLogs 10 blocks deep | 8 | 8 | 0 | 0 | 260ms | 1.09s | 1.09s | 50 | 0.8 | 25% |
| eth_feeHistory 4 deep | 8 | 8 | 0 | 0 | 150ms | 262ms | 262ms | 20 | 1.9 | - |
| debug_getRawHeader deep | 8 | 8 | 0 | 0 | 117ms | 212ms | 212ms | 15 | 0.0 | 25% |

### deep-heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep full | 8 | 8 | 0 | 0 | 106ms | 590ms | 590ms | 20 | 0.0 | 100% |
| eth_getBlockReceipts deep | 8 | 8 | 0 | 0 | 130ms | 240ms | 240ms | 30 | 0.0 | 38% |
| eth_getLogs 1000 blocks deep | 8 | 1 | 7 | 0 | 1.81s | 2.62s | 2.62s | 50 | 5.1 | 100% |
| eth_getLogs 10000 blocks deep, Transfer | 8 | 0 | 8 | 0 | 123ms | 281ms | 281ms | 95 | 0.5 | - |
| eth_call replay at n-1 | 8 | 6 | 2 | 0 | 1.85s | 10.20s | 10.20s | 30 | 44.9 | - |
| eth_estimateGas replay at n-1 | 8 | 6 | 2 | 0 | 617ms | 3.80s | 3.80s | 50 | 8.3 | - |
| debug_traceCall replay at n-1 | 8 | 8 | 0 | 0 | 2.33s | 24.60s | 24.60s | 40 | 107.6 | - |
| debug_getRawBlock deep | 8 | 8 | 0 | 0 | 119ms | 166ms | 166ms | 20 | 0.0 | 38% |
| debug_getRawReceipts deep | 8 | 8 | 0 | 0 | 124ms | 490ms | 490ms | 30 | 0.0 | 38% |

### Failures

- 1× debug_traceCall callTracer: HTTP 200, code -32005, execution exceeded its time budget (timeout)
- 3× eth_getLogs 1000 blocks, Transfer topic: HTTP 503, code 0, non-JSON (503)
- 1× eth_estimateGas real calldata: HTTP 200, code -32005, execution exceeded its time budget (timeout)
- 1× trace_call: HTTP 200, code -32005, execution exceeded its time budget (timeout)
- 1× eth_createAccessList: HTTP 200, code -32005, execution exceeded its time budget (timeout)

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

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report /private/tmp/claude-501/-Users-eabz-Documents-GitHub-nullrpc--claude-worktrees-inspiring-goldwasser-3a2612/23dddcd9-3a5b-40ed-a403-d155534544b0/scratchpad/before` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
