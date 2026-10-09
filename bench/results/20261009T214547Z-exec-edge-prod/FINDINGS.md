# Why the execution medians rose between the 19:36 and 21:10 milestones (2026-10-09)

Question: between `20261009T193659Z-milestone` (git `d496265^`) and `20261009T211054Z-milestone`
the execution medians rose (eth_call balanceOf 426 to 542 ms, eth_call replay at n-1 128 to
626 ms, eth_estimateGas replay 162 to 479 ms, debug_traceCall replay 240 to 818 ms, trace_call
508 ms to 2.16 s) while the p95 tails improved. In between, commit 0aba09b (the hints wave and
witnesses shared per data center through the edge cache) was deployed at 19:48 and the daemon
was restarted. Was the sharing the cause?

**Answer: no. The 19:36 medians were warm-isolate repeats; the later runs were cold ones. The
price of a cold call did not rise with the sharing, and the deep replays that regressed most
never touch it.** No code change is made.

## 1. Production reproduction (this directory)

`node bench/scenario.mjs --phase calls --only "eth_call|eth_estimateGas|trace_call|debug_traceCall" --repeat 8`,
keyed, 21:45 UTC, head 3785350, generation 201, with `wrangler tail` (`tail.json.gz`, CPU per
case in `cpu.md`). Same code as the 21:10 run. Medians: balanceOf 718 ms, eth_call replay
629 ms, eth_estimateGas replay 781 ms, debug_traceCall replay 564 ms, trace_call 651 ms: the
21:10 numbers, not the 19:36 ones. (An identical run, started by mistake two minutes earlier and discarded, had warmed some isolates; the run kept is the one with the tail capture.)

### What the `x-nullrpc-exec` header says, per sample

The header is absent when a request executed nothing through the state source (`rounds=0 hints=0`):
the executor answered from the module's per-isolate block snapshot. `hints=0` with rounds means
the isolate had the hints wave of that block cached (the executor's `hintCache`) and only ran the
dependent rounds. Both are warm-isolate answers; `hints>0` is a cold one (the wave of witnesses
was read and handed to the module).

| run | case | warm of 8 (no header / hints=0) | warm p50 | cold p50 | cold hints (mean keys) |
|---|---|---:|---:|---:|---:|
| 19:36 | eth_call balanceOf | 2 / 4 | 241 ms | 637 ms | 538 |
| 21:10 | eth_call balanceOf | 0 / 0 | - | 542 ms | 672 |
| now | eth_call balanceOf | 2 / 1 | 66 ms | 592 ms | 803 |
| 19:36 | eth_call replay at n-1 | 5 / 1 | 119 ms | 559 ms | 1129 |
| 21:10 | eth_call replay at n-1 | 0 / 0 | - | 626 ms | 612 |
| now | eth_call replay at n-1 | 0 / 1 | 378 ms | 1034 ms | 1122 |
| 19:36 | eth_estimateGas replay at n-1 | 3 / 2 | 152 ms | 634 ms | 769 |
| 21:10 | eth_estimateGas replay at n-1 | 2 / 0 | 176 ms | 907 ms | 760 |
| now | eth_estimateGas replay at n-1 | 2 / 0 | 77 ms | 918 ms | 1080 |
| 19:36 | debug_traceCall replay at n-1 | 2 / 1 | 118 ms | 525 ms | 1313 |
| 21:10 | debug_traceCall replay at n-1 | 1 / 0 | 210 ms | 871 ms | 579 |
| now | debug_traceCall replay at n-1 | 5 / 0 | 67 ms | 754 ms | 835 |
| 19:36 | debug_traceCall callTracer | 1 / 3 | 328 ms | 768 ms | 568 |
| 21:10 | debug_traceCall callTracer | 0 / 0 | - | 496 ms | 687 |
| now | debug_traceCall callTracer | 1 / 5 | 467 ms | 641 ms | 966 |
| 19:36 | trace_call | 0 / 7 | 532 ms | 508 ms | 186 |
| 21:10 | trace_call | 0 / 0 | - | 2160 ms | 547 |
| now | trace_call | 0 / 5 | 600 ms | 1367 ms | 966 |

(`samples.calls[]` of the three `report.json`; `trace_call` and the real-calldata cases draw a
different transaction each repeat, so their cold medians are corpus, not code: 2.3 vs 27.4 read
rounds per call at 19:36 vs 21:10.)

In the 19:36 run 4 to 7 of the 8 repeats of each case landed on an isolate that had already
executed at that block; at 21:10, 0 to 2. The deep replays are at random archive blocks below
P: their reads go to the archive only (`live=0` in every sample), the hints come from the
archived witness, and the live window's edge sharing is never on their path. Their 4 to 5x
median change is entirely the warm share: 119 ms when the snapshot answers, 560 to 1030 ms when
the call is executed.

The cold price did not rise with the sharing: a two-round balanceOf with a full wave cost 858 ms
at 19:36 (`rounds=2 keys=5 hints=1016`), 518 to 614 ms at 21:10 and 475 ms now. A dependent
round still costs about 150 to 200 ms (`rounds=3 hints=0`: 600 ms at 19:36, 514 ms now).

### The same call repeated (`affinity-prod.log`, current code, keyed)

| | first call | repeats |
|---|---:|---|
| deep eth_call replay, 10 sequential on one connection | 5.68 s (`rounds=3 hints=2002`, 38 R2 misses) | 62 to 106 ms, no exec header, all nine |
| balanceOf at latest, 10 sequential on one connection | 552 ms (`rounds=2 hints=179`) | 47 to 180 ms, no exec header, all nine |
| balanceOf at latest, 8 with 4 in flight | | 2 warm (53, 147 ms), 6 cold (560 to 1041 ms, `hints=179`, 1 to 2 rounds) |

One connection stays on one isolate and every repeat is a snapshot answer; four in flight spread
over isolates and most repeats are cold. The benchmark sends each case 8 times with 4 in flight,
shuffled with the other cases, so a case's median is set by how many of its repeats reach an
isolate that already executed there. That share was high at 19:36 and low at 21:10 (and in the
21:10 user phase, which ran a minute later under 25 users, every non-execution step was faster
than at 19:36 by about 15 ms while the whole calls phase at 21:10 was 65 ms slower across all
67 cases, execution or not: `eth_chainId` 108 to 154 ms, `web3_clientVersion` 95 to 150 ms).
More isolates per data center after the afternoon's stress runs at 250 to 1000 rps is the
likely reason the warm share fell; the sharing does not touch which isolate a request reaches.

### CPU (`cpu.md`, from the tail)

Cold balanceOf: 38 ms CPU at 554 ms wall; debug_traceCall replay 147 ms CPU at 358 ms wall;
eth_call replay 215 ms CPU at 780 ms wall. The wall time is reads (shards, archive, edge), not
CPU, and the CPU per cold call is in line with the keyed run of 18:18 after the module cache
(`20261009T181800Z-exec-cpu/after/cpu.txt`: cold eth_call replay 171 ms, real calldata 165 ms).

## 2. The sharing bypassed (local Worker on the real bindings)

`wrangler dev --config wrangler.profile.jsonc` (local workerd, remote Hoodi R2 and live
bindings, open access, one isolate) with `--var STATE_EDGE_SHARE:on|off`, the toggle added for
this measurement and removed again. The same cases (`../20261009T214025Z-exec-edge-local-on`,
`../20261009T215122Z-exec-edge-local-off`): a single always-warm isolate answers repeats in 6 to 16 ms either way, so the
medians there are the corpus mix, not the sharing. The per-block probe (`probe-*.log`: the head
moves, the same balanceOf once cold then once warm, six blocks) gives the once-per-block cost
that the sharing sits in:

| arm | cold per block (ms, one isolate, head just moved) | cold p50 | warm repeat p50 |
|---|---|---:|---:|
| sharing off (`probe-off-balanceOf.log`) | 781, 1203, 1131, 2181, 1334, 1511 | 1203 ms | 4 ms |
| sharing on (`probe-on-balanceOf.log`) | 1209, 1244, 1522, 1525 (the first block, 2167 ms, was the isolate's first request and is left out; one block was answered from the snapshot) | 1383 ms | 4 ms |

Within the noise of a laptop-hosted Worker whose every shard call and R2 read crosses the WAN
(about 1.2 s per cold call either way), the sharing adds nothing measurable; in production the
same cold balanceOf is 475 to 614 ms and a dependent round 150 to 200 ms.

The local Cache API is in-memory, so this isolates the sharing's CPU and serialization (the
digest of the key list, the JSON of the wave, the witness bodies); the production Cache API's
round trip is not in these numbers.

## 3. Conclusion

Cache coldness, at the isolate: the executor's per-isolate hints cache and the module's block
snapshot answered most repeats at 19:36 and few at 21:10. A cold execution costs the same as
before the sharing (balanceOf two rounds plus wave: 858 ms before, 475 to 614 ms after), and the
cases that regressed most never use the shared path. No change to `apps/rpc/src/live.ts`. The
benchmark's medians for execution cases measure isolate affinity as much as the code; comparing
runs needs the warm share (header absent or `hints=0`) alongside the median, or a cold-only
median.

## 4. Two review items added afterwards (commits `ec1bc8f`, `b90f6dc`)

An outside review of the same question named two defects on the execution path. Both are real;
neither explains the median change above (the yield never worked in any of the three runs, and
the cheap calls' wait for the broad wave is the same before and after the sharing), but both
cost latency, and the fix is in `packages/executor/src/shell.ts`.

**The yield between rounds never happened.** The loop yielded a turn of the event loop after a
round that `Date.now()` said took 10 ms or more; a Worker's clock does not advance during
synchronous code, so no round ever looked slow and a request with warm caches and many rounds
held the isolate for its whole duration. The turn is now taken after any round the isolate's
caches answered (no read awaited); a round that read yields on its own read. Emulated under Bun
with the clock frozen as a Worker's is (`yield-emu.ts`, `yield-emu.log`: 40 cached rounds of
20 ms of synchronous work, a 1 ms ticker measuring how long the event loop is held):

| shell | warm request | longest hold of the event loop |
|---|---:|---:|
| main `a02f9a7` | 822 ms | 822 ms (the whole request) |
| this change | 868 ms | 22 ms (one round) |

A single round is still uninterruptible (the module's executed-gas budget bounds it). On
production before the change (`blocking-prod-before.log`, version 7eba09c4): `eth_chainId`
every 50 ms while `debug_traceBlockByNumber` ran back to back, p50 73 ms, p99 193 ms under the
trace against p99 527 ms alone, so one laptop's trace loop does not show the hold on a data
center of many isolates; the local Worker could not host the same harness because a cheap
request arriving while a heavy one is in flight is canceled by the runtime as hung, on main's
code as well (the cross-request promise hazard flagged separately).

**Cheap calls waited for a thousand hinted keys.** Every call at a block the isolate had not
seen read the witnesses around it and waited for that wave before its first round, whether it
needed 2 keys or 200: in the production samples above `hints` is 540 to 1,100 for calls with
`keys` of 2 to 7. Now a call whose callee the isolate has a profile for (learnt from any call
that read, not only three-round ones) reads its profile's keys with its first round and does
not wait: a profile of 32 keys or fewer skips the wave altogether; a larger one has the wave
read but merged into the first round it has arrived for, less the keys answered exactly, with
the snapshot mark on that round, so complex contracts keep their prefetch. Simultaneous
requests at one block share one wave (the follower polls the isolate's cache with its own
timer: in a Worker a request that awaits another request's promise is canceled as hung once
that request finishes). The live window's large batches try the isolate's values before the
edge cache. Per-block cold cost of the same `balanceOf` on the local Worker over the real
bindings, one call per new head then a warm repeat (`probe-local-before.log`,
`probe-local-after.log`):

| code | per block: cold ms (exec header) | cold p50 | warm repeat |
|---|---|---:|---:|
| main `a02f9a7` | 2328 (`hints=979`), 1423 (`hints=249`), 1348 (`hints=226`), 1243 (`hints=141`), 1599 (`hints=977`), 1544 (`hints=1010`); `rounds=1` | 1423 ms | 5 ms |
| this change | 1664 (`hints=977`, the isolate's first call to the function: no profile yet), then 952, 758, 686, 728 with `hints=0 keys=5 rounds=2` | 758 ms | 6 ms |

Every new block before the change paid the wave (141 to 1,010 hinted keys for a call asking 4 to
6); after it only the first call to the function does, and the call then reads its own 5 keys in
two rounds. On this laptop-hosted Worker each round is a WAN round trip, so the saving is one
wave of about 650 ms; in production a round is 150 to 200 ms and the wave 300 to 400 ms, so a
cold `balanceOf` should go from the 475 to 614 ms measured above to about the price of its two
rounds. The production "after" needs the deploy. The production "before" runs here were on
version 7eba09c4; production moved to 22214403 (main at 3f9860f, no execution-path change)
during this work, before the after numbers can be taken.

An earlier version of this change learnt profiles from every round and accumulated the block's
coinbase (one account per block, `keys` growing 6, 7, 8, 9 across blocks in `probe-local-after`
of that version): a profile now keeps only what the dependent rounds asked for beyond the call's
own accounts and the coinbase.

Tests: `packages/executor/test/shell.test.ts` (the turn after a cached round, the shared wave,
the cheap profiled call, the late wave for a large profile) and `apps/rpc/test/live.test.ts`
(the isolate's values before the edge).
