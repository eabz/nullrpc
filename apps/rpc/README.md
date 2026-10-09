# nullrpc RPC Worker

One chain's public JSON-RPC endpoint (`nullrpc-rpc-{chain-id}`), in TypeScript. It answers from
the R2 archive (genesis to P) and the live window (P+1 to head, `apps/live`), never from a node.
[docs/storage.md](../../docs/storage.md) is the data contract with the Go daemon that writes both.

| Area | Source |
|---|---|
| Blocks, transactions, receipts, raw encodings | `src/eth`, `src/archive/archive.ts`, `src/archive/hashindex.ts` |
| Account and storage state | `src/archive/state.ts` (layers, Bloom filters), live state shards |
| `eth_getLogs` | `src/archive/logindex.ts`, `src/methods/logs.ts` |
| Fees (`eth_feeHistory`, `eth_gasPrice`, …) | `src/methods/fees.ts` |
| Execution and tracing | `src/methods/exec.ts` runs `@nullrpc/executor` (`packages/executor`, revm in WebAssembly) in-process, reading state through `src/state-source.ts` |
| `eth_sendRawTransaction` | `src/methods/relay.ts` (`RELAY_URL`) |
| Keys, credits, rate limits | `src/access` with the account app's `Access` entrypoint and `RateBudget` |
| Endpoint page and `/status.json` | `src/page`, `public/_page` |

Every request pins one archive generation (`HEAD.json`, cached 10 s per isolate) and one live
head; reorgs (stale pins) and promotions (blocks leaving the live window) are retried
transparently (`src/chain.ts`).

## Execution

`eth_call`, `eth_estimateGas`, `eth_createAccessList` and the `debug_`/`trace_` methods run
inside this Worker: `@nullrpc/executor` is bundled with its WebAssembly (about 2.3 MB, built from
`packages/executor/crate` by `bun run build`, which `bun run deploy` and wrangler's build step run
first). A dependency round is a function call plus the state reads over the request's pinned
view: one call to the live window above P and the archive at P in parallel. The executor's
per-isolate caches (bytecode, witnesses, account and storage values per block hash), its 25 s
budget and 300-round limit live in the package; a round is synchronous, and a round that took
10 ms or more is followed by a turn of the event loop so the isolate's other requests proceed.

The `EXECUTOR` service binding is optional and unset in `wrangler.jsonc`: bound to
`nullrpc-executor` (`apps/executor`, entrypoint `Executor`), execution runs in that Worker over
Workers RPC instead, as it did before the package. Nothing else uses that Worker.

## Develop

```sh
bun run build        # packages/executor's WebAssembly (needs cargo, wasm-bindgen-cli 0.2.129; see its README)
bun run test         # vitest: real mainnet blocks, generated archives, access, live, fees, execution in-process (needs the build)
bun run typecheck
bunx wrangler deploy --dry-run --env 560048
```

`test/fixtures/fetch.mjs` refreshes the mainnet block fixtures from a public archive node.
`test/archive.ts` writes complete archive generations (segments, hash and log indexes, state
layers) from them; it stands in for the Go daemon's writer until that writer publishes golden
fixtures.

## Deploy (per chain)

```sh
bunx wrangler secret put KEY_SECRET --env 560048   # same value as nullrpc-app's KEY_SECRET
bun run deploy --env 560048                        # builds the executor's WebAssembly, then wrangler deploy
```

Needs `nullrpc-live-560048` and `nullrpc-app` deployed (and `nullrpc-executor` only when
`EXECUTOR` is bound), and the chain's archive published under `ARCHIVE_PREFIX` in the `nullrpc`
bucket. Hoodi relays transactions to a
public node (no private relay serves Hoodi); mainnet uses Flashbots Protect.
