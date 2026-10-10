# Before vs After

Before: bench/results/fee-inputs-before  After: bench/results/fee-inputs-after

Per case: successful-answer p50, R2 misses per call, execution rounds and live reads (median), credits and their revenue at $0.03 per million credits. ok/n counts successes; refusals (reverts, over-wide ranges) are neither errors nor timed.

## normal

| case | credits | $ rev / 1M | Before ok/n | p50 | R2 | rounds | live | After ok/n | p50 | R2 | rounds | live |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_maxPriorityFeePerGas | 10 | 0.30 | 8/8 | 73ms | 0.0 | - | - | 8/8 | 76ms | 0.0 | - | - |
| eth_blockNumber | 10 | 0.30 | 8/8 | 62ms | 0.0 | - | - | 8/8 | 62ms | 0.0 | - | - |
| eth_getStorageAt latest | 15 | 0.45 | 8/8 | 74ms | 0.0 | - | - | 8/8 | 275ms | 0.0 | - | - |
| eth_getTransactionCount latest | 15 | 0.45 | 8/8 | 195ms | 0.0 | - | - | 8/8 | 202ms | 0.0 | - | - |
| eth_getBalance latest | 15 | 0.45 | 8/8 | 212ms | 0.0 | - | - | 8/8 | 209ms | 0.0 | - | - |
| eth_getTransactionByBlockNumberAndIndex | 15 | 0.45 | 8/8 | 113ms | 0.0 | - | - | 8/8 | 81ms | 0.0 | - | - |
| eth_getCode latest | 15 | 0.45 | 8/8 | 382ms | 0.0 | - | - | 8/8 | 328ms | 0.0 | - | - |
| eth_feeHistory 4 | 20 | 0.60 | 8/8 | 69ms | 0.0 | - | - | 8/8 | 73ms | 0.0 | - | - |
| eth_gasPrice | 10 | 0.30 | 8/8 | 68ms | 0.0 | - | - | 8/8 | 75ms | 0.0 | - | - |
| eth_getBlockByNumber latest hashes | 20 | 0.60 | 8/8 | 67ms | 0.0 | - | - | 8/8 | 69ms | 0.0 | - | - |

## heavy

| case | credits | $ rev / 1M | Before ok/n | p50 | R2 | rounds | live | After ok/n | p50 | R2 | rounds | live |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_call real calldata latest | 30 | 0.90 | 2/8 | 4.05s | 8.0 | 4 | 29 | 5/8 | 7.39s | 35.0 | 5 | 30 |

## deep

| case | credits | $ rev / 1M | Before ok/n | p50 | R2 | rounds | live | After ok/n | p50 | R2 | rounds | live |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| eth_feeHistory 4 deep | 20 | 0.60 | 8/8 | 74ms | 0.0 | - | - | 8/8 | 66ms | 0.0 | - | - |

## deep-heavy

| case | credits | $ rev / 1M | Before ok/n | p50 | R2 | rounds | live | After ok/n | p50 | R2 | rounds | live |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|

## Wallet user

| | Before | After |
|---|---:|---:|
| complete sessions | 0 | 0 |
| clean sessions | 0 | 0 |
| session p50 | - | - |

## Cost per 1M requests (Cloudflare metrics per window)

| window | Before $ | live/req | DO/req | R2/req | CPU ms/req | After $ | live/req | DO/req | R2/req | CPU ms/req |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|

Revenue per 1M requests at the measured credits per request is $0.62 to $0.69 on every paid plan; a window above that loses money per request.
