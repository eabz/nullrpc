# Head tier of the response cache: before and after (Hoodi, 2026-10-09)

The change: `apps/rpc/src/response-cache.ts` gained a head tier (answers that depend on blocks
above P, keyed by the pinned head's number and hash, 60 s at the edge and in the isolate), on
top of the immutable tier. Deployed as nullrpc-rpc-560048 version 1d0d53f6 from main 367d137.
That version also carries the live-state change (8744e9c: live state values and witnesses
cached per isolate under the pinned head), so the "after" units include both.

Runs: `node bench/scenario.mjs --chain 560048 --phase user --users 4 --user-seconds 60`,
keyless (the benchmark key was not available; 4 users keep the mix under the 10 rps public cap).
`head-tier-before` (main 33b1193 deployed) ran at 17:59 UTC; `head-tier-after` right after the
deploy at 18:03 (cold isolates); `head-tier-after-2` at 18:04 once it settled. Cost pulls five
minutes after each window.

## Per-request units (Cloudflare metrics, `bench/cost.mjs`)

| run | client req | live calls/req | DO req/req | R2 B/req | cpu ms/req | rpc cpu p50 / p99 |
|---|---:|---:|---:|---:|---:|---:|
| milestone 17:26 wallet user, keyed, 25 users (before, main 33b1193) | 2207 | 1.0 | 2.1 | 0.3 | 65.0 | 6.7 / 723 ms |
| head-tier-before, keyless, 4 users (main 33b1193) | 435 | contaminated | contaminated | | | |
| head-tier-after (cold isolates) | 391 | 0.5 | 1.1 | 0.4 | 34.6 | 3.3 / 406 ms |
| head-tier-after-2 | 386 | 0.5 | 1.1 | 0.5 | 47.6 | |

The keyless before window is unusable: its metrics show 11 RPC invocations and 18 Durable
Object requests per client request, so other traffic (about ten times mine) shared the window.
The milestone's wallet-user window on the same code is the clean before reference. Against it,
live calls per request halve (1.0 to 0.5), Durable Object requests per request halve (2.1 to
1.1) and CPU per request drops by a quarter to a half (65 to 35-48 ms). Dollars per 1M requests
($2.15 before, $2.07-2.26 after) are not comparable across runs of such different sizes: the
daemon's R2 Class A writes and the account app's rows are fixed per window and are divided by
four to five times fewer requests in the keyless runs (Class A alone is 14-16% of the after
cost and 1% of the milestone's).

## What the tier answered (`x-nullrpc-response-cache`, head-tier-after-2, 386 calls)

| step | hit head | miss head | other |
|---|---:|---:|---|
| eth_blockNumber | 24 | 4 | |
| eth_gasPrice | 20 | 7 | |
| eth_maxPriorityFeePerGas | 20 | 6 | |
| eth_feeHistory latest | 19 | 5 | |
| eth_getBlockByNumber latest | 19 | 5 | |
| eth_getBlockByNumber recent | 8 | 16 | |
| eth_call balanceOf (two steps) | 18 | 36 | |
| eth_getLogs transfers to me | 3 | 21 | |
| eth_getBalance latest | 1 | 27 | |
| eth_getTransactionCount pending | 1 | 26 | |
| eth_getTransactionReceipt / ByHash (recent) | 2 | 46 | |
| eth_estimateGas latest | 0 | 21 | 3 bypass (invalid params) |
| eth_chainId | | | 28 bypass (constant) |

135 of 386 calls (35%) were head hits. The head-only methods hit 70-86% of the time with the
head moving every 12 s and 4 users at about 7 rps; at 25 users the fraction rises toward the
share of requests that are not the first for their head. Balance, nonce, receipt and
transaction lookups miss because each simulated user draws a fresh address or transaction;
balanceOf hits when a holder repeats within a head. The first "after" run shows a few `bypass`
on cached methods: the first requests after the deploy still reached isolates of the old
version.

## Latency

Keyless from one laptop the step latencies are dominated by round-trip variance (eth_chainId,
which touches no cache, moved from 51 to 69-120 ms p50 between runs), so they are not a clean
signal. Within a run the cached steps sit at the eth_chainId floor: in after-2, eth_blockNumber
89 ms, eth_gasPrice 99 ms, eth_maxPriorityFeePerGas 56 ms, eth_feeHistory 66 ms, latest block
71 ms (floor 69 ms), and the second balanceOf step, which hits half the time, 145 ms against 451
ms for the first.
