# bench

Correctness and load tooling for a deployed nullrpc endpoint. Plain Node 20+ or Bun scripts,
no dependencies. Targets come from [apps/networks.json](../apps/networks.json) (`--chain`), or
`--url` for anything else.

| Script | What it does |
|---|---|
| `verify.mjs` | Asks nullrpc and a public reference node the same questions and reports every difference: blocks, transactions, receipts, raw encodings, logs, state, fees and execution, sampled from the archive, the live window and the head. |
| `load.mjs` | Runs a weighted mix of methods from N concurrent workers and reports per-method p50/p90/p99, throughput, rate limits and errors. `--stress` ramps concurrency until the endpoint degrades. |
| `scenario.mjs` | The benchmark suite: every method in four classes (normal, heavy, deep, deep-heavy), a simulated wallet-user scenario, and the user mix at each plan's rate cap, priced in credits with the plan economics. Writes `results/<stamp>/report.md`. |
| `cost.mjs` | Cloudflare's own metrics for a scenario's run windows (Workers requests and CPU, Durable Object requests, R2 operations) priced into $ per 1M requests and the margin per plan. Writes `cost.md` next to the report. |
| `cpu.mjs` | CPU and wall time per case from a `wrangler tail --format json` capture taken during a scenario run (the scenario tags each request with `x-nullrpc-bench: <case>`). |
| `rounds.mjs` | Runs execution cases through the executor's WebAssembly under Node, with the state read from a node's JSON-RPC: the dependent read rounds, keys per round and wasm CPU of each call, and with `--hints` how many rounds remain once the witnesses around the block are handed to the executor first. |
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

## Scenario suite

```bash
export NULLRPC_KEY=nr_…                       # a key on the internal plan: no rate or credit limits
node bench/scenario.mjs --chain 560048        # calls, user and stress phases, about 5 minutes
node bench/cost.mjs --report bench/results/<stamp>   # 5+ minutes later, once analytics settle
```

`scenario.mjs` builds its corpus from the chain (recent and random deep blocks, their
transactions and contract calls, the busiest token contracts and holders from recent Transfer
logs), then runs:

1. **calls**: each case `--repeat` times (default 8), four in flight, shuffled. Normal is cheap
   at the head, heavy is expensive at the head (full blocks, receipts, wide logs, real calldata
   through eth_call, estimateGas, access lists and tracers, a batch of 10), deep is cheap at
   random archive blocks, deep-heavy is expensive there (replays at n-1, 10,000-block logs).
2. **user**: `--users` (25) wallet users for `--user-seconds` (60) looping a 15-step session
   with think time: connect, balances including token balanceOf calls, fee quote and gas
   estimate, confirmation reads, transfer history. Reports per-step latency and the credits a
   session costs, so a plan's quota reads in sessions.
3. **stress**: the user mix sent open-loop at each plan's rps cap (`--plans`, default
   free,builder,growth,scale) for `--stress-seconds` (20) through the one internal key, so the
   question is what the platform sustains at that rate, not what the limiter allows.

Every sample carries its credits (apps/app/src/credits.json, the table the Worker charges) and
the Worker's cache headers. The report ends with the plan economics: requests a quota buys,
hours at the cap to spend it, revenue per 1M requests and per 1M credits. `cost.mjs` adds the
cost side from Cloudflare's metrics for the exact windows, so each plan's margin is measured.

## Execution

Every execution response carries `x-nullrpc-exec: rounds=N keys=K hints=H live=L archive=A`
(apps/rpc README, "Edge caches"); the calls tables show the mean `rounds` and `hints` per case.
A call's cost is its dependent read rounds (one live call and one archive wave each), so the
levers are the hints (witnesses around the block, the callee's profile in the isolate) and the
price of a round; `rounds.mjs` measures the former offline:

```bash
bun run --cwd packages/executor build
node bench/rounds.mjs --chain 560048 --cases bench/results/<stamp>/exec-cases.json --hints
node bench/rounds.mjs --chain 560048 --call '{"method":"eth_call","params":[{"to":"0x…","data":"0x…"},"latest"]}' --hints
```

CPU time is what Workers bill and `wrangler tail` reports per request (`cpuTime`, `wallTime`):

```bash
cd apps/rpc && bunx wrangler tail nullrpc-rpc-560048 --format json --method POST > tail.json &
node bench/scenario.mjs --chain 560048 --phase calls
node bench/cpu.mjs tail.json
```

## Results

`results/` keeps the reports of runs worth remembering, named `{date}-{chain}-{script}[-{mix}]`,
as the script printed them plus the `--json` file. Keyless runs are paced at 8 rps, so their
throughput numbers are the pacing, not the endpoint's limit; their latencies are real.
