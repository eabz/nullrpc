# Receipts pack (segment layout 2): first promotion after the daemon restart

Generation 200 wrote the first layout-2 segment, blocks 3784750 to 3785012, at 20:42 UTC on
2026-10-09. A/B: three cold 80-block Transfer-topic eth_getLogs windows inside it against three
in the layout-1 segment just below, keyed, Worker CPU from a tail capture (ab.txt, ab-cpu.txt).

| layout | logs per window | wall p50 | Worker CPU p50 |
|---|---:|---:|---:|
| 1 (receipts inside the block frame) | 655 to 703 | 161ms | 16ms |
| 2 (receipts.pack) | 580 to 671 | 197ms | 12ms |

CPU per query drops by about a quarter; wall time does not move, because at 2 to 3 R2 reads per
window the request is bound by reads and the edge, not decoding. On Hoodi transactions are
small, so skipping their bytes saves little; mainnet blocks carry far more transaction bytes
per receipt, where the same change should pay several times more. The suite's log cases
(suite/report.md) show the 1,000-block Transfer query at the head at 333ms p50, but 75% of those
answers came from the response cache, so they are not a measure of the layout.

Conclusion: correct and cheap to keep; not the lever for Hoodi's wide-query latency. That is now
reads per candidate block and the live window's share, as the eth_getLogs session found.
