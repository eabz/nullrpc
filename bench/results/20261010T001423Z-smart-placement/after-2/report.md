# nullrpc benchmark 20261010T004256Z

Target https://hoodi.nullrpc.dev (internal key), head 3786135, archived through 3785856, generation 213.

## Calls

Each case repeated 8 times, 4 in flight, shuffled. p50, p95 and max are over successful answers (refusals and failures are counted in their columns, not timed). `r2/call` is the Worker's reported R2 misses per call; `resp-cache` the share of answers served from the response cache.

### normal

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_chainId | 8 | 8 | 0 | 0 | 110ms | 142ms | 142ms | 5 | 0.0 | - |
| eth_blockNumber | 8 | 8 | 0 | 0 | 120ms | 360ms | 360ms | 10 | 0.0 | 50% |
| eth_gasPrice | 8 | 8 | 0 | 0 | 140ms | 1.08s | 1.08s | 10 | 0.4 | 38% |
| eth_maxPriorityFeePerGas | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_feeHistory 4 | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBlockByNumber latest hashes | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBlockByNumber recent hashes | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBlockByHash recent | 8 | 8 | 0 | 0 | 127ms | 327ms | 327ms | 20 | 0.0 | 13% |
| eth_getBlockTransactionCountByNumber | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBalance latest | 8 | 8 | 0 | 0 | 210ms | 524ms | 524ms | 15 | 0.0 | 0% |
| eth_getTransactionCount latest | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getCode latest | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getStorageAt latest | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getTransactionByHash recent | 8 | 8 | 0 | 0 | 255ms | 699ms | 699ms | 15 | 0.3 | 0% |
| eth_getTransactionReceipt recent | 8 | 8 | 0 | 0 | 163ms | 1.05s | 1.05s | 15 | 0.4 | 0% |
| eth_getTransactionByBlockNumberAndIndex | 8 | 8 | 0 | 0 | 129ms | 260ms | 260ms | 15 | 0.0 | 25% |
| eth_getLogs 10 blocks, token | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_call balanceOf | 8 | 8 | 0 | 0 | 355ms | 1.11s | 1.11s | 30 | 1.1 | 0% |
| eth_estimateGas transfer | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| web3_clientVersion | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| net_version | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |

### heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber recent full | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBlockReceipts recent | 8 | 8 | 0 | 0 | 238ms | 507ms | 507ms | 30 | 0.0 | 0% |
| eth_getLogs 1000 blocks, no filter | 8 | 0 | 8 | 0 | 253ms | 590ms | 590ms | 50 | 0.1 | - |
| eth_getLogs 10000 blocks, token | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getLogs 1000 blocks, Transfer topic | 8 | 8 | 0 | 0 | 932ms | 1.62s | 1.62s | 50 | 0.4 | 50% |
| eth_call real calldata latest | 8 | 3 | 4 | 1 | 783ms | 16.65s | 16.65s | 30 | 56.3 | 0% |
| eth_estimateGas real calldata | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_createAccessList | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceCall callTracer | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_call | 8 | 7 | 0 | 1 | 1.21s | 7.34s | 7.34s | 40 | 32.9 | - |
| debug_traceTransaction recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_transaction recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_replayTransaction recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceBlockByNumber recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceBlockByHash recent | 8 | 8 | 0 | 0 | 341ms | 838ms | 838ms | 40 | 1.4 | - |
| trace_block recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_replayBlockTransactions recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_getRawBlock recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_getRawReceipts recent | 8 | 8 | 0 | 0 | 171ms | 431ms | 431ms | 30 | 0.0 | 0% |
| batch of 10 mixed | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |

### deep

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep hashes | 8 | 8 | 0 | 0 | 121ms | 777ms | 777ms | 20 | 0.0 | 100% |
| eth_getBlockByHash deep | 8 | 8 | 0 | 0 | 125ms | 521ms | 521ms | 20 | 0.0 | 100% |
| eth_getBalance deep | 8 | 8 | 0 | 0 | 823ms | 923ms | 923ms | 15 | 2.3 | 0% |
| eth_getTransactionCount deep | 8 | 8 | 0 | 0 | 563ms | 1.38s | 1.38s | 15 | 1.9 | 0% |
| eth_getCode deep | 8 | 8 | 0 | 0 | 150ms | 631ms | 631ms | 15 | 0.3 | 88% |
| eth_getStorageAt deep | 8 | 8 | 0 | 0 | 132ms | 528ms | 528ms | 15 | 0.1 | 38% |
| eth_getTransactionByHash deep | 8 | 8 | 0 | 0 | 146ms | 292ms | 292ms | 15 | 0.0 | 100% |
| eth_getTransactionReceipt deep | 8 | 8 | 0 | 0 | 125ms | 327ms | 327ms | 15 | 0.0 | 100% |
| eth_getLogs 10 blocks deep | 8 | 8 | 0 | 0 | 280ms | 655ms | 655ms | 50 | 0.0 | 100% |
| eth_feeHistory 4 deep | 8 | 8 | 0 | 0 | 123ms | 466ms | 466ms | 20 | 0.0 | 100% |
| debug_getRawHeader deep | 8 | 8 | 0 | 0 | 118ms | 148ms | 148ms | 15 | 0.0 | 100% |

### deep-heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep full | 8 | 8 | 0 | 0 | 132ms | 437ms | 437ms | 20 | 0.0 | 100% |
| eth_getBlockReceipts deep | 8 | 8 | 0 | 0 | 154ms | 195ms | 195ms | 30 | 0.0 | 100% |
| eth_getLogs 1000 blocks deep | 8 | 1 | 7 | 0 | 173ms | 173ms | 173ms | 50 | 0.0 | 100% |
| eth_getLogs 10000 blocks deep, Transfer | 8 | 0 | 8 | 0 | 142ms | 362ms | 362ms | 95 | 0.0 | - |
| eth_call replay at n-1 | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_estimateGas replay at n-1 | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceCall replay at n-1 | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceTransaction deep | 8 | 8 | 0 | 0 | 201ms | 517ms | 517ms | 40 | 0.0 | - |
| trace_transaction deep | 8 | 8 | 0 | 0 | 210ms | 283ms | 283ms | 40 | 0.0 | - |
| trace_replayTransaction deep | 8 | 8 | 0 | 0 | 269ms | 642ms | 642ms | 80 | 0.1 | - |
| debug_traceBlockByNumber deep | 8 | 8 | 0 | 0 | 399ms | 482ms | 482ms | 40 | 0.0 | - |
| trace_block deep | 8 | 8 | 0 | 0 | 423ms | 1.04s | 1.04s | 40 | 0.0 | - |
| trace_replayBlockTransactions deep | 8 | 8 | 0 | 0 | 246ms | 580ms | 580ms | 80 | 0.0 | - |
| debug_getRawBlock deep | 8 | 8 | 0 | 0 | 123ms | 442ms | 442ms | 20 | 0.0 | 100% |
| debug_getRawReceipts deep | 8 | 8 | 0 | 0 | 150ms | 463ms | 463ms | 30 | 0.0 | 100% |

### Failures

- 1× trace_call: HTTP 200, code -32005, execution exceeded its time budget (timeout)
- 1× eth_call real calldata latest: HTTP 200, code -32005, execution exceeded its time budget (timeout)

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

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/20261010T001423Z-smart-placement/after-2` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
