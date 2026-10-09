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

The live head, safe, finalized and promoted pointers come from `live/HEAD.json` in the archive
bucket, which the daemon rewrites after every head move (`src/live.ts`; the contract is in
[docs/storage.md](../../docs/storage.md), "Live pointers"). The Worker keeps that object for 2 s
per isolate and for 2 s in the data center's edge cache, so a request may see the head up to
about 2 s late (plus the time the daemon takes to write it): `eth_blockNumber` can trail the live
Worker by one block for that long, and a block the daemon has just written is served once the
pointers catch up. The `LiveReads.state()` service binding (one Durable Object call) is used only
when the object is missing, malformed or older than a minute, so a daemon that does not write it
keeps working. Reorg safety is unchanged: the head a request pins is one the live Worker had
already stored when the daemon wrote the object, every live read still carries that pin and
answers `stale` if a reorg removed it, and the retry re-reads the pointers through the service
binding, never from the cached object, so a request never mixes two branches.

Block records above P come from the same bucket: the daemon writes `live/records/{number}-{hash}.bin`
for every block it writes to the live window, `live/HEAD.json` lists the window's hashes by number
and names a transaction index object, and `src/live.ts` reads both through the archive's edge
cache (immutable, a day) with the pinned head's document, verifying each record's hash. The
`LiveReads.block` and `txBlock` service calls remain the fallback for a head taken from `state()`
after a reorg, a block the document does not list, or a missing object ([docs/storage.md](../../docs/storage.md),
"Live records").

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

## Edge caches

Two caches in the data center's Cache API (`caches.default`) sit between a request and R2. Both
need a custom domain (the Cache API is inert on `workers.dev`) and both are filled after the
response is sent (`ctx.waitUntil`), so a miss never waits for the fill. Every JSON-RPC response
reports them in two headers (exposed to browsers through `access-control-expose-headers`):

| Header | Values | Meaning |
|---|---|---|
| `x-nullrpc-archive-cache` | `hit=N miss=M` | Archive object reads this request sent to the edge cache (`src/archive/cached.ts`). Every archive object except `HEAD.json` is immutable and content-addressed, so each range read (`key`, `offset`, `length`) and whole-object read is stored for a day under a synthetic URL `/_cache/archive/v1/<key>?o=<offset>&l=<length>`. `HEAD.json` always goes to R2 and is not counted. Reads answered by the isolate's own memory (parsed manifests, offsets pages) never reach this cache and are not counted either. |
| `x-nullrpc-response-cache` | `hit`, `miss` or `bypass`; for a batch `hit=N miss=M bypass=K` | The per-item answer cache (`src/response-cache.ts`). A successful result of a block, transaction, receipt, raw-encoding, log or state method is stored for a day when every block it depends on is at or below the pinned archive tip P, keyed by chain id, method and the canonical parameters. `bypass` is everything else: tags (`latest`, `pending`, `safe`, `finalized`), blocks above P or below the archive's first block, errors, `null` answers to lookups by hash, `eth_getLogs` with `blockHash`, and methods that read the head or execute (`eth_call`, `eth_feeHistory`, fees, …). |

Lookups by hash (`eth_getBlockByHash`, `eth_getTransactionByHash`, `eth_getTransactionReceipt`,
`eth_getTransactionByBlockHashAndIndex`) are looked up before the answer is known and stored
only when the fresh answer places itself at or below P. The archive generation is not part of
the response key: an answer at or below P is identical in every later generation, and
generations advance on every promotion and compaction merge. Bump `VERSION` in
`src/response-cache.ts` when a method's JSON changes, and in `src/archive/cached.ts` when the
stored byte representation changes.

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
