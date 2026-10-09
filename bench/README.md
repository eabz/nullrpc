# bench

Correctness and load tooling for a deployed nullrpc endpoint. Plain Node 20+ or Bun scripts,
no dependencies. Targets come from [apps/networks.json](../apps/networks.json) (`--chain`), or
`--url` for anything else.

| Script | What it does |
|---|---|
| `verify.mjs` | Asks nullrpc and a public reference node the same questions and reports every difference: blocks, transactions, receipts, raw encodings, logs, state, fees and execution, sampled from the archive, the live window and the head. |
| `load.mjs` | Runs a weighted mix of methods from N concurrent workers and reports per-method p50/p90/p99, throughput, rate limits and errors. `--stress` ramps concurrency until the endpoint degrades. |
| `lib.mjs` | Shared: argument parsing, the timed JSON-RPC client, hex normalization, deep diff, percentiles. |

## Keys

Keyless clients get 10 requests/s with a burst of 20 per client network, and both scripts
default to pacing under that. A real benchmark needs a key on a plan that allows the rate:

```bash
export NULLRPC_KEY=nr_…
```

`--key` overrides the variable. With a key, `verify.mjs` paces at 40 rps and `load.mjs` is
unpaced (`--rps` caps it).

## Correctness

```bash
node bench/verify.mjs --chain 560048
```

Samples genesis, block 1, `--blocks` random archive blocks, the promoted boundary `P`, half as
many live-window blocks and the head, then for each compares every block-, transaction-,
receipt- and log-reading method, state at explicit block numbers for the sampled addresses,
`eth_feeHistory`, and replays sampled calls at their parent block through `eth_call`,
`eth_estimateGas`, `eth_createAccessList` and `debug_traceCall`. `debug_getRaw*` and
`debug_traceCall` are compared only when the reference supports them.

Comparisons use explicit block numbers, never `latest`, so the two nodes' head lag does not
show up as a difference. Tip-dependent estimates (`eth_gasPrice`, `eth_maxPriorityFeePerGas`,
`eth_blobBaseFee`) are only checked to answer.

| Flag | Default | Use |
|---|---|---|
| `--ref URL` | the chain's first entry in `REFERENCES` (lib.mjs) | another reference node |
| `--blocks N` | 8 | random archive blocks to sample |
| `--seed N` | 1 | the sample; change it to cover other blocks |
| `--ignore a.b,c` | none | fields to skip (dotted paths; `[*]` for array items), for known client differences |
| `--show N` | 20 | problems and differing calls to print |
| `--json FILE` | | the full report |

Exit code 1 when any compared answer differs or nullrpc errors where the reference answers.

## Load

```bash
node bench/load.mjs --chain 560048 --concurrency 16 --duration 60
node bench/load.mjs --chain 560048 --mix exec --batch 8
node bench/load.mjs --chain 560048 --stress --stages 4,8,16,32,64,128 --stage-seconds 20
```

The workload is built from the target itself: a few recent and archive blocks give the
transactions, addresses and contracts the mix reads. Mixes (`--mix`): `read` (a public
endpoint's typical traffic, the default), `blocks`, `state`, `exec`, `logs`. `--batch N` sends
batches of N items per request instead of single calls.

Stress mode runs each stage of `--stages` for `--stage-seconds` and stops at the first stage
whose error rate exceeds `--max-errors` (percent, default 2), whose p99 exceeds `--max-p99`
(ms, default 2000), or where more than half the calls were rate-limited; the last healthy
stage is the answer. 429s are counted separately from errors.

`--json FILE` writes every stage with per-method percentiles.

## Results

`results/` keeps the reports of runs worth remembering, named `{date}-{chain}-{script}[-{mix}]`,
as the script printed them plus the `--json` file. Keyless runs are paced at 8 rps, so their
throughput numbers are the pacing, not the endpoint's limit; their latencies are real.
