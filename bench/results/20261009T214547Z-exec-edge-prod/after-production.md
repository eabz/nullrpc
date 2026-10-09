# Production after the combined deploy (fb9be53f, main 04c0a48), balanceOf probe, 6 blocks

Keyed, one cold call per new head then the same call warm, Hoodi, 2026-10-09 22:5x UTC.

| block | cold ms | warm ms | cold exec header | cold archive cache |
|---|---:|---:|---|---|
| 3785639 | 1891 | 85 | rounds=2 keys=6 hints=957 live=2 archive=13 | hit=58 miss=2 |
| 3785640 | 896 | 64 | rounds=2 keys=6 hints=156 live=2 archive=13 | hit=58 miss=1 |
| 3785641 | 1744 | 75 | rounds=2 keys=6 hints=1004 live=2 archive=18 | hit=73 miss=2 |
| 3785642 | 744 | 71 | rounds=2 keys=5 hints=0 live=3 archive=2 | hit=7 miss=3 |
| 3785643 | 1008 | 78 | rounds=2 keys=5 hints=0 live=3 archive=2 | hit=9 miss=2 |
| 3785644 | 2079 | 350 | rounds=3 keys=7 hints=171 live=3 archive=23 | hit=99 miss=6 |

cold p50 1008ms (mean 1394ms); warm p50 75ms (mean 120ms). Before (7eba09c4): cold 475 to 614ms
with hints about 1,000, warm about 250 to 400ms. Once an isolate has profiled the function
(blocks 3785642 and 3785643: hints=0, two archive reads) a cold call is 744ms to 1.0s and is
bound by the live reads and the per-block edge misses, not by hints; isolates that have not
seen the function still wave (hints=957 to 1,004). Warm calls are 3 to 5× faster than before.
