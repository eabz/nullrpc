# nullrpc-backfill

Builds the nullrpc archive (generation 1, genesis to the node's finalized block `B`) from an
Erigon v3 archive node and uploads it to R2. It implements Phase 1 of
[docs/pipeline.md](../../docs/pipeline.md); the format is [docs/storage.md](../../docs/storage.md);
the steps are the backfill DAG in [docs/dags.md](../../docs/dags.md).

Run it on the backfill machine ([docs/infrastructure.md](../../docs/infrastructure.md)), next
to the Erigon archive node: it reads Erigon's snapshot files directly and calls the node's
JSON-RPC on localhost.

## Requirements

- An Erigon v3.7 archive node (`--prune.mode=archive`) on the same machine, synced past the
  block to archive, with JSON-RPC on localhost and the `debug` namespace enabled
  (`--http.api=eth,debug,net,web3`).
- Go 1.26 or newer, with cgo (the block source reads Erigon's database).
- Disk: the archive snapshot plus about 1.5 TB of working files on Ethereum mainnet, less with
  `--stream`.
- R2 credentials.

## Build

```bash
cd services/backfill && go build -trimpath -o nullrpc-backfill .
```

## Credentials

Put them in `backfill.env` in the work directory, one `KEY=VALUE` per line, readable only by
you (`chmod 600`):

| Variable | What |
|---|---|
| `NULLRPC_R2_ENDPOINT` | `https://ACCOUNT_ID.r2.cloudflarestorage.com` |
| `NULLRPC_R2_BUCKET` | the archive bucket |
| `NULLRPC_R2_ACCESS_KEY_ID`, `NULLRPC_R2_SECRET_ACCESS_KEY` | an R2 API token with Object Read & Write on that bucket |

## Run

```bash
mkdir -p /mnt/nullrpc/work && cd /mnt/nullrpc/work
```

```bash
/path/to/nullrpc-backfill --datadir /mnt/erigon --pre-byzantium-receipts=status --stream
```

The run is resumable: every stage writes its output to the work directory, and a rerun starts
at the first unfinished stage. Check progress from another shell:

```bash
/path/to/nullrpc-backfill status
```

| Flag | Default | Use |
|---|---|---|
| `--datadir` | from the running `erigon` process | Erigon's datadir |
| `--rpc` | `http://127.0.0.1:8545` | the archive node's JSON-RPC |
| `--stream` | off | upload the state layer, each segment and each witness range as soon as they are written, and remove the local copies. Needed when the disk cannot hold the whole archive. Sticky per work directory. |
| `--concurrency` | 48 | parallel RPC calls, mainly witness tracing |
| `--pre-byzantium-receipts` | `fail` | `status` for Ethereum mainnet: Erigon keeps no post-state roots for receipts before Byzantium |
| `--tmp` | `WORK/trie.tmp` | sort runs of the root check, e.g. on another disk |
| `--upload` | on | `--upload=false` builds locally only |
| `--genesis` | bundled for Ethereum mainnet and Hoodi | the chain's full genesis JSON for any other chain |

## Stages

| # | Stage | Output in the work directory |
|---|---|---|
| 1 | block boundaries | `blocks.bin` |
| 2 | state dump | `changes/` (removed in streaming mode after the state check) |
| 3 | state history | the state layer, `state-layer.json` |
| – | state check (streaming) | `state-verify.json`: sampled values match the node |
| 4 | root check | `root-check.json`: the state root at `B` matches its header |
| – | state upload (streaming) | `state-upload.done` |
| 5 | block bundles | segments, `bundles.json`, hash entries in `hashes/` |
| 6 | witnesses | witness ranges, `witnesses.json` (one block in 997 cross-checked against state history) |
| 7 | hash index | `hash-index.json` |
| 8 | log index | `log-index.json` |
| 9 | publish | `archive/{chain-id}-{genesis-hash}/HEAD.json` and the manifest |
| 10 | upload | `upload.done`; HEAD.json is written to R2 last, with `If-None-Match: *` |

Other commands: `verify` and `state-verify` check sampled state values against the node.

## Tests

```bash
go test ./...
```
