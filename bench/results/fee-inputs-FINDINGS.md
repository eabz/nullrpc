# Mainnet fee methods: the oracle's window, before and after the fee inputs cache (2026-10-10, 03:11 to 03:21 UTC)

The 02:23 full run (20261010T022332Z-compare.md) had eth_gasPrice at 728 ms, eth_maxPriorityFeePerGas
814 ms and eth_feeHistory 426 ms p50 on mainnet against 84 to 119 ms on Hoodi, one R2 miss each.
The samples in milestone-1/report.json say why: nearly every one is `miss head` (the key carries
the pinned head; 8 repeats of 60 cases spread over 5 minutes of 12 s blocks land on different
heads, as designed), and each miss carried `hit=17..21` archive reads: the gas price oracle read
and decoded its window of 20 full mainnet records (hundreds of transactions each) through the
edge cache for one answer. A probe at a fresh head showed `miss head`, `hit=20 miss=1`, 1.9 s;
a cold data center `hit=0 miss=21`, 2.5 s; a hit 180 to 250 ms. Classification was right; the
cost of a miss was wrong.

Fix (435d46c, deployed to nullrpc-rpc-1 at 03:17 UTC): what a fee method reads of a block (a few
header fields, the oracle's three tip samples, every transaction's effective tip and gas used) is
fixed by the block's hash. It is computed once per record and kept under the hash in the isolate
(512 blocks) and at the edge for a day (`/_cache/fees/v1/<chain>/<hash>`); a block whose hash the
request knows without reading it (the head's listing in live/HEAD.json, the archive's offsets)
costs no record read. A new head reads one record: its own.

## Head-by-head probe, keyless, one client, every 3 s for 2.5 minutes

Each round: eth_gasPrice, eth_maxPriorityFeePerGas, eth_feeHistory(4, latest, [25, 75]), in that
order. A `miss head` is the first call at a new head; the two that follow at the same head are
their own misses (a different method key) and show what a second method costs once the head's
inputs exist. Wall time from the client; p50 over the probe's samples.

| | before p50 (range) | before reads | after p50 (range) | after reads |
|---|---:|---|---:|---|
| eth_gasPrice, new head | 1072 ms (532 to 1880) | hit=13..21 miss=0..5 | 979 ms (583 to 1503) | hit=0..1 miss=1..2 |
| eth_maxPriorityFeePerGas, new head | 799 ms (141 to 1557) | hit=16..21 | 385 ms (149 to 938) | hit=0..1 miss=0 |
| eth_feeHistory, new head | 603 ms (170 to 906) | hit=2..6 | 372 ms (162 to 996) | hit=0..2 miss=0 |
| any of the three, `hit head` | 423 to 426 ms | none | 334 to 346 ms | none |

Reads per new head fell from the window to one or two. The second and third methods at a new
head now cost about what a hit costs (plus 40 ms); before, each paid the window again, since the
oracle's per-isolate memo rarely met the same isolate. eth_gasPrice as the first call at a new
head still pays about 600 ms over a hit: the head record itself, written to R2 seconds earlier and
in no edge cache yet (one R2 read of a 300 to 600 KB object plus its decode), then 20 small edge
reads of the other blocks' inputs in parallel. That is the one block the design leaves; the
daemon writing the head's inputs beside its record would remove it.

## Scenario run, --only "gasPrice|feeHistory|PriorityFee|blockNumber|latest" --repeat 8, keyless

fee-inputs-compare.md. Keyless at 10 rps the calls window takes 13 to 22 s, one or two heads,
so 6 or 7 of 8 samples per case are hits and the p50 (73 to 96 ms) measures the hit path on
both sides; the misses are the probe's story: before, eth_gasPrice's one miss took 1387 ms with
`hit=21`, after, its two misses 713 ms at most with `hit=0 miss=1`. The 02:23 keyed run had
the 60 cases interleaved over 5 minutes, which is why its p50s were misses.
