# nullrpc services

Two programs, one Go module. Both write the archive through the same code in
`internal/core`, so blocks from the backfill and blocks from the daemon have the same format.

| Command | Phase ([docs/pipeline.md](../docs/pipeline.md)) | Runs on |
|---|---|---|
| `backfill` | 1. Backfill: an Erigon archive node to R2, genesis to `B` | the backfill machine |
| `daemon` | 3. Live: a pruned node to the live window and R2, forever | the live machine |

The daemon writes the live window to the chain's `nullrpc-live-{chain-id}` Worker (`apps/live`), which holds the
`ChainDO` and `StateShard` Durable Objects.

```bash
go test ./...
```

## backfill

Builds the nullrpc archive (generation 1, genesis to the node's finalized block `B`) from an
Erigon v3 archive node and uploads it to R2. Its steps are the backfill DAG in
[docs/dags.md](../docs/dags.md). It reads Erigon's snapshot files directly and calls the node's
JSON-RPC on localhost.

### Requirements

- An Erigon v3.7 archive node (`--prune.mode=archive`) on the same machine, synced past the
  block to archive, with JSON-RPC on localhost and the `debug` namespace enabled
  (`--http.api=eth,debug,net,web3`).
- Go 1.26 or newer, with cgo (the block source reads Erigon's database).
- Disk: the archive snapshot plus about 1.5 TB of working files on Ethereum mainnet, less with
  `--stream`.
- R2 credentials.

### Build

```bash
cd services && go build -trimpath -o bin/ ./cmd/backfill
```

### Credentials

Put them in `backfill.env` in the work directory, one `KEY=VALUE` per line, readable only by
you (`chmod 600`):

| Variable | What |
|---|---|
| `NULLRPC_R2_ENDPOINT` | `https://ACCOUNT_ID.r2.cloudflarestorage.com` |
| `NULLRPC_R2_BUCKET` | the archive bucket |
| `NULLRPC_R2_ACCESS_KEY_ID`, `NULLRPC_R2_SECRET_ACCESS_KEY` | an R2 API token with Object Read & Write on that bucket |

### Run

```bash
mkdir -p /mnt/nullrpc/work && cd /mnt/nullrpc/work
```

```bash
bin/backfill --datadir /mnt/erigon --pre-byzantium-receipts=status --stream
```

The run is resumable: every stage writes its output to the work directory, and a rerun starts
at the first unfinished stage. Check progress from another shell:

```bash
bin/backfill status
```

| Flag | Default | Use |
|---|---|---|
| `--datadir` | from the running `erigon` process | Erigon's datadir |
| `--rpc` | `http://127.0.0.1:8545` | the archive node's JSON-RPC |
| `--stream` | off | upload the state layer, each segment and each witness range as soon as they are written, and remove the local copies. Needed when the disk cannot hold the whole archive. Sticky per work directory. |
| `--exec-workers` | one per core | blocks executed in parallel by the witness stage |
| `--concurrency` | 48 | parallel RPC calls (`--block-source rpc` and its fallbacks) |
| `--pre-byzantium-receipts` | `fail` | `status` for Ethereum mainnet: Erigon keeps no post-state roots for receipts before Byzantium |
| `--tmp` | `WORK/trie.tmp` | sort runs of the root check, e.g. on another disk |
| `--upload` | on | `--upload=false` builds locally only |
| `--genesis` | bundled for Ethereum mainnet and Hoodi | the chain's full genesis JSON for any other chain |

### Stages

| # | Stage | Output in the work directory |
|---|---|---|
| 1 | block boundaries | `blocks.bin` |
| 2 | state dump | `changes/` (removed in streaming mode after the state check) |
| 3 | state history | the state layer, `state-layer.json` |
| – | state check (streaming) | `state-verify.json`: sampled values match the node |
| 4 | root check | `root-check.json`: the state root at `B` matches its header |
| – | state upload (streaming) | `state-upload.done` |
| 5 | block bundles | segments, `bundles.json`, hash entries in `hashes/` |
| 6 | witnesses | witness ranges, `witnesses.json`: every block executed in process, gas and receipts root checked against its header, one block in 997 cross-checked against state history |
| 7 | hash index | `hash-index.json` |
| 8 | log index | `log-index.json` |
| 9 | publish | `archive/{chain-id}-{genesis-hash}/HEAD.json` and the manifest |
| 10 | upload | `upload.done`; HEAD.json is written to R2 last, with `If-None-Match: *` |

Other commands: `verify` and `state-verify` check sampled state values against the node.
`witness-test` executes a block range like the witness stage and prints its speed, writing
nothing:

```bash
bin/backfill witness-test --from 1000000 --to 1010000
```

## daemon

Follows a pruned node and keeps the live window and R2 current: the block, promotion, reorg and
restart DAGs in [docs/dags.md](../docs/dags.md). Start it after the backfill's `HEAD.json` is in
R2, while the node still holds block `B+1` and the state at `B`.

### Requirements

- The chain's client, pruned, synced, on the same machine, with JSON-RPC (HTTP and WebSocket) on
  localhost and the `debug` namespace enabled. Its prune distance must cover at least one
  promotion batch plus the finality lag plus a day ([docs/storage.md](../docs/storage.md),
  "Parameters").
- The chain's `nullrpc-live-{chain-id}` deployed, with its `INGEST_TOKEN` secret set.
- R2 credentials for the archive bucket.

### Build

```bash
cd services && go build -trimpath -o bin/ ./cmd/daemon
```

### Credentials

`daemon.env` in the spool directory, `chmod 600`:

| Variable | What |
|---|---|
| `NULLRPC_R2_ENDPOINT`, `NULLRPC_R2_BUCKET`, `NULLRPC_R2_ACCESS_KEY_ID`, `NULLRPC_R2_SECRET_ACCESS_KEY` | the archive bucket, as for the backfill |
| `NULLRPC_INGEST_TOKEN` | the value of `nullrpc-live-{chain-id}`'s `INGEST_TOKEN` secret |

### Run

```bash
daemon --spool /mnt/nullrpc/spool
```

| Flag | Default | Use |
|---|---|---|
| `--spool` | `nullrpc-spool` (env `NULLRPC_SPOOL`) | spool directory; keep it on mirrored disks |
| `--rpc` | `http://127.0.0.1:8545` (env `NULLRPC_RPC_URL`) | the node's JSON-RPC |
| `--ws` | `--rpc` with `ws://` (env `NULLRPC_WS_URL`) | the node's WebSocket, for `newHeads`; polling covers its absence |
| `--live` | `https://live-{chain-id}.nullrpc.dev` (env `NULLRPC_LIVE_URL`) | the chain's live Worker; the daemon refuses one that serves another chain |
| `--batch` | 256 | blocks per promotion |
| `--max-age` | 2h | promote a smaller batch once the oldest unpromoted finalized block is this old |
| `--max-batches` | 8 | batches promoted at most at once |
| `--group` | 1 | blocks per live window row; divides `--batch` |
| `--window` | 16 | blocks extracted in parallel while catching up |
| `--genesis` | bundled for Ethereum mainnet and Hoodi | the chain's genesis JSON for any other chain |

The spool holds every block until it is in R2, so the daemon resumes after a crash or a restart
from where it stopped. It logs one JSON line per promotion, merge, reorg and retry.

### What it does

1. **Restart.** Reads `HEAD.json` (`P`) and the live window's state; on the first start it
   records `P` in `ChainDO`. It finishes a promotion that stopped after `HEAD.json` moved,
   lowers the live window's head to the last block it shares with the spool, and writes the
   spooled blocks the window lacks.
2. **Blocks.** For each new head: the block, its receipts, its witness and its state diff from
   the node, checked, spooled, then written to the shards, `ChainDO` and the head, in groups of
   `--group` blocks.
3. **Reorgs.** When a block's parent is not the spooled head: walk back to the common ancestor,
   fence, lower the head, truncate, and continue on the new branch. An ancestor below the
   finalized block stops the daemon.
4. **Promotion.** When a batch is finalized: segments, witness ranges, hash and log index objects
   and a level-0 state layer to R2, a new manifest, `HEAD.json` with `If-Match`, then the live
   window is pruned.
5. **Compaction.** Between promotions, one merge per generation: state layers and index objects
   into higher levels, a complete chunk's segments and witness ranges into one. Replaced objects
   are deleted 7 days later.

## nullrpc-live-{chain-id}

One Worker per chain, one Wrangler environment per chain in `apps/live/wrangler.jsonc`:

| Chain | Environment | Worker | Ingest hostname | Shards |
|---|---|---|---|---|
| Hoodi | `560048` | `nullrpc-live-560048` | `live-560048.nullrpc.dev` | 4 |
| Ethereum mainnet | `1` | `nullrpc-live-1` | `live-1.nullrpc.dev` | 16 |

```bash
cd apps/live && bunx wrangler deploy --env 560048
```

```bash
cd apps/live && bunx wrangler secret put INGEST_TOKEN --env 560048
```

The chain's RPC Worker is `nullrpc-rpc-{chain-id}` (Hoodi: `nullrpc-rpc-560048`, serving
`hoodi.nullrpc.dev`). It reads the live window through a service binding to the `LiveReads`
entrypoint of `nullrpc-live-{chain-id}`.
