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

State reads in the window (`getPinned`, `getPinnedMany`) and witnesses are cached per isolate
under the pinned head's hash (`cachesFor` in `src/live.ts`), and batches of 32 keys or more
(the executor's hints wave) and witnesses are shared per data center through the edge cache
under the same pin hash: a value under one head never changes, so the hints wave of every call
at the head reaches the state shards once per data center per block ([docs/storage.md](../../docs/storage.md),
"Reads above P", "Caches").

## eth_getLogs

The log index (`src/archive/logindex.ts`) narrows an archived range to candidate blocks; every
candidate is read and filtered exactly, and live-window blocks are read directly. A query runs
under fixed limits (`src/methods/logs.ts`): a span of at most 10,000 blocks (`MAX_RANGE`),
at most 1,000 blocks read after narrowing (`MAX_BLOCKS`, candidates and live-window blocks
together), at most 10,000 logs (`MAX_LOGS`) and a budget of 256 archive reads (`READ_BUDGET`:
index records and frames, offsets pages and block runs, each one range read). The budget keeps a
request well inside the Worker's per-request Cache API limit, so a wide query is refused rather
than cut off with an HTTP 503. Live-window blocks are one live call each (no Cache API), 16 in
flight, bounded by `MAX_BLOCKS`.

Reads are planned before they are issued: the index cost follows from the manifest (a small index
object is read whole, two reads whatever the filter; a large one costs two reads per field value
and partition, identical reads shared), candidate blocks are fetched in coalesced range reads of
`receipts.pack` (a layout-2 segment stores receipts apart from the transactions; `blocks.pack`
in older generations; aligned 256 KiB windows, up to 2 MiB per read, so the same region reads
under the same edge-cache key whatever the query), six reads in flight at a time with the next
wave read while one is decoded, and a frame is decoded only as far as its logs need (a receipts
frame carries the block's number, timestamp and transaction hashes, so nothing of the
transactions is read; of a whole record, the header, the receipts, and the hash of a
transaction with a matching log). A query over any limit is
refused with `-32005` and, in the message and `error.data` (`{fromBlock, toBlock}`), the range
starting at its `fromBlock` that would fit; without a fitting range (too many addresses or topics
for the index) the message says to narrow the range or add filters.

## Execution

`eth_call`, `eth_estimateGas`, `eth_createAccessList` and the `debug_`/`trace_` methods run
inside this Worker: `@nullrpc/executor` is bundled with its WebAssembly (about 2.3 MB, built from
`packages/executor/crate` by `bun run build`, which `bun run deploy` and wrangler's build step run
first). A dependency round is a function call plus the state reads over the request's pinned
view: one call to the live window above P and the archive at P, read together (the window's
answer wins where it has a row). The executor's per-isolate caches (bytecode, witnesses, hints
and account and storage values per block hash, the profile of each callee and function), its
25 s budget (a hard stop raced against every wait), its executed-gas budget (the CPU bound)
and 300-round limit live in the package; a round is synchronous, and a round that
took 10 ms or more is followed by a turn of the event loop so the isolate's other requests
proceed.

The module keeps the newest decoded blocks and a state snapshot per block hash (what a call's
first wave handed it), so a call at a block it has seen sends neither the record nor the hints:
a warm token `balanceOf` costs the Worker about 4 ms of CPU instead of 13 (measured with
`bench/profile-worker.mjs` over `wrangler dev --config wrangler.profile.jsonc`).

Most calls never enter a dependent round. Before the first execution, one wave reads the
executor's own hints (sender, callee, the addresses in the calldata), the keys earlier calls to
the same contract and function needed (the shell's profile), and the **witness hints**
(`src/state-source.ts`): the pre-state of block n+1 is the state at the end of n for every key
that block touched, exact as it is; the witnesses of n and n−1 (above P) name what those blocks
touched, with values from before them, and one read of the live window at n says which of those
changed since, and the code of the contracts the hints name (at most 48) is read in the same
wave. A call at n mostly touches what the blocks around n touched. Below P only the exact kind
is used. At most 4096 hinted keys per request. The witness hints are waited for only by a call
whose callee the isolate has no profile for; a call with a profile of 32 keys or fewer (a
`balanceOf`, a transfer estimate) reads its profile's keys with its first round and skips them,
and a larger profile has them join a later round if the call needs one (packages/executor
README, "shell.ts"). Simultaneous calls at one block share one witness read per isolate.

The archive side of a round (`src/archive/state.ts`) resolves the layer descriptors once per
request, reads a layer's Bloom filter whole when it is small (so a key costs one filter read,
the base layer's), keeps decoded index and data pages, filter blocks and whole filters per
isolate, caches the values it answered per (key, block) per isolate (`src/chain.ts`), and
stops a request after 8192 archive reads with `-32005` (its read budget).

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
| `x-nullrpc-exec` | `rounds=N keys=K hints=H live=L archive=A` | Present when the request executed something: read rounds (calls of the executor's state source), the keys they asked for, keys answered ahead of the first round from witnesses, and of all keys read how many the live window answered and how many the state history did (counting the isolate's value cache). |
| `x-nullrpc-response-cache` | `hit immutable`, `hit head`, `miss immutable`, `miss head`, `miss` or `bypass`; for a batch `hit=N miss=M bypass=K immutable=I head=H` | The per-item answer cache (`src/response-cache.ts`), in two tiers, each kept in the isolate (8 MiB, answers up to 128 KiB) and at the edge. **immutable**: a successful result whose every block is at or below the pinned archive tip P, stored for a day under the chain id, method and canonical parameters. **head**: a successful result that depends on blocks above P up to the pinned head, stored for 60 s under the pinned head's number and hash as well: tags resolve to numbers first, so `latest` is a head entry above P and an immutable one at P. The tier after `miss` is where the fresh answer was stored; a bare `miss` was not stored (a `null` answer to a lookup by hash, a block above the head, or a reorg that re-pinned the head during the call). `bypass` is everything else: blocks below the archive's first block, errors, `eth_getLogs` with `blockHash`, `eth_call` with state overrides, and methods outside the table (`eth_chainId`, `eth_sendRawTransaction`, tracing, `debug_codeByHash`, …). |

Cached methods: blocks, transactions, receipts and raw encodings by number; `eth_getBalance`,
`eth_getTransactionCount`, `eth_getCode`, `eth_getStorageAt`; `eth_getLogs` by range;
`eth_blockNumber`, `eth_gasPrice`, `eth_maxPriorityFeePerGas`, `eth_feeHistory` (immutable when
`newestBlock + 1` is at or below P, since the next base fee reads the successor); `eth_call` and
`eth_estimateGas` by call object (keys sorted, hex lowercased) and block. Lookups by hash
(`eth_getBlockByHash`, `eth_getTransactionByHash`, `eth_getTransactionReceipt`,
`eth_getTransactionByBlockHashAndIndex`) ask both tiers before the answer is known and are stored
in the tier the fresh answer's block number selects. A head entry can only ever answer for the
head it was computed under (a hash fixes the whole chain below it), so a new head simply misses;
nothing is invalidated. The archive generation is not part of any key: an answer at or below P
is identical in every later generation, and generations advance on every promotion and
compaction merge. Bump `VERSION` in `src/response-cache.ts` when a method's JSON changes, and in
`src/archive/cached.ts` when the stored byte representation changes.

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
