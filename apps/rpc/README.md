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
