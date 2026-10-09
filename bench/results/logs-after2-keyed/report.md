# nullrpc benchmark 20261009T143127Z

Target https://hoodi.nullrpc.dev (internal key), head 3783404, archived through 3783184, generation 172.

## Calls

Each case repeated 4 times, 4 in flight, shuffled. `r2/call` is the Worker's reported R2 misses per call; `resp-cache` the share of answers served from the response cache.

### normal

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_chainId | 4 | 4 | 0 | 0 | 153ms | 208ms | 208ms | 5 | 0.0 | - |
| eth_blockNumber | 4 | 4 | 0 | 0 | 122ms | 514ms | 514ms | 10 | 0.0 | - |
| eth_gasPrice | 4 | 4 | 0 | 0 | 297ms | 347ms | 347ms | 10 | 0.0 | - |
| eth_maxPriorityFeePerGas | 4 | 4 | 0 | 0 | 245ms | 349ms | 349ms | 10 | 0.0 | - |
| eth_feeHistory 4 | 4 | 4 | 0 | 0 | 137ms | 365ms | 365ms | 20 | 0.0 | - |
| eth_getBlockByNumber latest hashes | 4 | 4 | 0 | 0 | 162ms | 326ms | 326ms | 20 | 0.0 | - |
| eth_getBlockByNumber recent hashes | 4 | 4 | 0 | 0 | 91ms | 515ms | 515ms | 20 | 0.0 | - |
| eth_getBlockByHash recent | 4 | 4 | 0 | 0 | 100ms | 241ms | 241ms | 20 | 0.0 | 0% |
| eth_getBlockTransactionCountByNumber | 4 | 4 | 0 | 0 | 119ms | 239ms | 239ms | 15 | 0.0 | - |
| eth_getBalance latest | 4 | 4 | 0 | 0 | 273ms | 442ms | 442ms | 15 | 0.0 | - |
| eth_getTransactionCount latest | 4 | 4 | 0 | 0 | 204ms | 361ms | 361ms | 15 | 0.0 | - |
| eth_getCode latest | 4 | 4 | 0 | 0 | 405ms | 1.09s | 1.09s | 15 | 0.0 | - |
| eth_getStorageAt latest | 4 | 4 | 0 | 0 | 247ms | 953ms | 953ms | 15 | 0.8 | - |
| eth_getTransactionByHash recent | 4 | 4 | 0 | 0 | 135ms | 288ms | 288ms | 15 | 0.0 | 0% |
| eth_getTransactionReceipt recent | 4 | 4 | 0 | 0 | 187ms | 234ms | 234ms | 15 | 0.0 | 0% |
| eth_getTransactionByBlockNumberAndIndex | 4 | 4 | 0 | 0 | 79ms | 185ms | 185ms | 15 | 0.0 | - |
| eth_getLogs 10 blocks, token | 4 | 4 | 0 | 0 | 224ms | 477ms | 477ms | 50 | 0.0 | - |
| eth_call balanceOf | 4 | 4 | 0 | 0 | 551ms | 1.36s | 1.36s | 30 | 2.8 | - |
| eth_estimateGas transfer | 4 | 4 | 0 | 0 | 358ms | 364ms | 364ms | 50 | 1.0 | - |
| web3_clientVersion | 4 | 4 | 0 | 0 | 202ms | 353ms | 353ms | 5 | 0.0 | - |
| net_version | 4 | 4 | 0 | 0 | 71ms | 119ms | 119ms | 5 | 0.0 | - |

### heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber recent full | 4 | 4 | 0 | 0 | 142ms | 650ms | 650ms | 20 | 0.0 | - |
| eth_getBlockReceipts recent | 4 | 4 | 0 | 0 | 133ms | 381ms | 381ms | 30 | 0.0 | - |
| eth_getLogs 1000 blocks, no filter | 4 | 0 | 4 | 0 | 102ms | 349ms | 349ms | 55 | 0.0 | - |
| eth_getLogs 10000 blocks, token | 4 | 0 | 4 | 0 | 143ms | 308ms | 308ms | 95 | 0.0 | - |
| eth_getLogs 1000 blocks, Transfer topic | 4 | 4 | 0 | 0 | 5.03s | 6.37s | 6.37s | 55 | 0.0 | - |
| eth_call real calldata latest | 4 | 2 | 2 | 0 | 745ms | 1.87s | 1.87s | 30 | 2.3 | - |
| eth_estimateGas real calldata | 4 | 3 | 1 | 0 | 1.79s | 22.60s | 22.60s | 50 | 5.0 | - |
| eth_createAccessList | 4 | 4 | 0 | 0 | 1.80s | 23.32s | 23.32s | 20 | 0.3 | - |
| debug_traceCall callTracer | 4 | 4 | 0 | 0 | 576ms | 8.32s | 8.32s | 40 | 0.3 | - |
| trace_call | 4 | 4 | 0 | 0 | 555ms | 1.97s | 1.97s | 40 | 5.3 | - |
| debug_getRawBlock recent | 4 | 4 | 0 | 0 | 118ms | 258ms | 258ms | 20 | 0.0 | - |
| debug_getRawReceipts recent | 4 | 4 | 0 | 0 | 103ms | 267ms | 267ms | 30 | 0.0 | - |
| batch of 10 mixed | 4 | 4 | 0 | 0 | 511ms | 1.03s | 1.03s | 150 | 0.5 | - |

### deep

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep hashes | 4 | 4 | 0 | 0 | 201ms | 337ms | 337ms | 20 | 0.0 | 100% |
| eth_getBlockByHash deep | 4 | 4 | 0 | 0 | 88ms | 376ms | 376ms | 20 | 0.5 | 75% |
| eth_getBalance deep | 4 | 4 | 0 | 0 | 420ms | 457ms | 457ms | 15 | 1.5 | 0% |
| eth_getTransactionCount deep | 4 | 4 | 0 | 0 | 628ms | 661ms | 661ms | 15 | 2.0 | 0% |
| eth_getCode deep | 4 | 4 | 0 | 0 | 100ms | 352ms | 352ms | 15 | 0.0 | 0% |
| eth_getStorageAt deep | 4 | 4 | 0 | 0 | 167ms | 215ms | 215ms | 15 | 0.0 | 0% |
| eth_getTransactionByHash deep | 4 | 4 | 0 | 0 | 377ms | 677ms | 677ms | 15 | 1.0 | 0% |
| eth_getTransactionReceipt deep | 4 | 4 | 0 | 0 | 508ms | 1.51s | 1.51s | 15 | 2.0 | 0% |
| eth_getLogs 10 blocks deep | 4 | 4 | 0 | 0 | 170ms | 706ms | 706ms | 50 | 0.3 | 75% |
| eth_feeHistory 4 deep | 4 | 4 | 0 | 0 | 274ms | 405ms | 405ms | 20 | 1.5 | - |
| debug_getRawHeader deep | 4 | 4 | 0 | 0 | 92ms | 146ms | 146ms | 15 | 0.0 | 75% |

### deep-heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep full | 4 | 4 | 0 | 0 | 107ms | 305ms | 305ms | 20 | 0.0 | 100% |
| eth_getBlockReceipts deep | 4 | 4 | 0 | 0 | 105ms | 224ms | 224ms | 30 | 0.0 | 50% |
| eth_getLogs 1000 blocks deep | 4 | 1 | 3 | 0 | 2.02s | 2.87s | 2.87s | 50 | 4.5 | 100% |
| eth_getLogs 10000 blocks deep, Transfer | 4 | 0 | 4 | 0 | 103ms | 171ms | 171ms | 95 | 0.0 | - |
| eth_call replay at n-1 | 4 | 3 | 1 | 0 | 391ms | 2.58s | 2.58s | 30 | 3.3 | - |
| eth_estimateGas replay at n-1 | 4 | 3 | 1 | 0 | 628ms | 842ms | 842ms | 50 | 3.8 | - |
| debug_traceCall replay at n-1 | 4 | 4 | 0 | 0 | 534ms | 5.19s | 5.19s | 40 | 74.8 | - |
| debug_getRawBlock deep | 4 | 4 | 0 | 0 | 202ms | 612ms | 612ms | 20 | 0.0 | 100% |
| debug_getRawReceipts deep | 4 | 4 | 0 | 0 | 207ms | 351ms | 351ms | 30 | 0.0 | 75% |

## Plan economics

Credits per request from the measured user mix (20.0). "Requests in quota" is what the included credits buy; "hours at the cap" how long a customer sending at the plan's rps cap needs to spend them. Revenue per 1M requests is the price divided by the requests the quota buys.

| plan | $/mo | included credits | rps cap | credits/req (user mix) | requests in quota | hours at the cap to spend it | $ per 1M requests | $ per 1M credits | measured at cap: p50 / p99 / err |
|---|---|---|---|---|---|---|---|---|---|
| public | 0 | 10,000,000 | 10 | 20.0 | 500,000 | 13.9 | 0 | 0 | - |
| free | 0 | 20,000,000 | 20 | 20.0 | 1,000,000 | 13.9 | 0 | 0 | - |
| builder | 19 | 600,000,000 | 250 | 20.0 | 30,000,000 | 33.3 | 0.633 | 0.0317 | - |
| growth | 89 | 3,000,000,000 | 1000 | 20.0 | 150,000,000 | 41.7 | 0.593 | 0.0297 | - |
| scale | 599 | 20,000,000,000 | 3000 | 20.0 | 1,000,000,000 | 92.6 | 0.599 | 0.0300 | - |

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report bench/results/logs-after2-keyed` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
