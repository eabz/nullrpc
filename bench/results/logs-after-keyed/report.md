# nullrpc benchmark 20261009T135123Z

Target https://hoodi.nullrpc.dev (internal key), head 3783234, archived through 3782923, generation 168.

## Calls

Each case repeated 4 times, 4 in flight, shuffled. `r2/call` is the Worker's reported R2 misses per call; `resp-cache` the share of answers served from the response cache.

### normal

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_chainId | 4 | 4 | 0 | 0 | 98ms | 155ms | 155ms | 5 | 0.0 | - |
| eth_blockNumber | 4 | 4 | 0 | 0 | 84ms | 179ms | 179ms | 10 | 0.0 | - |
| eth_gasPrice | 4 | 4 | 0 | 0 | 465ms | 586ms | 586ms | 10 | 0.0 | - |
| eth_maxPriorityFeePerGas | 4 | 4 | 0 | 0 | 489ms | 519ms | 519ms | 10 | 0.0 | - |
| eth_feeHistory 4 | 4 | 4 | 0 | 0 | 164ms | 207ms | 207ms | 20 | 0.0 | - |
| eth_getBlockByNumber latest hashes | 4 | 4 | 0 | 0 | 148ms | 778ms | 778ms | 20 | 0.0 | - |
| eth_getBlockByNumber recent hashes | 4 | 4 | 0 | 0 | 138ms | 217ms | 217ms | 20 | 0.0 | - |
| eth_getBlockByHash recent | 4 | 4 | 0 | 0 | 153ms | 162ms | 162ms | 20 | 0.0 | 0% |
| eth_getBlockTransactionCountByNumber | 4 | 4 | 0 | 0 | 147ms | 233ms | 233ms | 15 | 0.0 | - |
| eth_getBalance latest | 4 | 4 | 0 | 0 | 275ms | 360ms | 360ms | 15 | 0.0 | - |
| eth_getTransactionCount latest | 4 | 4 | 0 | 0 | 244ms | 256ms | 256ms | 15 | 0.0 | - |
| eth_getCode latest | 4 | 4 | 0 | 0 | 438ms | 468ms | 468ms | 15 | 0.0 | - |
| eth_getStorageAt latest | 4 | 4 | 0 | 0 | 329ms | 528ms | 528ms | 15 | 2.3 | - |
| eth_getTransactionByHash recent | 4 | 4 | 0 | 0 | 188ms | 197ms | 197ms | 15 | 0.0 | 0% |
| eth_getTransactionReceipt recent | 4 | 4 | 0 | 0 | 176ms | 330ms | 330ms | 15 | 0.0 | 0% |
| eth_getTransactionByBlockNumberAndIndex | 4 | 4 | 0 | 0 | 143ms | 158ms | 158ms | 15 | 0.0 | - |
| eth_getLogs 10 blocks, token | 4 | 4 | 0 | 0 | 694ms | 836ms | 836ms | 50 | 0.0 | - |
| eth_call balanceOf | 4 | 4 | 0 | 0 | 654ms | 1.45s | 1.45s | 30 | 0.0 | - |
| eth_estimateGas transfer | 4 | 4 | 0 | 0 | 320ms | 450ms | 450ms | 50 | 0.0 | - |
| web3_clientVersion | 4 | 4 | 0 | 0 | 89ms | 100ms | 100ms | 5 | 0.0 | - |
| net_version | 4 | 4 | 0 | 0 | 100ms | 181ms | 181ms | 5 | 0.0 | - |

### heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber recent full | 4 | 4 | 0 | 0 | 151ms | 254ms | 254ms | 20 | 0.0 | - |
| eth_getBlockReceipts recent | 4 | 4 | 0 | 0 | 273ms | 432ms | 432ms | 30 | 0.0 | - |
| eth_getLogs 1000 blocks, no filter | 4 | 0 | 4 | 0 | 92ms | 157ms | 157ms | 55 | 0.0 | - |
| eth_getLogs 10000 blocks, token | 4 | 0 | 4 | 0 | 280ms | 364ms | 364ms | 95 | 1.5 | - |
| eth_getLogs 1000 blocks, Transfer topic | 4 | 0 | 4 | 0 | 121ms | 164ms | 164ms | 55 | 0.0 | - |
| eth_call real calldata latest | 4 | 1 | 3 | 0 | 3.50s | 8.64s | 8.64s | 30 | 6.0 | - |
| eth_estimateGas real calldata | 4 | 3 | 1 | 0 | 1.06s | 7.46s | 7.46s | 50 | 21.5 | - |
| eth_createAccessList | 4 | 4 | 0 | 0 | 4.26s | 7.71s | 7.71s | 20 | 15.8 | - |
| debug_traceCall callTracer | 4 | 4 | 0 | 0 | 836ms | 2.67s | 2.67s | 40 | 1.8 | - |
| trace_call | 4 | 4 | 0 | 0 | 4.03s | 19.80s | 19.80s | 40 | 54.8 | - |
| debug_getRawBlock recent | 4 | 4 | 0 | 0 | 188ms | 206ms | 206ms | 20 | 0.0 | - |
| debug_getRawReceipts recent | 4 | 4 | 0 | 0 | 159ms | 185ms | 185ms | 30 | 0.0 | - |
| batch of 10 mixed | 4 | 4 | 0 | 0 | 510ms | 1.62s | 1.62s | 150 | 0.0 | - |

### deep

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep hashes | 4 | 4 | 0 | 0 | 110ms | 239ms | 239ms | 20 | 0.3 | 25% |
| eth_getBlockByHash deep | 4 | 4 | 0 | 0 | 101ms | 371ms | 371ms | 20 | 5.0 | 50% |
| eth_getBalance deep | 4 | 4 | 0 | 0 | 225ms | 545ms | 545ms | 15 | 1.8 | 0% |
| eth_getTransactionCount deep | 4 | 4 | 0 | 0 | 454ms | 518ms | 518ms | 15 | 2.8 | 0% |
| eth_getCode deep | 4 | 4 | 0 | 0 | 255ms | 469ms | 469ms | 15 | 1.8 | 0% |
| eth_getStorageAt deep | 4 | 4 | 0 | 0 | 139ms | 437ms | 437ms | 15 | 0.8 | 0% |
| eth_getTransactionByHash deep | 4 | 4 | 0 | 0 | 329ms | 453ms | 453ms | 15 | 11.5 | 0% |
| eth_getTransactionReceipt deep | 4 | 4 | 0 | 0 | 806ms | 977ms | 977ms | 15 | 8.0 | 0% |
| eth_getLogs 10 blocks deep | 4 | 4 | 0 | 0 | 246ms | 698ms | 698ms | 50 | 1.0 | 0% |
| eth_feeHistory 4 deep | 4 | 4 | 0 | 0 | 271ms | 342ms | 342ms | 20 | 4.5 | - |
| debug_getRawHeader deep | 4 | 4 | 0 | 0 | 126ms | 185ms | 185ms | 15 | 0.0 | 0% |

### deep-heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep full | 4 | 4 | 0 | 0 | 99ms | 113ms | 113ms | 20 | 0.0 | 100% |
| eth_getBlockReceipts deep | 4 | 4 | 0 | 0 | 167ms | 229ms | 229ms | 30 | 0.3 | 0% |
| eth_getLogs 1000 blocks deep | 4 | 1 | 3 | 0 | 1.54s | 4.72s | 4.72s | 50 | 8.5 | 0% |
| eth_getLogs 10000 blocks deep, Transfer | 4 | 0 | 4 | 0 | 242ms | 468ms | 468ms | 95 | 1.5 | - |
| eth_call replay at n-1 | 4 | 4 | 0 | 0 | 3.83s | 17.27s | 17.27s | 30 | 130.5 | - |
| eth_estimateGas replay at n-1 | 4 | 4 | 0 | 0 | 2.70s | 15.01s | 15.01s | 50 | 78.5 | - |
| debug_traceCall replay at n-1 | 4 | 4 | 0 | 0 | 1.76s | 4.20s | 4.20s | 40 | 38.8 | - |
| debug_getRawBlock deep | 4 | 4 | 0 | 0 | 119ms | 267ms | 267ms | 20 | 0.3 | 0% |
| debug_getRawReceipts deep | 4 | 4 | 0 | 0 | 107ms | 225ms | 225ms | 30 | 0.5 | 25% |

## Plan economics

Credits per request from the measured user mix (20.0). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.0 | 500,000 | 13.9 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.0 | 1,000,000 | 13.9 | 0 | 0 | - |
| builder | 19 | 600,000,000 | 250 | 20.0 | 30,000,000 | 33.3 | 0.633 | 0.0317 | - |
| growth | 89 | 3,000,000,000 | 1000 | 20.0 | 150,000,000 | 41.7 | 0.593 | 0.0297 | - |
| scale | 599 | 20,000,000,000 | 3000 | 20.0 | 1,000,000,000 | 92.6 | 0.599 | 0.0300 | - |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/logs-after-keyed` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
