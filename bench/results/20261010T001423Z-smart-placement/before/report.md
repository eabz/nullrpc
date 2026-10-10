# nullrpc benchmark 20261010T001423Z

Target https://hoodi.nullrpc.dev (internal key), head 3786007, archived through 3785856, generation 213.

## Calls

Each case repeated 8 times, 4 in flight, shuffled. p50, p95 and max are over successful answers (refusals and failures are counted in their columns, not timed). `r2/call` is the Worker's reported R2 misses per call; `resp-cache` the share of answers served from the response cache.

### normal

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_chainId | 8 | 8 | 0 | 0 | 54ms | 85ms | 85ms | 5 | 0.0 | - |
| eth_blockNumber | 8 | 8 | 0 | 0 | 59ms | 90ms | 90ms | 10 | 0.0 | 75% |
| eth_gasPrice | 8 | 8 | 0 | 0 | 54ms | 651ms | 651ms | 10 | 0.6 | 63% |
| eth_maxPriorityFeePerGas | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_feeHistory 4 | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBlockByNumber latest hashes | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBlockByNumber recent hashes | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBlockByHash recent | 8 | 8 | 0 | 0 | 75ms | 223ms | 223ms | 20 | 0.0 | 13% |
| eth_getBlockTransactionCountByNumber | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBalance latest | 8 | 8 | 0 | 0 | 185ms | 398ms | 398ms | 15 | 0.0 | 0% |
| eth_getTransactionCount latest | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getCode latest | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getStorageAt latest | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getTransactionByHash recent | 8 | 8 | 0 | 0 | 65ms | 633ms | 633ms | 15 | 0.1 | 0% |
| eth_getTransactionReceipt recent | 8 | 8 | 0 | 0 | 63ms | 483ms | 483ms | 15 | 0.1 | 0% |
| eth_getTransactionByBlockNumberAndIndex | 8 | 8 | 0 | 0 | 61ms | 256ms | 256ms | 15 | 0.0 | 25% |
| eth_getLogs 10 blocks, token | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_call balanceOf | 8 | 8 | 0 | 0 | 335ms | 1.49s | 1.49s | 30 | 1.5 | 13% |
| eth_estimateGas transfer | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| web3_clientVersion | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| net_version | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |

### heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber recent full | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBlockReceipts recent | 8 | 8 | 0 | 0 | 74ms | 268ms | 268ms | 30 | 0.0 | 25% |
| eth_getLogs 1000 blocks, no filter | 8 | 0 | 8 | 0 | 185ms | 2.13s | 2.13s | 50 | 1.3 | - |
| eth_getLogs 10000 blocks, token | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getLogs 1000 blocks, Transfer topic | 8 | 8 | 0 | 0 | 266ms | 4.21s | 4.21s | 50 | 5.8 | 63% |
| eth_call real calldata latest | 8 | 4 | 4 | 0 | 190ms | 426ms | 426ms | 30 | 1.6 | 25% |
| eth_estimateGas real calldata | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_createAccessList | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceCall callTracer | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_call | 8 | 8 | 0 | 0 | 402ms | 4.05s | 4.05s | 40 | 4.9 | - |
| debug_traceTransaction recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_transaction recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_replayTransaction recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceBlockByNumber recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceBlockByHash recent | 8 | 8 | 0 | 0 | 740ms | 1.15s | 1.15s | 40 | 2.3 | - |
| trace_block recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_replayBlockTransactions recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_getRawBlock recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_getRawReceipts recent | 8 | 8 | 0 | 0 | 68ms | 402ms | 402ms | 30 | 0.0 | 13% |
| batch of 10 mixed | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |

### deep

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep hashes | 8 | 8 | 0 | 0 | 75ms | 221ms | 221ms | 20 | 0.0 | 25% |
| eth_getBlockByHash deep | 8 | 8 | 0 | 0 | 391ms | 759ms | 759ms | 20 | 2.8 | 13% |
| eth_getBalance deep | 8 | 8 | 0 | 0 | 228ms | 660ms | 660ms | 15 | 0.5 | 0% |
| eth_getTransactionCount deep | 8 | 8 | 0 | 0 | 243ms | 921ms | 921ms | 15 | 0.8 | 0% |
| eth_getCode deep | 8 | 8 | 0 | 0 | 217ms | 558ms | 558ms | 15 | 0.0 | 0% |
| eth_getStorageAt deep | 8 | 8 | 0 | 0 | 69ms | 929ms | 929ms | 15 | 0.1 | 0% |
| eth_getTransactionByHash deep | 8 | 8 | 0 | 0 | 603ms | 801ms | 801ms | 15 | 3.5 | 0% |
| eth_getTransactionReceipt deep | 8 | 8 | 0 | 0 | 464ms | 908ms | 908ms | 15 | 3.6 | 0% |
| eth_getLogs 10 blocks deep | 8 | 8 | 0 | 0 | 220ms | 552ms | 552ms | 50 | 0.9 | 25% |
| eth_feeHistory 4 deep | 8 | 8 | 0 | 0 | 261ms | 392ms | 392ms | 20 | 2.1 | 25% |
| debug_getRawHeader deep | 8 | 8 | 0 | 0 | 69ms | 99ms | 99ms | 15 | 0.0 | 13% |

### deep-heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep full | 8 | 8 | 0 | 0 | 65ms | 75ms | 75ms | 20 | 0.0 | 100% |
| eth_getBlockReceipts deep | 8 | 8 | 0 | 0 | 84ms | 342ms | 342ms | 30 | 0.0 | 38% |
| eth_getLogs 1000 blocks deep | 8 | 1 | 7 | 0 | 117ms | 117ms | 117ms | 50 | 3.8 | 0% |
| eth_getLogs 10000 blocks deep, Transfer | 8 | 0 | 8 | 0 | 82ms | 526ms | 526ms | 95 | 0.3 | - |
| eth_call replay at n-1 | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_estimateGas replay at n-1 | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceCall replay at n-1 | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceTransaction deep | 8 | 8 | 0 | 0 | 896ms | 3.07s | 3.07s | 40 | 8.6 | - |
| trace_transaction deep | 8 | 8 | 0 | 0 | 693ms | 2.27s | 2.27s | 40 | 6.4 | - |
| trace_replayTransaction deep | 8 | 8 | 0 | 0 | 792ms | 4.28s | 4.28s | 80 | 6.4 | - |
| debug_traceBlockByNumber deep | 8 | 8 | 0 | 0 | 141ms | 2.43s | 2.43s | 40 | 2.0 | - |
| trace_block deep | 8 | 8 | 0 | 0 | 518ms | 2.07s | 2.07s | 40 | 4.0 | - |
| trace_replayBlockTransactions deep | 8 | 8 | 0 | 0 | 156ms | 405ms | 405ms | 80 | 0.0 | - |
| debug_getRawBlock deep | 8 | 8 | 0 | 0 | 76ms | 306ms | 306ms | 20 | 0.0 | 25% |
| debug_getRawReceipts deep | 8 | 8 | 0 | 0 | 73ms | 114ms | 114ms | 30 | 0.0 | 50% |

## Plan economics

Credits per request from the measured user mix (20.0). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.0 | 500,000 | 13.9 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.0 | 1,000,000 | 13.9 | 0 | 0 | - |
| builder | 19 | 600,000,000 | 250 | 20.0 | 30,000,000 | 33.3 | 0.633 | 0.0317 | - |
| growth | 89 | 3,000,000,000 | 1000 | 20.0 | 150,000,000 | 41.7 | 0.593 | 0.0297 | - |
| scale | 599 | 20,000,000,000 | 3000 | 20.0 | 1,000,000,000 | 92.6 | 0.599 | 0.0300 | - |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/20261010T001423Z-smart-placement/before` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
