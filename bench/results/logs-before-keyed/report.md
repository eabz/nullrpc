# nullrpc benchmark 20261009T133610Z

Target https://hoodi.nullrpc.dev (internal key), head 3783168, archived through 3782923, generation 168.

## Calls

Each case repeated 4 times, 4 in flight, shuffled. `r2/call` is the Worker's reported R2 misses per call; `resp-cache` the share of answers served from the response cache.

### normal

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_chainId | 4 | 4 | 0 | 0 | 58ms | 66ms | 66ms | 5 | 0.0 | - |
| eth_blockNumber | 4 | 4 | 0 | 0 | 53ms | 65ms | 65ms | 10 | 0.0 | - |
| eth_gasPrice | 4 | 4 | 0 | 0 | 226ms | 301ms | 301ms | 10 | 0.0 | - |
| eth_maxPriorityFeePerGas | 4 | 4 | 0 | 0 | 239ms | 286ms | 286ms | 10 | 0.0 | - |
| eth_feeHistory 4 | 4 | 4 | 0 | 0 | 125ms | 176ms | 176ms | 20 | 0.0 | - |
| eth_getBlockByNumber latest hashes | 4 | 4 | 0 | 0 | 100ms | 136ms | 136ms | 20 | 0.0 | - |
| eth_getBlockByNumber recent hashes | 4 | 4 | 0 | 0 | 74ms | 113ms | 113ms | 20 | 0.0 | - |
| eth_getBlockByHash recent | 4 | 4 | 0 | 0 | 104ms | 189ms | 189ms | 20 | 0.0 | 0% |
| eth_getBlockTransactionCountByNumber | 4 | 4 | 0 | 0 | 74ms | 79ms | 79ms | 15 | 0.0 | - |
| eth_getBalance latest | 4 | 4 | 0 | 0 | 186ms | 219ms | 219ms | 15 | 0.0 | - |
| eth_getTransactionCount latest | 4 | 4 | 0 | 0 | 195ms | 309ms | 309ms | 15 | 0.0 | - |
| eth_getCode latest | 4 | 4 | 0 | 0 | 340ms | 352ms | 352ms | 15 | 0.0 | - |
| eth_getStorageAt latest | 4 | 4 | 0 | 0 | 264ms | 460ms | 460ms | 15 | 0.3 | - |
| eth_getTransactionByHash recent | 4 | 4 | 0 | 0 | 93ms | 188ms | 188ms | 15 | 0.0 | 0% |
| eth_getTransactionReceipt recent | 4 | 4 | 0 | 0 | 88ms | 120ms | 120ms | 15 | 0.0 | 0% |
| eth_getTransactionByBlockNumberAndIndex | 4 | 4 | 0 | 0 | 70ms | 99ms | 99ms | 15 | 0.0 | - |
| eth_getLogs 10 blocks, token | 4 | 4 | 0 | 0 | 156ms | 359ms | 359ms | 50 | 0.0 | - |
| eth_call balanceOf | 4 | 4 | 0 | 0 | 557ms | 708ms | 708ms | 30 | 0.0 | - |
| eth_estimateGas transfer | 4 | 4 | 0 | 0 | 205ms | 434ms | 434ms | 50 | 0.0 | - |
| web3_clientVersion | 4 | 4 | 0 | 0 | 59ms | 67ms | 67ms | 5 | 0.0 | - |
| net_version | 4 | 4 | 0 | 0 | 49ms | 53ms | 53ms | 5 | 0.0 | - |

### heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber recent full | 4 | 4 | 0 | 0 | 76ms | 215ms | 215ms | 20 | 0.0 | - |
| eth_getBlockReceipts recent | 4 | 4 | 0 | 0 | 131ms | 477ms | 477ms | 30 | 0.0 | - |
| eth_getLogs 1000 blocks, no filter | 4 | 0 | 4 | 0 | 53ms | 63ms | 63ms | 55 | 0.0 | - |
| eth_getLogs 10000 blocks, token | 4 | 0 | 4 | 0 | 81ms | 332ms | 332ms | 95 | 0.0 | - |
| eth_getLogs 1000 blocks, Transfer topic | 4 | 2 | 0 | 2 | 7.25s | 8.82s | 8.82s | 55 | 0.0 | - |
| eth_call real calldata latest | 4 | 1 | 2 | 1 | 2.13s | 25.29s | 25.29s | 30 | 11.5 | - |
| eth_estimateGas real calldata | 4 | 1 | 3 | 0 | 1.29s | 5.75s | 5.75s | 50 | 6.8 | - |
| eth_createAccessList | 4 | 4 | 0 | 0 | 1.87s | 4.24s | 4.24s | 20 | 3.0 | - |
| debug_traceCall callTracer | 4 | 4 | 0 | 0 | 1.93s | 3.74s | 3.74s | 40 | 5.8 | - |
| trace_call | 4 | 4 | 0 | 0 | 438ms | 3.98s | 3.98s | 40 | 0.5 | - |
| debug_getRawBlock recent | 4 | 4 | 0 | 0 | 96ms | 194ms | 194ms | 20 | 0.0 | - |
| debug_getRawReceipts recent | 4 | 4 | 0 | 0 | 111ms | 214ms | 214ms | 30 | 0.0 | - |
| batch of 10 mixed | 4 | 3 | 0 | 1 | 366ms | 665ms | 665ms | 150 | 0.0 | - |

### deep

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep hashes | 4 | 4 | 0 | 0 | 57ms | 75ms | 75ms | 20 | 0.0 | 100% |
| eth_getBlockByHash deep | 4 | 4 | 0 | 0 | 59ms | 79ms | 79ms | 20 | 0.0 | 100% |
| eth_getBalance deep | 4 | 4 | 0 | 0 | 451ms | 592ms | 592ms | 15 | 2.0 | 0% |
| eth_getTransactionCount deep | 4 | 4 | 0 | 0 | 501ms | 543ms | 543ms | 15 | 2.3 | 0% |
| eth_getCode deep | 4 | 4 | 0 | 0 | 69ms | 73ms | 73ms | 15 | 0.0 | 75% |
| eth_getStorageAt deep | 4 | 4 | 0 | 0 | 59ms | 94ms | 94ms | 15 | 0.0 | 50% |
| eth_getTransactionByHash deep | 4 | 4 | 0 | 0 | 59ms | 68ms | 68ms | 15 | 0.0 | 100% |
| eth_getTransactionReceipt deep | 4 | 4 | 0 | 0 | 193ms | 418ms | 418ms | 15 | 0.0 | 100% |
| eth_getLogs 10 blocks deep | 4 | 4 | 0 | 0 | 76ms | 86ms | 86ms | 50 | 0.0 | 100% |
| eth_feeHistory 4 deep | 4 | 4 | 0 | 0 | 99ms | 141ms | 141ms | 20 | 0.0 | - |
| debug_getRawHeader deep | 4 | 4 | 0 | 0 | 64ms | 84ms | 84ms | 15 | 0.0 | 100% |

### deep-heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep full | 4 | 4 | 0 | 0 | 62ms | 68ms | 68ms | 20 | 0.0 | 100% |
| eth_getBlockReceipts deep | 4 | 4 | 0 | 0 | 76ms | 105ms | 105ms | 30 | 0.0 | 100% |
| eth_getLogs 1000 blocks deep | 4 | 1 | 1 | 2 | 4.60s | 7.27s | 7.27s | 50 | 0.0 | 100% |
| eth_getLogs 10000 blocks deep, Transfer | 4 | 0 | 4 | 0 | 76ms | 100ms | 100ms | 95 | 0.0 | - |
| eth_call replay at n-1 | 4 | 4 | 0 | 0 | 376ms | 2.65s | 2.65s | 30 | 0.0 | - |
| eth_estimateGas replay at n-1 | 4 | 4 | 0 | 0 | 634ms | 1.97s | 1.97s | 50 | 0.0 | - |
| debug_traceCall replay at n-1 | 4 | 4 | 0 | 0 | 435ms | 2.28s | 2.28s | 40 | 0.0 | - |
| debug_getRawBlock deep | 4 | 4 | 0 | 0 | 60ms | 250ms | 250ms | 20 | 0.0 | 100% |
| debug_getRawReceipts deep | 4 | 4 | 0 | 0 | 64ms | 71ms | 71ms | 30 | 0.0 | 100% |

### Failures

- 2× eth_getLogs 1000 blocks, Transfer topic: HTTP 503, code 0, non-JSON (503)
- 2× eth_getLogs 1000 blocks deep: HTTP 503, code 0, non-JSON (503)
- 1× eth_call real calldata latest: HTTP 200, code -32005, execution exceeded its time budget (timeout)
- 1× batch of 10 mixed: HTTP 200, code undefined, insufficient funds for gas * price + value: address 0x275cC3d451085b3A80E98fcA40A7A9eAE376

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

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/logs-before-keyed` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
