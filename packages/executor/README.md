# @nullrpc/executor

EVM execution and tracing for the RPC Workers: `eth_call`, `eth_estimateGas`,
`eth_createAccessList`, `debug_traceCall`, `debug_traceTransaction`, `debug_traceBlockByNumber`,
`debug_traceBlockByHash`, `trace_transaction`, `trace_block`, `trace_call`,
`trace_replayTransaction`, `trace_replayBlockTransactions`. A workspace package: the RPC Worker
(`apps/rpc`) bundles it and runs execution in-process; the executor Worker (`apps/executor`)
bundles the same code behind a service binding, for anything that still wants execution in a
Worker of its own. `src/contract.ts` is the contract (`StateSource`, `ExecRequest`,
`ExecResponse`).

- `crate/`: Rust, compiled to `wasm32-unknown-unknown` with wasm-bindgen. Pure compute (no I/O,
  no async): revm 43, alloy-evm 0.39, revm-inspectors 0.44, with the call, access-list and
  tracing logic ported from exe (`exe-execution`, `exe-trace`). A `Session` runs a request as far
  as the values it knows allow and answers `{"done":true,"response":…}`, `{"witness":n,"hash":…}`
  or `{"missing":[StateKey…],"at":n}`. Block replays keep a checkpoint between rounds, so a
  round never re-executes transactions that already ran on read values.
- `src/shell.ts`: the round loop. Reads the missing keys from the caller's `StateSource`
  (batches of at most 256, code fetched with its account), the witness for mined-transaction
  traces, and caches per isolate (bounded LRUs): bytecode by hash, witnesses and hints by block
  hash, account and storage values by (chain, block hash, block, key), and a profile per (chain,
  callee, selector): the keys the dependent rounds of calls to that function asked for (the
  first round's keys are the module's own, asked by every call), learnt from any call that read;
  a call that needed no dependent round leaves an empty profile, which still says it is cheap.
  For a call-style request the first wave reads, together, the executor's first round (its own
  hints: sender, callee, calldata addresses, coinbase), the profile's keys the round did not
  ask for, and, when the isolate has no profile for the callee, the source's optional
  `hints(at)` (apps/rpc: the witnesses around the block, about a thousand keys at a busy head),
  which the first round waits for; simultaneous requests at one block share one such read. A
  call whose profile holds 32 keys or fewer is cheap and does without the source's hints: its
  profile is its targeted hints. A larger profile has them read but not waited for: they join
  the first round they have arrived for, less the keys earlier rounds answered, and that round
  carries the snapshot mark. A round is synchronous; a round the isolate's caches answered
  (no read awaited) is followed by a turn of the event loop, so a request with warm caches and
  many rounds does not hold the isolate's other requests between rounds (a Worker's clock does
  not move during synchronous code, so the turn cannot be decided by timing the round). A
  single round is still uninterruptible: the executed-gas budget bounds it. A source may refuse a
  request with an error carrying `rpcCode` (apps/rpc's read budget): that becomes the answer.
- `src/index.ts`: `execute(request, state)` for Workers code. Imports the WebAssembly through
  wrangler's `CompiledWasm` rule (`crate/pkg/executor_bg.wasm`) and instantiates it on the first
  request; one instance per isolate serves every request. A trap (Rust panic) drops the instance
  once no request is using it.
- The module keeps, by block hash, the newest decoded block records and a state snapshot per
  block (`crate/src/cache.rs`): what a call's first wave handed it (hints, profile, its own
  first keys, with their bytecode analysed). The shell asks `has_block`/`has_known` and sends
  a request at a block the module has seen with `blockHash` instead of the record and `seed`
  instead of hints, so repeated calls at a head cost the module a few hundred microseconds of
  setup instead of a 600 KB JSON of state (the fixed cost that made a `balanceOf` 12 ms of CPU).

State: calls run on the end state of `request.block` with its header as the EVM context.
Mined-transaction traces replay the block on its pre-state: the witness first, reads at block
`n − 1` for anything else. Every fork revm supports executes (Frontier through BPO2, with the DAO
fork's state change and pre-Merge block/uncle rewards in `trace_block`); forks after BPO2 fail
with -32000 for blocks where they are active.

Limits: calls ≤ 1024 state reads, 5M gas by default (capped at 5M and the block gas limit;
`eth_estimateGas` searches up to the EIP-7825 cap); traces ≤ 4096 reads and ≤ 256 rounds, 250M
replayed gas, struct logs ≤ 50k entries / 8 MiB; `debug_traceCall`/`trace_call` default to geth's
50M gas cap; 500M gas executed per request including exploring and discarded runs (the CPU
budget: a Worker's clock does not advance during synchronous code, and about 300M gas run per
CPU second under a tracer); 25 s per request (`TIMEOUT_MS`), a hard stop: every wait of the
round loop (a state wave, a witness, a turn of the event loop) races the budget's timer, so a
stalled read answers `-32005` when the budget ends, not when the read does; 300 rounds
(`MAX_ROUNDS`).

## Commands

```sh
cargo install wasm-bindgen-cli --version 0.2.129 --locked   # once; wasm-opt (binaryen) optional
bun run build        # scripts/build.sh: cargo → wasm-bindgen → wasm-opt -O3 into crate/pkg (ignored); built for speed, about 2.3 MB
bun run test         # build, Rust unit tests, vitest end-to-end against Hoodi/mainnet fixtures
bun run typecheck
bun run fixtures     # refetch test/fixtures from hoodi.drpc.org / eth.drpc.org (needs a build)
node test/fixtures/fetch.mjs --fill   # after a change to what the executor reads: record the new reads, keep the cases
```

`crate/pkg` is git-ignored: every Worker that bundles this package builds it first (the deploy
scripts of `apps/rpc` and `apps/executor` run `bun run build` here). Under Node (vitest), the
`.wasm` import resolves to `test/wasm-node.ts` (the `executorWasmNode` vitest plugin in
`test/vitest-wasm.ts`), which reads the module from `crate/pkg`.

The end-to-end fixtures (`test/fixtures/*.json.zst`) hold a block record, a witness synthesized
from geth's `prestateTracer`, the state the executor read beyond it, and the reference node's
answers. drpc spreads requests over backends of different clients and versions, so each answer
is fetched five times and the test accepts any one of them exactly; drpc refuses the default
struct logger, so those references come from a public Nethermind node (its empty `memory: []`
entries are dropped before comparing).
