# Smart Placement A/B, Hoodi, 2026-10-10 00:09 to 00:44 UTC

Keyed, 8 repeats per case, from one client in Dallas (DFW). `before/` on fb9be53f with
placement off; placement enabled at 00:16 (version 86430adb); `after/` at 00:41 once the
placement analysis had run (`cf-placement: remote-EWR`, the Worker moved to Newark, near the
Durable Objects and D1, not near the R2 bucket in WNAM); `after-2/` at 00:43 with the placed
location's caches warm. Reverted at 00:45.

| case | before p50 | placed, warm p50 |
|---|---:|---:|
| eth_chainId, blockNumber, gasPrice | 54 to 59ms | 110 to 140ms |
| recent receipt / transaction by hash | 63 to 65ms | 163 to 255ms |
| eth_getBalance latest | 185ms | 210ms |
| balanceOf eth_call | 335ms | 355ms |
| deep transaction by hash | 603ms | 146ms |
| deep receipt by hash | 464ms | 125ms |
| deep debug_traceTransaction / trace_transaction | 896 / 693ms | 201 / 210ms |
| deep trace_replayTransaction | 792ms | 269ms |
| 1,000-block Transfer logs at head | 266ms | 932ms |
| trace_call, real calldata | 402ms | 1.21s |

Two effects. The forwarded hop costs every request about 60ms from this client, which dominates
the cheap calls a wallet makes. Deep lookups and tracers improved 2 to 4×, from proximity to the
upstreams and from traffic concentrating onto a few warm isolates at one location. Execution at
latest got slower (trace_call, real calldata), consistent with the live state shards being
reached through the extra hop as well.

Decision: off for Hoodi, whose traffic is wallet-shaped. Worth enabling for an archive-heavy
endpoint, or revisiting if the deep-read path can be made as fast without it (the hash-location
cache and traffic concentration suggest most of the gain is cache warmth, not distance).
Measuring from more than one city is still the missing piece.
