# nullrpc benchmark 20261009T142357Z

Target https://hoodi.nullrpc.dev (internal key), head 3783370, archived through 3783184, generation 172.

## Calls

Each case repeated 8 times, 4 in flight, shuffled. `r2/call` is the Worker's reported R2 misses per call; `resp-cache` the share of answers served from the response cache.

### normal

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_chainId | 8 | 8 | 0 | 0 | 139ms | 287ms | 287ms | 5 | 0.0 | - |
| eth_blockNumber | 8 | 8 | 0 | 0 | 110ms | 184ms | 184ms | 10 | 0.0 | - |
| eth_gasPrice | 8 | 8 | 0 | 0 | 352ms | 502ms | 502ms | 10 | 0.0 | - |
| eth_maxPriorityFeePerGas | 8 | 8 | 0 | 0 | 484ms | 712ms | 712ms | 10 | 0.0 | - |
| eth_feeHistory 4 | 8 | 8 | 0 | 0 | 178ms | 229ms | 229ms | 20 | 0.0 | - |
| eth_getBlockByNumber latest hashes | 8 | 8 | 0 | 0 | 168ms | 528ms | 528ms | 20 | 0.0 | - |
| eth_getBlockByNumber recent hashes | 8 | 8 | 0 | 0 | 189ms | 405ms | 405ms | 20 | 0.0 | - |
| eth_getBlockByHash recent | 8 | 8 | 0 | 0 | 167ms | 563ms | 563ms | 20 | 0.0 | 0% |
| eth_getBlockTransactionCountByNumber | 8 | 8 | 0 | 0 | 131ms | 197ms | 197ms | 15 | 0.0 | - |
| eth_getBalance latest | 8 | 8 | 0 | 0 | 275ms | 702ms | 702ms | 15 | 0.0 | - |
| eth_getTransactionCount latest | 8 | 8 | 0 | 0 | 271ms | 415ms | 415ms | 15 | 0.0 | - |
| eth_getCode latest | 8 | 8 | 0 | 0 | 560ms | 1.24s | 1.24s | 15 | 0.0 | - |
| eth_getStorageAt latest | 8 | 8 | 0 | 0 | 300ms | 650ms | 650ms | 15 | 0.3 | - |
| eth_getTransactionByHash recent | 8 | 8 | 0 | 0 | 251ms | 448ms | 448ms | 15 | 0.0 | 0% |
| eth_getTransactionReceipt recent | 8 | 8 | 0 | 0 | 161ms | 358ms | 358ms | 15 | 0.0 | 0% |
| eth_getTransactionByBlockNumberAndIndex | 8 | 8 | 0 | 0 | 187ms | 361ms | 361ms | 15 | 0.0 | - |
| eth_getLogs 10 blocks, token | 8 | 8 | 0 | 0 | 223ms | 437ms | 437ms | 50 | 0.0 | - |
| eth_call balanceOf | 8 | 8 | 0 | 0 | 588ms | 2.16s | 2.16s | 30 | 3.8 | - |
| eth_estimateGas transfer | 8 | 8 | 0 | 0 | 424ms | 778ms | 778ms | 50 | 0.4 | - |
| web3_clientVersion | 8 | 8 | 0 | 0 | 141ms | 349ms | 349ms | 5 | 0.0 | - |
| net_version | 8 | 8 | 0 | 0 | 71ms | 253ms | 253ms | 5 | 0.0 | - |

### heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber recent full | 8 | 8 | 0 | 0 | 198ms | 356ms | 356ms | 20 | 0.0 | - |
| eth_getBlockReceipts recent | 8 | 8 | 0 | 0 | 155ms | 719ms | 719ms | 30 | 0.0 | - |
| eth_getLogs 1000 blocks, no filter | 8 | 0 | 8 | 0 | 178ms | 349ms | 349ms | 55 | 0.0 | - |
| eth_getLogs 10000 blocks, token | 8 | 7 | 1 | 0 | 3.62s | 10.13s | 10.13s | 95 | 18.5 | - |
| eth_getLogs 1000 blocks, Transfer topic | 8 | 8 | 0 | 0 | 4.43s | 6.28s | 6.28s | 55 | 1.9 | - |
| eth_call real calldata latest | 8 | 1 | 7 | 0 | 982ms | 2.07s | 2.07s | 30 | 7.3 | - |
| eth_estimateGas real calldata | 8 | 3 | 5 | 0 | 666ms | 3.16s | 3.16s | 50 | 2.6 | - |
| eth_createAccessList | 8 | 8 | 0 | 0 | 1.28s | 22.52s | 22.52s | 20 | 40.9 | - |
| debug_traceCall callTracer | 8 | 8 | 0 | 0 | 713ms | 2.71s | 2.71s | 40 | 6.1 | - |
| trace_call | 8 | 8 | 0 | 0 | 1.17s | 22.29s | 22.29s | 40 | 11.0 | - |
| debug_traceTransaction recent | 8 | 8 | 0 | 0 | 403ms | 1.26s | 1.26s | 40 | 2.1 | - |
| trace_transaction recent | 8 | 8 | 0 | 0 | 405ms | 1.27s | 1.27s | 40 | 0.9 | - |
| trace_replayTransaction recent | 8 | 8 | 0 | 0 | 414ms | 840ms | 840ms | 80 | 2.0 | - |
| debug_traceBlockByNumber recent | 8 | 8 | 0 | 0 | 415ms | 6.09s | 6.09s | 40 | 0.0 | - |
| debug_traceBlockByHash recent | 8 | 8 | 0 | 0 | 493ms | 832ms | 832ms | 40 | 1.9 | - |
| trace_block recent | 8 | 8 | 0 | 0 | 573ms | 6.60s | 6.60s | 40 | 0.0 | - |
| trace_replayBlockTransactions recent | 8 | 8 | 0 | 0 | 851ms | 985ms | 985ms | 80 | 0.8 | - |
| debug_getRawBlock recent | 8 | 8 | 0 | 0 | 158ms | 437ms | 437ms | 20 | 0.0 | - |
| debug_getRawReceipts recent | 8 | 8 | 0 | 0 | 186ms | 348ms | 348ms | 30 | 0.0 | - |
| batch of 10 mixed | 8 | 7 | 0 | 1 | 521ms | 1.18s | 1.18s | 170 | 0.4 | - |

### deep

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep hashes | 8 | 8 | 0 | 0 | 116ms | 700ms | 700ms | 20 | 0.0 | 25% |
| eth_getBlockByHash deep | 8 | 8 | 0 | 0 | 377ms | 1.18s | 1.18s | 20 | 1.5 | 38% |
| eth_getBalance deep | 8 | 8 | 0 | 0 | 523ms | 874ms | 874ms | 15 | 1.9 | 0% |
| eth_getTransactionCount deep | 8 | 8 | 0 | 0 | 490ms | 642ms | 642ms | 15 | 1.8 | 0% |
| eth_getCode deep | 8 | 8 | 0 | 0 | 273ms | 569ms | 569ms | 15 | 0.3 | 13% |
| eth_getStorageAt deep | 8 | 8 | 0 | 0 | 170ms | 354ms | 354ms | 15 | 0.0 | 13% |
| eth_getTransactionByHash deep | 8 | 8 | 0 | 0 | 521ms | 979ms | 979ms | 15 | 5.3 | 0% |
| eth_getTransactionReceipt deep | 8 | 8 | 0 | 0 | 655ms | 887ms | 887ms | 15 | 3.3 | 13% |
| eth_getLogs 10 blocks deep | 8 | 8 | 0 | 0 | 375ms | 685ms | 685ms | 50 | 0.6 | 38% |
| eth_feeHistory 4 deep | 8 | 8 | 0 | 0 | 229ms | 432ms | 432ms | 20 | 1.8 | - |
| debug_getRawHeader deep | 8 | 8 | 0 | 0 | 185ms | 462ms | 462ms | 15 | 0.0 | 25% |

### deep-heavy

| case | n | ok | refused | err | p50 | p95 | max | credits | r2/call | resp-cache |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_getBlockByNumber deep full | 8 | 8 | 0 | 0 | 131ms | 194ms | 194ms | 20 | 0.0 | 100% |
| eth_getBlockReceipts deep | 8 | 8 | 0 | 0 | 103ms | 246ms | 246ms | 30 | 0.0 | 50% |
| eth_getLogs 1000 blocks deep | 8 | 2 | 6 | 0 | 1.70s | 2.56s | 2.56s | 50 | 5.5 | 100% |
| eth_getLogs 10000 blocks deep, Transfer | 8 | 0 | 8 | 0 | 136ms | 362ms | 362ms | 95 | 0.3 | - |
| eth_call replay at n-1 | 8 | 5 | 2 | 1 | 726ms | 25.34s | 25.34s | 30 | 25.8 | - |
| eth_estimateGas replay at n-1 | 8 | 6 | 1 | 1 | 713ms | 40.00s | 40.00s | 50 | 3.3 | - |
| debug_traceCall replay at n-1 | 8 | 8 | 0 | 0 | 776ms | 1.99s | 1.99s | 40 | 3.0 | - |
| debug_traceTransaction deep | 8 | 8 | 0 | 0 | 731ms | 1.69s | 1.69s | 40 | 3.5 | - |
| trace_transaction deep | 8 | 8 | 0 | 0 | 943ms | 1.73s | 1.73s | 40 | 3.3 | - |
| trace_replayTransaction deep | 8 | 8 | 0 | 0 | 869ms | 1.61s | 1.61s | 80 | 5.9 | - |
| debug_traceBlockByNumber deep | 8 | 8 | 0 | 0 | 694ms | 2.00s | 2.00s | 40 | 4.3 | - |
| trace_block deep | 8 | 8 | 0 | 0 | 545ms | 1.01s | 1.01s | 40 | 0.8 | - |
| trace_replayBlockTransactions deep | 8 | 8 | 0 | 0 | 617ms | 1.73s | 1.73s | 80 | 0.0 | - |
| debug_getRawBlock deep | 8 | 8 | 0 | 0 | 93ms | 453ms | 453ms | 20 | 0.0 | 25% |
| debug_getRawReceipts deep | 8 | 8 | 0 | 0 | 121ms | 255ms | 255ms | 30 | 0.0 | 25% |

### Failures

- 1× eth_estimateGas replay at n-1: HTTP 0, code 0, timeout
- 1× eth_call replay at n-1: HTTP 200, code -32005, execution exceeded its time budget (timeout)
- 1× batch of 10 mixed: HTTP 200, code undefined, insufficient funds for gas * price + value: address 0xfAf7d06e0Bb850755F6AAd6b011e45C2D9d8

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

Cost per 1M requests comes from Cloudflare's own metrics for these run windows: `node bench/cost.mjs --report /private/tmp/claude-501/-Users-eabz-Documents-GitHub-nullrpc--claude-worktrees-inspiring-goldwasser-3a2612/23dddcd9-3a5b-40ed-a403-d155534544b0/scratchpad/after` fills the cost side (Workers requests and CPU, Durable Object requests, R2 Class B) and the margin per plan.
