# nullrpc benchmark 20261010T004102Z

Target https://hoodi.nullrpc.dev (internal key), head 3786127, archived through 3785856, generation 213.

## Calls

Each case repeated 8 times, 4 in flight, shuffled. p50, p95 and max are over successful answers (refusals and failures are counted in their columns, not timed). `r2/call` is the Worker's reported R2 misses per call; `resp-cache` the share of answers served from the response cache.

### normal

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_chainId | 8 | 8 | 0 | 0 | 121ms | 262ms | 262ms | 5 | 0.0 | - |
| eth_blockNumber | 8 | 8 | 0 | 0 | 111ms | 271ms | 271ms | 10 | 0.0 | 63% |
| eth_gasPrice | 8 | 8 | 0 | 0 | 140ms | 847ms | 847ms | 10 | 0.6 | 50% |
| eth_maxPriorityFeePerGas | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_feeHistory 4 | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBlockByNumber latest hashes | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBlockByNumber recent hashes | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBlockByHash recent | 8 | 8 | 0 | 0 | 144ms | 510ms | 510ms | 20 | 0.0 | 13% |
| eth_getBlockTransactionCountByNumber | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBalance latest | 8 | 8 | 0 | 0 | 343ms | 932ms | 932ms | 15 | 0.4 | 0% |
| eth_getTransactionCount latest | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getCode latest | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getStorageAt latest | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getTransactionByHash recent | 8 | 8 | 0 | 0 | 129ms | 436ms | 436ms | 15 | 0.4 | 0% |
| eth_getTransactionReceipt recent | 8 | 8 | 0 | 0 | 124ms | 699ms | 699ms | 15 | 0.1 | 0% |
| eth_getTransactionByBlockNumberAndIndex | 8 | 8 | 0 | 0 | 235ms | 584ms | 584ms | 15 | 0.1 | 13% |
| eth_getLogs 10 blocks, token | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_call balanceOf | 8 | 8 | 0 | 0 | 436ms | 2.05s | 2.05s | 30 | 6.1 | 0% |
| eth_estimateGas transfer | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| web3_clientVersion | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| net_version | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |

### heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber recent full | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBlockReceipts recent | 8 | 8 | 0 | 0 | 127ms | 332ms | 332ms | 30 | 0.0 | 0% |
| eth_getLogs 1000 blocks, no filter | 8 | 0 | 8 | 0 | 300ms | 3.20s | 3.20s | 50 | 1.9 | - |
| eth_getLogs 10000 blocks, token | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getLogs 1000 blocks, Transfer topic | 8 | 8 | 0 | 0 | 635ms | 9.57s | 9.57s | 50 | 17.3 | 63% |
| eth_call real calldata latest | 8 | 5 | 3 | 0 | 327ms | 988ms | 988ms | 30 | 4.1 | 20% |
| eth_estimateGas real calldata | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_createAccessList | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceCall callTracer | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_call | 8 | 8 | 0 | 0 | 856ms | 3.02s | 3.02s | 40 | 9.9 | - |
| debug_traceTransaction recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_transaction recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_replayTransaction recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceBlockByNumber recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceBlockByHash recent | 8 | 8 | 0 | 0 | 693ms | 1.90s | 1.90s | 40 | 4.5 | - |
| trace_block recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_replayBlockTransactions recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_getRawBlock recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_getRawReceipts recent | 8 | 8 | 0 | 0 | 134ms | 655ms | 655ms | 30 | 0.0 | 0% |
| batch of 10 mixed | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |

### deep

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep hashes | 8 | 8 | 0 | 0 | 131ms | 437ms | 437ms | 20 | 0.0 | 38% |
| eth_getBlockByHash deep | 8 | 8 | 0 | 0 | 558ms | 1.17s | 1.17s | 20 | 3.5 | 13% |
| eth_getBalance deep | 8 | 8 | 0 | 0 | 824ms | 1.15s | 1.15s | 15 | 2.5 | 0% |
| eth_getTransactionCount deep | 8 | 8 | 0 | 0 | 864ms | 1.09s | 1.09s | 15 | 2.5 | 0% |
| eth_getCode deep | 8 | 8 | 0 | 0 | 212ms | 1.64s | 1.64s | 15 | 0.9 | 0% |
| eth_getStorageAt deep | 8 | 8 | 0 | 0 | 361ms | 2.17s | 2.17s | 15 | 2.0 | 0% |
| eth_getTransactionByHash deep | 8 | 8 | 0 | 0 | 641ms | 864ms | 864ms | 15 | 5.0 | 0% |
| eth_getTransactionReceipt deep | 8 | 8 | 0 | 0 | 726ms | 1.01s | 1.01s | 15 | 5.5 | 0% |
| eth_getLogs 10 blocks deep | 8 | 8 | 0 | 0 | 423ms | 1.05s | 1.05s | 50 | 0.9 | 25% |
| eth_feeHistory 4 deep | 8 | 8 | 0 | 0 | 284ms | 740ms | 740ms | 20 | 2.5 | 25% |
| debug_getRawHeader deep | 8 | 8 | 0 | 0 | 168ms | 272ms | 272ms | 15 | 0.0 | 13% |

### deep-heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep full | 8 | 8 | 0 | 0 | 134ms | 302ms | 302ms | 20 | 0.0 | 100% |
| eth_getBlockReceipts deep | 8 | 8 | 0 | 0 | 274ms | 370ms | 370ms | 30 | 0.0 | 38% |
| eth_getLogs 1000 blocks deep | 8 | 1 | 7 | 0 | 626ms | 626ms | 626ms | 50 | 6.6 | 0% |
| eth_getLogs 10000 blocks deep, Transfer | 8 | 0 | 8 | 0 | 717ms | 895ms | 895ms | 95 | 1.5 | - |
| eth_call replay at n-1 | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_estimateGas replay at n-1 | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceCall replay at n-1 | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceTransaction deep | 8 | 8 | 0 | 0 | 988ms | 6.52s | 6.52s | 40 | 28.0 | - |
| trace_transaction deep | 8 | 8 | 0 | 0 | 1.02s | 4.27s | 4.27s | 40 | 14.0 | - |
| trace_replayTransaction deep | 8 | 8 | 0 | 0 | 694ms | 9.06s | 9.06s | 80 | 26.8 | - |
| debug_traceBlockByNumber deep | 8 | 8 | 0 | 0 | 406ms | 6.33s | 6.33s | 40 | 16.3 | - |
| trace_block deep | 8 | 8 | 0 | 0 | 508ms | 3.21s | 3.21s | 40 | 8.9 | - |
| trace_replayBlockTransactions deep | 8 | 8 | 0 | 0 | 356ms | 680ms | 680ms | 80 | 0.0 | - |
| debug_getRawBlock deep | 8 | 8 | 0 | 0 | 119ms | 469ms | 469ms | 20 | 0.0 | 25% |
| debug_getRawReceipts deep | 8 | 8 | 0 | 0 | 147ms | 496ms | 496ms | 30 | 0.0 | 50% |

## Plan economics

Credits per request from the measured user mix (20.0). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.0 | 500,000 | 13.9 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.0 | 1,000,000 | 13.9 | 0 | 0 | - |
| builder | 19 | 600,000,000 | 250 | 20.0 | 30,000,000 | 33.3 | 0.633 | 0.0317 | - |
| growth | 89 | 3,000,000,000 | 1000 | 20.0 | 150,000,000 | 41.7 | 0.593 | 0.0297 | - |
| scale | 599 | 20,000,000,000 | 3000 | 20.0 | 1,000,000,000 | 92.6 | 0.599 | 0.0300 | - |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/20261010T001423Z-smart-placement/after` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
