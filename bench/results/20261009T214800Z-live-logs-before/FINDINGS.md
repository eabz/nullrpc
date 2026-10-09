# Live-window log index: before

Keyless run of the eth_getLogs cases (`node bench/scenario.mjs --phase calls --only getLogs
--repeat 8`) against hoodi.nullrpc.dev before the change, at head 3785427 with P at 3785298
(a 129-block live window; the 21:10 milestone had 194). The user phase needs the internal key
and was not run here; the milestone's transfer-history step (an address plus two topics over
the last 1,000 blocks) was 881 ms p50, 1.75 s p95, the slowest step of the session.

| case | p50 | p95 |
|---|---:|---:|
| eth_getLogs 10 blocks, token | 98 ms | 169 ms |
| eth_getLogs 1000 blocks, no filter (refused, -32005) | 198 ms | 432 ms |
| eth_getLogs 10000 blocks, token | 1.27 s | 3.06 s |
| eth_getLogs 1000 blocks, Transfer topic | 528 ms | 990 ms |
| eth_getLogs 10 blocks deep | 145 ms | 289 ms |
| eth_getLogs 1000 blocks deep (mostly refused) | 174 ms | 174 ms |
| eth_getLogs 10000 blocks deep, Transfer (mostly refused) | 89 ms | 1.78 s |

## Why the live window was slow

Above P there was no index: `logs.ts` read every live block's record, decoded the whole record
(transactions, senders, receipts), built the JSON of every log, then filtered. The isolate keeps
only 32 decoded records, so a 194-block window was re-decoded on nearly every query; the
earlier eth_getLogs session measured 219 live blocks at 3.2 s against 1.7 s for 781 archived
ones.

## The header bloom's selectivity on Hoodi

Measured over the last 200 blocks (scratchpad `bloom-measure.mjs`, head 3785425): bits set per
bloom p10 12, p50 73, p90 581, max 623 of 2,048, so the single-value false-positive estimate
is 0.00% at the median and 2.8% at the fullest block. For the scenario's own filters:

| filter | blocks with matches | blocks the bloom admits | of |
|---|---:|---:|---:|
| topics [Transfer] | 139 | 139 | 200 |
| busiest token address (815 transfers) | 121 | 121 | 200 |
| that address + Transfer + holder | 121 | 121 | 200 |
| second token (680 transfers) | 121 | 124 | 200 |
| that address + Transfer + holder | 121 | 121 | 200 |
| fourth token (18 transfers) | 12 | 12 | 200 |
| that address + Transfer + holder | 6 | 12 | 200 |
| fifth token (17 transfers) | 8 | 8 | 200 |
| that address + Transfer + holder | 3 | 4 | 200 |

The bloom admits the right blocks almost exactly (at most 6 false positives in 200, and those
in the sparse case where the whole query reads 12 records), so the per-block bloom is the index;
the richer per-window address and topic index is not needed on Hoodi. The busiest tokens appear
in 60% of the blocks, so those queries still read most of the window, but now as raw records
through the WebAssembly extraction instead of full decodes.

## The change (this branch)

- The daemon keeps each live block's header `logsBloom` (parsed from the record, also at
  restart from the spool) and writes `live/blooms/{first}-{last}-{hash}.bin` with every head
  move, named by `log_blooms` in `live/HEAD.json` (docs/storage.md, "Live records").
- The Worker tests the filter's addresses and topics against each live block's bloom and reads
  only the admitted records, raw, through `frameLogs` (packages/frames); nothing of a record is
  decoded beyond its accepted logs, and reading stops at the block that exceeds `MAX_LOGS`. The
  pinned head, the stale re-pin (candidates are narrowed again under the new head) and the
  promoted-meanwhile fallback are as before.
- Without `log_blooms` (an older daemon, or a pin from the live Worker after a reorg) every
  live block is a candidate, as today, but read through the same extraction.
