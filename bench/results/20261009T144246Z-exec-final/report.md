# nullrpc benchmark 20261009T144239Z

Target https://hoodi.nullrpc.dev (internal key), head 3783454, archived through 3783184, generation 172.

## Calls

Each case repeated 8 times, 4 in flight, shuffled. `r2/call` is the Worker's reported R2 misses per call; `resp-cache` the share of answers served from the response cache.

### normal

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_chainId | 8 | 8 | 0 | 0 | 115ms | 333ms | 333ms | 5 | 0.0 | - |
| eth_blockNumber | 8 | 8 | 0 | 0 | 85ms | 240ms | 240ms | 10 | 0.0 | - |
| eth_gasPrice | 8 | 8 | 0 | 0 | 378ms | 499ms | 499ms | 10 | 0.0 | - |
| eth_maxPriorityFeePerGas | 8 | 8 | 0 | 0 | 309ms | 544ms | 544ms | 10 | 0.0 | - |
| eth_feeHistory 4 | 8 | 8 | 0 | 0 | 155ms | 309ms | 309ms | 20 | 0.0 | - |
| eth_getBlockByNumber latest hashes | 8 | 8 | 0 | 0 | 88ms | 200ms | 200ms | 20 | 0.0 | - |
| eth_getBlockByNumber recent hashes | 8 | 8 | 0 | 0 | 171ms | 263ms | 263ms | 20 | 0.0 | - |
| eth_getBlockByHash recent | 8 | 8 | 0 | 0 | 141ms | 798ms | 798ms | 20 | 0.0 | 0% |
| eth_getBlockTransactionCountByNumber | 8 | 8 | 0 | 0 | 158ms | 356ms | 356ms | 15 | 0.0 | - |
| eth_getBalance latest | 8 | 8 | 0 | 0 | 249ms | 540ms | 540ms | 15 | 0.0 | - |
| eth_getTransactionCount latest | 8 | 8 | 0 | 0 | 266ms | 658ms | 658ms | 15 | 0.0 | - |
| eth_getCode latest | 8 | 8 | 0 | 0 | 400ms | 1.05s | 1.05s | 15 | 0.0 | - |
| eth_getStorageAt latest | 8 | 8 | 0 | 0 | 337ms | 498ms | 498ms | 15 | 0.0 | - |
| eth_getTransactionByHash recent | 8 | 8 | 0 | 0 | 177ms | 775ms | 775ms | 15 | 0.0 | 0% |
| eth_getTransactionReceipt recent | 8 | 8 | 0 | 0 | 148ms | 251ms | 251ms | 15 | 0.0 | 0% |
| eth_getTransactionByBlockNumberAndIndex | 8 | 8 | 0 | 0 | 195ms | 926ms | 926ms | 15 | 0.0 | - |
| eth_getLogs 10 blocks, token | 8 | 8 | 0 | 0 | 274ms | 829ms | 829ms | 50 | 0.0 | - |
| eth_call balanceOf | 8 | 8 | 0 | 0 | 536ms | 1.11s | 1.11s | 30 | 0.1 | - |
| eth_estimateGas transfer | 8 | 8 | 0 | 0 | 375ms | 1.07s | 1.07s | 50 | 0.1 | - |
| web3_clientVersion | 8 | 8 | 0 | 0 | 187ms | 375ms | 375ms | 5 | 0.0 | - |
| net_version | 8 | 8 | 0 | 0 | 119ms | 662ms | 662ms | 5 | 0.0 | - |

### heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber recent full | 8 | 8 | 0 | 0 | 117ms | 302ms | 302ms | 20 | 0.0 | - |
| eth_getBlockReceipts recent | 8 | 8 | 0 | 0 | 184ms | 288ms | 288ms | 30 | 0.0 | - |
| eth_getLogs 1000 blocks, no filter | 8 | 0 | 8 | 0 | 78ms | 133ms | 133ms | 55 | 0.0 | - |
| eth_getLogs 10000 blocks, token | 8 | 3 | 5 | 0 | 132ms | 4.87s | 4.87s | 95 | 1.4 | - |
| eth_getLogs 1000 blocks, Transfer topic | 8 | 8 | 0 | 0 | 6.25s | 8.07s | 8.07s | 55 | 0.1 | - |
| eth_call real calldata latest | 8 | 4 | 4 | 0 | 699ms | 22.75s | 22.75s | 30 | 1.9 | - |
| eth_estimateGas real calldata | 8 | 5 | 3 | 0 | 606ms | 23.43s | 23.43s | 50 | 2.3 | - |
| eth_createAccessList | 8 | 8 | 0 | 0 | 455ms | 9.15s | 9.15s | 20 | 26.5 | - |
| debug_traceCall callTracer | 8 | 7 | 0 | 1 | 744ms | 25.57s | 25.57s | 40 | 75.4 | - |
| trace_call | 8 | 8 | 0 | 0 | 397ms | 8.18s | 8.18s | 40 | 1.0 | - |
| debug_traceTransaction recent | 8 | 8 | 0 | 0 | 522ms | 1.55s | 1.55s | 40 | 1.0 | - |
| trace_transaction recent | 8 | 8 | 0 | 0 | 392ms | 1.19s | 1.19s | 40 | 0.5 | - |
| trace_replayTransaction recent | 8 | 8 | 0 | 0 | 446ms | 944ms | 944ms | 80 | 1.0 | - |
| debug_traceBlockByNumber recent | 8 | 8 | 0 | 0 | 570ms | 828ms | 828ms | 40 | 0.0 | - |
| debug_traceBlockByHash recent | 8 | 8 | 0 | 0 | 378ms | 1.36s | 1.36s | 40 | 0.8 | - |
| trace_block recent | 8 | 8 | 0 | 0 | 486ms | 928ms | 928ms | 40 | 0.4 | - |
| trace_replayBlockTransactions recent | 8 | 8 | 0 | 0 | 650ms | 1.43s | 1.43s | 80 | 0.4 | - |
| debug_getRawBlock recent | 8 | 8 | 0 | 0 | 171ms | 361ms | 361ms | 20 | 0.0 | - |
| debug_getRawReceipts recent | 8 | 8 | 0 | 0 | 253ms | 357ms | 357ms | 30 | 0.0 | - |
| batch of 10 mixed | 8 | 8 | 0 | 0 | 724ms | 1.46s | 1.46s | 170 | 0.5 | - |

### deep

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep hashes | 8 | 8 | 0 | 0 | 106ms | 353ms | 353ms | 20 | 0.0 | 100% |
| eth_getBlockByHash deep | 8 | 8 | 0 | 0 | 116ms | 607ms | 607ms | 20 | 0.0 | 100% |
| eth_getBalance deep | 8 | 8 | 0 | 0 | 472ms | 887ms | 887ms | 15 | 1.4 | 0% |
| eth_getTransactionCount deep | 8 | 8 | 0 | 0 | 446ms | 793ms | 793ms | 15 | 1.5 | 0% |
| eth_getCode deep | 8 | 8 | 0 | 0 | 107ms | 1.21s | 1.21s | 15 | 0.1 | 63% |
| eth_getStorageAt deep | 8 | 8 | 0 | 0 | 155ms | 322ms | 322ms | 15 | 0.0 | 75% |
| eth_getTransactionByHash deep | 8 | 8 | 0 | 0 | 89ms | 196ms | 196ms | 15 | 0.0 | 100% |
| eth_getTransactionReceipt deep | 8 | 8 | 0 | 0 | 114ms | 338ms | 338ms | 15 | 0.0 | 100% |
| eth_getLogs 10 blocks deep | 8 | 8 | 0 | 0 | 160ms | 489ms | 489ms | 50 | 0.0 | 100% |
| eth_feeHistory 4 deep | 8 | 8 | 0 | 0 | 105ms | 332ms | 332ms | 20 | 0.0 | - |
| debug_getRawHeader deep | 8 | 8 | 0 | 0 | 91ms | 609ms | 609ms | 15 | 0.0 | 100% |

### deep-heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep full | 8 | 8 | 0 | 0 | 96ms | 186ms | 186ms | 20 | 0.0 | 100% |
| eth_getBlockReceipts deep | 8 | 8 | 0 | 0 | 141ms | 384ms | 384ms | 30 | 0.0 | 100% |
| eth_getLogs 1000 blocks deep | 8 | 2 | 6 | 0 | 2.14s | 2.97s | 2.97s | 50 | 0.0 | 100% |
| eth_getLogs 10000 blocks deep, Transfer | 8 | 0 | 8 | 0 | 169ms | 345ms | 345ms | 95 | 0.0 | - |
| eth_call replay at n-1 | 8 | 5 | 3 | 0 | 488ms | 14.66s | 14.66s | 30 | 8.1 | - |
| eth_estimateGas replay at n-1 | 8 | 7 | 1 | 0 | 286ms | 2.98s | 2.98s | 50 | 17.9 | - |
| debug_traceCall replay at n-1 | 8 | 8 | 0 | 0 | 511ms | 1.22s | 1.22s | 40 | 0.0 | - |
| debug_traceTransaction deep | 8 | 8 | 0 | 0 | 431ms | 819ms | 819ms | 40 | 0.0 | - |
| trace_transaction deep | 8 | 8 | 0 | 0 | 415ms | 1.21s | 1.21s | 40 | 0.0 | - |
| trace_replayTransaction deep | 8 | 8 | 0 | 0 | 361ms | 1.09s | 1.09s | 80 | 0.0 | - |
| debug_traceBlockByNumber deep | 8 | 8 | 0 | 0 | 557ms | 1.09s | 1.09s | 40 | 0.0 | - |
| trace_block deep | 8 | 8 | 0 | 0 | 221ms | 1.39s | 1.39s | 40 | 0.0 | - |
| trace_replayBlockTransactions deep | 8 | 8 | 0 | 0 | 934ms | 1.45s | 1.45s | 80 | 0.0 | - |
| debug_getRawBlock deep | 8 | 8 | 0 | 0 | 113ms | 289ms | 289ms | 20 | 0.0 | 100% |
| debug_getRawReceipts deep | 8 | 8 | 0 | 0 | 144ms | 476ms | 476ms | 30 | 0.0 | 100% |

### Failures

- 1× debug_traceCall callTracer: HTTP 200, code -32005, execution exceeded its time budget (timeout)

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

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report /private/tmp/claude-501/-Users-eabz-Documents-GitHub-nullrpc--claude-worktrees-inspiring-goldwasser-3a2612/23dddcd9-3a5b-40ed-a403-d155534544b0/scratchpad/after3` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
