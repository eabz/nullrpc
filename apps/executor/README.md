# nullrpc-executor

EVM execution and tracing for the RPC Workers: `eth_call`, `eth_estimateGas`,
`eth_createAccessList`, `debug_traceCall`, `debug_traceTransaction`, `debug_traceBlockByNumber`,
`debug_traceBlockByHash`, `trace_transaction`, `trace_block`, `trace_call`,
`trace_replayTransaction`, `trace_replayBlockTransactions`. Reached only through a service
binding to the `Executor` entrypoint (no routes, no workers.dev); the contract is
`apps/rpc/src/executor.ts` (copied to `src/contract.ts`).

- `crate/`: Rust, compiled to `wasm32-unknown-unknown` with wasm-bindgen. Pure compute (no I/O,
  no async): revm 43, alloy-evm 0.39, revm-inspectors 0.44, with the call, access-list and
  tracing logic ported from exe (`exe-execution`, `exe-trace`). A `Session` runs a request as far
  as the values it knows allow and answers `{"done":true,"response":…}`, `{"witness":n,"hash":…}`
  or `{"missing":[StateKey…],"at":n}`. Block replays keep a checkpoint between rounds, so a
  round never re-executes transactions that already ran on read values.
- `src/shell.ts`: the round loop. Reads the missing keys from the RPC Worker's `StateSource`
  (batches of at most 256, code fetched with its account), the witness for mined-transaction
  traces, and caches bytecode by hash and witnesses by block hash per isolate (bounded LRU).
- `src/index.ts`: the Worker. The WebAssembly is instantiated on the first request.

State: calls run on the end state of `request.block` with its header as the EVM context.
Mined-transaction traces replay the block on its pre-state: the witness first, reads at block
`n − 1` for anything else. Every fork revm supports executes (Frontier through BPO2, with the DAO
fork's state change and pre-Merge block/uncle rewards in `trace_block`); forks after BPO2 fail
with -32000 for blocks where they are active.

Limits: calls ≤ 1024 state reads, 5M gas by default (capped at 5M and the block gas limit;
`eth_estimateGas` searches up to the EIP-7825 cap); traces ≤ 4096 reads and ≤ 256 rounds, 250M
replayed gas, struct logs ≤ 50k entries / 8 MiB; `debug_traceCall`/`trace_call` default to geth's
50M gas cap; 25 s per request.

## Commands

```sh
cargo install wasm-bindgen-cli --version 0.2.129 --locked   # once; wasm-opt (binaryen) optional
bun run build        # scripts/build.sh: cargo → wasm-bindgen → wasm-opt into crate/pkg (ignored)
bun run test         # build, Rust unit tests, vitest end-to-end against Hoodi/mainnet fixtures
bun run typecheck
bun run fixtures     # refetch test/fixtures from hoodi.drpc.org / eth.drpc.org (needs a build)
npx wrangler deploy --dry-run
```

The end-to-end fixtures (`test/fixtures/*.json.zst`) hold a block record, a witness synthesized
from geth's `prestateTracer`, the state the executor read beyond it, and the reference node's
answers. drpc spreads requests over backends of different clients and versions, so each answer
is fetched five times and the test accepts any one of them exactly; drpc refuses the default
struct logger, so those references come from a public Nethermind node (its empty `memory: []`
entries are dropped before comparing).
