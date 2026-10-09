# nullrpc benchmark 20261009T182033Z

Target https://hoodi.nullrpc.dev (internal key), head 3784431, archived through 3784234, generation 188.

## Calls

Each case repeated 8 times, 4 in flight, shuffled. `r2/call` is the Worker's reported R2 misses per call; `resp-cache` the share of answers served from the response cache.

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
| eth_getLogs 10 blocks, token | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_call balanceOf | 8 | 8 | 0 | 0 | 425ms | 701ms | 701ms | 30 | 1.8 | - |
| eth_estimateGas transfer | 8 | 8 | 0 | 0 | 252ms | 8.29s | 8.29s | 50 | 2.6 | - |
| web3_clientVersion | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| net_version | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |

### heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber recent full | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBlockReceipts recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getLogs 1000 blocks, no filter | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getLogs 10000 blocks, token | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getLogs 1000 blocks, Transfer topic | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_call real calldata latest | 8 | 3 | 4 | 1 | 729ms | 25.80s | 25.80s | 30 | 15.9 | - |
| eth_estimateGas real calldata | 8 | 6 | 2 | 0 | 1.99s | 25.90s | 25.90s | 50 | 19.6 | - |
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
| eth_getLogs 10 blocks deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_feeHistory 4 deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_getRawHeader deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |

### deep-heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep full | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBlockReceipts deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getLogs 1000 blocks deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getLogs 10000 blocks deep, Transfer | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_call replay at n-1 | 8 | 6 | 2 | 0 | 1.16s | 1.99s | 1.99s | 30 | 13.4 | - |
| eth_estimateGas replay at n-1 | 8 | 6 | 2 | 0 | 722ms | 4.16s | 4.16s | 50 | 36.8 | - |
| debug_traceCall replay at n-1 | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceTransaction deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_transaction deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_replayTransaction deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceBlockByNumber deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_block deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_replayBlockTransactions deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_getRawBlock deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_getRawReceipts deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |

### Failures

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

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report /private/tmp/claude-501/-Users-eabz-Documents-GitHub-nullrpc/23dddcd9-3a5b-40ed-a403-d155534544b0/scratchpad/before` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
