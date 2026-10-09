# nullrpc benchmark 20261009T160958Z

Target https://hoodi.nullrpc.dev (keyless), head 3783843, archived through 3783716, generation 180.

## Calls

Each case repeated 4 times, 4 in flight, shuffled. `r2/call` is the Worker's reported R2 misses per call; `resp-cache` the share of answers served from the response cache.

### normal

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_chainId | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_blockNumber | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_gasPrice | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_maxPriorityFeePerGas | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_feeHistory 4 | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBlockByNumber latest hashes | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBlockByNumber recent hashes | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBlockByHash recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBlockTransactionCountByNumber | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBalance latest | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getTransactionCount latest | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getCode latest | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getStorageAt latest | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getTransactionByHash recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getTransactionReceipt recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getTransactionByBlockNumberAndIndex | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getLogs 10 blocks, token | 4 | 4 | 0 | 0 | 257ms | 587ms | 587ms | 50 | 0.0 | - |
| eth_call balanceOf | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_estimateGas transfer | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| web3_clientVersion | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| net_version | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |

### heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber recent full | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBlockReceipts recent | 4 | 4 | 0 | 0 | 127ms | 212ms | 212ms | 30 | 0.0 | - |
| eth_getLogs 1000 blocks, no filter | 4 | 0 | 4 | 0 | 412ms | 531ms | 531ms | 55 | 0.0 | - |
| eth_getLogs 10000 blocks, token | 4 | 2 | 2 | 0 | 181ms | 6.14s | 6.14s | 95 | 25.3 | - |
| eth_getLogs 1000 blocks, Transfer topic | 4 | 4 | 0 | 0 | 1.72s | 4.09s | 4.09s | 55 | 7.3 | - |
| eth_call real calldata latest | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_estimateGas real calldata | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_createAccessList | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceCall callTracer | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_call | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceTransaction recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_transaction recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_replayTransaction recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceBlockByNumber recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceBlockByHash recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_block recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_replayBlockTransactions recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_getRawBlock recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_getRawReceipts recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| batch of 10 mixed | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |

### deep

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep hashes | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBlockByHash deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBalance deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getTransactionCount deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getCode deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getStorageAt deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getTransactionByHash deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getTransactionReceipt deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getLogs 10 blocks deep | 4 | 4 | 0 | 0 | 148ms | 553ms | 553ms | 50 | 0.5 | 25% |
| eth_feeHistory 4 deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_getRawHeader deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |

### deep-heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep full | 4 | 4 | 0 | 0 | 378ms | 571ms | 571ms | 20 | 0.0 | 100% |
| eth_getBlockReceipts deep | 4 | 4 | 0 | 0 | 164ms | 882ms | 882ms | 30 | 0.0 | 0% |
| eth_getLogs 1000 blocks deep | 4 | 1 | 3 | 0 | 943ms | 1.56s | 1.56s | 50 | 1.5 | 0% |
| eth_getLogs 10000 blocks deep, Transfer | 4 | 1 | 3 | 0 | 121ms | 3.22s | 3.22s | 95 | 0.0 | 0% |
| eth_call replay at n-1 | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_estimateGas replay at n-1 | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceCall replay at n-1 | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceTransaction deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_transaction deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_replayTransaction deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceBlockByNumber deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_block deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_replayBlockTransactions deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_getRawBlock deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_getRawReceipts deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |

## Plan economics

Credits per request from the measured user mix (20.0). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.0 | 500,000 | 13.9 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.0 | 1,000,000 | 13.9 | 0 | 0 | - |
| builder | 19 | 600,000,000 | 250 | 20.0 | 30,000,000 | 33.3 | 0.633 | 0.0317 | - |
| growth | 89 | 3,000,000,000 | 1000 | 20.0 | 150,000,000 | 41.7 | 0.593 | 0.0297 | - |
| scale | 599 | 20,000,000,000 | 3000 | 20.0 | 1,000,000,000 | 92.6 | 0.599 | 0.0300 | - |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/zstd-after` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
