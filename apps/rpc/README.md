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
| Execution and tracing | the executor Worker (`apps/executor`) via `src/methods/exec.ts`, reading state through `src/state-source.ts` |
| `eth_sendRawTransaction` | `src/methods/relay.ts` (`RELAY_URL`) |
| Keys, credits, rate limits | `src/access` with the account app's `Access` entrypoint and `RateBudget` |
| Endpoint page and `/status.json` | `src/page`, `public/_page` |

Every request pins one archive generation (`HEAD.json`, cached 10 s per isolate) and one live
head; reorgs (stale pins) and promotions (blocks leaving the live window) are retried
transparently (`src/chain.ts`).

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
bun run test         # vitest: real mainnet blocks, generated archives, access, live, fees
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
bunx wrangler deploy --env 560048
```

Needs `nullrpc-live-560048`, `nullrpc-app` and `nullrpc-executor` deployed, and the chain's
archive published under `ARCHIVE_PREFIX` in the `nullrpc` bucket. Hoodi relays transactions to a
public node (no private relay serves Hoodi); mainnet uses Flashbots Protect.
