# nullrpc benchmark 20261009T221127Z

Target https://hoodi.nullrpc.dev (keyless), head 3785466, archived through 3785298, generation 205.

## Calls

Each case repeated 8 times, 4 in flight, shuffled. p50, p95 and max are over successful answers (refusals and failures are counted in their columns, not timed). `r2/call` is the Worker's reported R2 misses per call; `resp-cache` the share of answers served from the response cache.

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
| eth_getBlockByHash recent | 8 | 8 | 0 | 0 | 112ms | 303ms | 303ms | 20 | 0.0 | 13% |
| eth_getBlockTransactionCountByNumber | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBalance latest | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getTransactionCount latest | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getCode latest | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getStorageAt latest | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getTransactionByHash recent | 8 | 8 | 0 | 0 | 108ms | 180ms | 180ms | 15 | 0.0 | 0% |
| eth_getTransactionReceipt recent | 8 | 8 | 0 | 0 | 105ms | 1.01s | 1.01s | 15 | 0.0 | 0% |
| eth_getTransactionByBlockNumberAndIndex | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getLogs 10 blocks, token | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_call balanceOf | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_estimateGas transfer | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| web3_clientVersion | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| net_version | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |

### heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber recent full | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getBlockReceipts recent | 8 | 8 | 0 | 0 | 124ms | 195ms | 195ms | 30 | 0.0 | 0% |
| eth_getLogs 1000 blocks, no filter | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getLogs 10000 blocks, token | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_getLogs 1000 blocks, Transfer topic | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_call real calldata latest | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_estimateGas real calldata | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_createAccessList | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceCall callTracer | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_call | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceTransaction recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_transaction recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_replayTransaction recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceBlockByNumber recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceBlockByHash recent | 8 | 8 | 0 | 0 | 541ms | 1.16s | 1.16s | 40 | 3.9 | - |
| trace_block recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| trace_replayBlockTransactions recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_getRawBlock recent | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_getRawReceipts recent | 8 | 8 | 0 | 0 | 114ms | 219ms | 219ms | 30 | 0.0 | 25% |
| batch of 10 mixed | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |

### deep

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep hashes | 8 | 8 | 0 | 0 | 101ms | 355ms | 355ms | 20 | 0.0 | 38% |
| eth_getBlockByHash deep | 8 | 8 | 0 | 0 | 275ms | 532ms | 532ms | 20 | 2.0 | 25% |
| eth_getBalance deep | 8 | 8 | 0 | 0 | 287ms | 478ms | 478ms | 15 | 0.9 | 0% |
| eth_getTransactionCount deep | 8 | 8 | 0 | 0 | 297ms | 945ms | 945ms | 15 | 1.0 | 0% |
| eth_getCode deep | 8 | 8 | 0 | 0 | 118ms | 795ms | 795ms | 15 | 0.1 | 13% |
| eth_getStorageAt deep | 8 | 8 | 0 | 0 | 124ms | 216ms | 216ms | 15 | 0.1 | 0% |
| eth_getTransactionByHash deep | 8 | 8 | 0 | 0 | 430ms | 525ms | 525ms | 15 | 5.5 | 0% |
| eth_getTransactionReceipt deep | 8 | 8 | 0 | 0 | 400ms | 698ms | 698ms | 15 | 5.5 | 0% |
| eth_getLogs 10 blocks deep | 8 | 8 | 0 | 0 | 205ms | 364ms | 364ms | 50 | 0.4 | 63% |
| eth_feeHistory 4 deep | 8 | 8 | 0 | 0 | 215ms | 573ms | 573ms | 20 | 2.5 | 25% |
| debug_getRawHeader deep | 8 | 8 | 0 | 0 | 103ms | 286ms | 286ms | 15 | 0.0 | 25% |

### deep-heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep full | 8 | 8 | 0 | 0 | 112ms | 116ms | 116ms | 20 | 0.0 | 100% |
| eth_getBlockReceipts deep | 8 | 8 | 0 | 0 | 136ms | 287ms | 287ms | 30 | 0.0 | 13% |
| eth_getLogs 1000 blocks deep | 8 | 0 | 8 | 0 | 440ms | 632ms | 632ms | 50 | 2.4 | - |
| eth_getLogs 10000 blocks deep, Transfer | 8 | 2 | 6 | 0 | 95ms | 154ms | 154ms | 95 | 0.5 | 100% |
| eth_call replay at n-1 | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| eth_estimateGas replay at n-1 | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceCall replay at n-1 | 0 | 0 | 0 | 0 | - | - | - | - | 0.0 | - |
| debug_traceTransaction deep | 8 | 8 | 0 | 0 | 744ms | 1.96s | 1.96s | 40 | 15.5 | - |
| trace_transaction deep | 8 | 8 | 0 | 0 | 520ms | 1.96s | 1.96s | 40 | 7.3 | - |
| trace_replayTransaction deep | 8 | 8 | 0 | 0 | 508ms | 818ms | 818ms | 80 | 5.1 | - |
| debug_traceBlockByNumber deep | 8 | 8 | 0 | 0 | 777ms | 1.85s | 1.85s | 40 | 11.0 | - |
| trace_block deep | 8 | 8 | 0 | 0 | 297ms | 1.58s | 1.58s | 40 | 1.4 | - |
| trace_replayBlockTransactions deep | 8 | 8 | 0 | 0 | 620ms | 1.09s | 1.09s | 80 | 2.6 | - |
| debug_getRawBlock deep | 8 | 8 | 0 | 0 | 137ms | 181ms | 181ms | 20 | 0.0 | 25% |
| debug_getRawReceipts deep | 8 | 8 | 0 | 0 | 109ms | 976ms | 976ms | 30 | 0.0 | 25% |

## Plan economics

Credits per request from the measured user mix (20.0). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.0 | 500,000 | 13.9 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.0 | 1,000,000 | 13.9 | 0 | 0 | - |
| builder | 19 | 600,000,000 | 250 | 20.0 | 30,000,000 | 33.3 | 0.633 | 0.0317 | - |
| growth | 89 | 3,000,000,000 | 1000 | 20.0 | 150,000,000 | 41.7 | 0.593 | 0.0297 | - |
| scale | 599 | 20,000,000,000 | 3000 | 20.0 | 1,000,000,000 | 92.6 | 0.599 | 0.0300 | - |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/20261009T231200Z-hash-locations/before` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
