# nullrpc benchmark 20261010T031824Z

Target https://eth.nullrpc.dev (keyless), head 26159291, archived through 26158987, generation 966.

## Calls

Each case repeated 8 times, 4 in flight, shuffled. p50, p95 and max are over successful answers (refusals and failures are counted in their columns, not timed). `r2/call` is the Worker's reported R2 misses per call; `resp-cache` the share of answers served from the response cache.

### normal

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_chainId | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_blockNumber | 8 | 8 | 0 | 0 | 62ms | 687ms | 687ms | 10 | 0.0 | 75% |
| eth_gasPrice | 8 | 8 | 0 | 0 | 75ms | 713ms | 713ms | 10 | 0.3 | 75% |
| eth_maxPriorityFeePerGas | 8 | 8 | 0 | 0 | 76ms | 822ms | 822ms | 10 | 0.1 | 75% |
| eth_feeHistory 4 | 8 | 8 | 0 | 0 | 73ms | 494ms | 494ms | 20 | 0.1 | 75% |
| eth_getBlockByNumber latest hashes | 8 | 8 | 0 | 0 | 69ms | 462ms | 462ms | 20 | 0.0 | 88% |
| eth_getBlockByNumber recent hashes | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBlockByHash recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBlockTransactionCountByNumber | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBalance latest | 8 | 8 | 0 | 0 | 209ms | 650ms | 650ms | 15 | 0.0 | 0% |
| eth_getTransactionCount latest | 8 | 8 | 0 | 0 | 202ms | 944ms | 944ms | 15 | 0.0 | 0% |
| eth_getCode latest | 8 | 8 | 0 | 0 | 328ms | 653ms | 653ms | 15 | 0.3 | 38% |
| eth_getStorageAt latest | 8 | 8 | 0 | 0 | 275ms | 1.04s | 1.04s | 15 | 0.3 | 25% |
| eth_getTransactionByHash recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getTransactionReceipt recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getTransactionByBlockNumberAndIndex | 8 | 8 | 0 | 0 | 81ms | 229ms | 229ms | 15 | 0.0 | 50% |
| eth_getLogs 10 blocks, token | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_call balanceOf | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_estimateGas transfer | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
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
| eth_call real calldata latest | 8 | 5 | 2 | 1 | 7.39s | 13.56s | 13.56s | 30 | 52.5 | 0% |
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
| eth_getLogs 10 blocks deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_feeHistory 4 deep | 8 | 8 | 0 | 0 | 66ms | 559ms | 559ms | 20 | 0.1 | 100% |
| debug_getRawHeader deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |

### deep-heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep full | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBlockReceipts deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getLogs 1000 blocks deep | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getLogs 10000 blocks deep, Transfer | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
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

### Failures

- 1× eth_call real calldata latest: HTTP 503, code 0, non-JSON (503)

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

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/fee-inputs-after` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
