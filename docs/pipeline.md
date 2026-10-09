# Pipeline

How blockchain data gets from the node into R2 and the Durable Objects. Every step here is also
drawn as a dependency graph in [dags.md](dags.md). The stores themselves are specified in
[storage.md](storage.md).

The pipeline has three phases. The first two run once, and again when the archive format
changes. The third runs for as long as the blockchain is served.

![The three phases](diagrams/phases.svg)

| Phase | Machine | Input | Output |
|---|---|---|---|
| 1. Backfill | hourly backfill machine | the network's archive snapshot | R2 generation 1, genesis to `B` |
| 2. Prune | monthly live machine | the network's pruned snapshot | a live node past `B`, the archive deleted |
| 3. Live | monthly live machine | the live node | the live window in the Durable Objects, `P` advancing |

## Node and sources

| | Source |
|---|---|
| Backfill | the archive snapshot the network publishes for its client, read from the client's files by the dumper for that client's format |
| Live | the same client, pruned, restored from the network's pruned snapshot |

The backfill starts from a published snapshot, so it never re-executes the blockchain's history.
For Ethereum mainnet, the benchmark, the client is Erigon: the dumper reads its snapshot files
(`.seg`, `.ef`, `.v`, `.kv`), and the live node runs with `--prune.mode=full` and its embedded
consensus client.

## Phase 1: Backfill

![Backfill DAG](diagrams/dag-backfill.svg)

1. **Restore the archive snapshot** on the backfill machine. Stream the download straight into
   extraction (`curl | zstd -d | tar -x`), so the disk holds one copy of the snapshot.
2. **Pick `B`**, the node's finalized block. Every later step stops at `B`, and publication
   checks that `B` is still canonical.
3. **Find block boundaries**: for each block, its range of transaction numbers in the client's
   files.
4. Three independent branches run at the same time on the backfill machine. The witness
   branch starts as soon as the block boundaries exist and fills the cores the other two
   leave idle:
   - **Block bundles**: each block's record (block, senders, receipts, blob gas price). Every
     block's receipts must hash to its header's `receiptsRoot`. From the bundles: the **hash
     index** and the **log index**.
   - **State**: every account, storage and code change from the client's history files, sorted
     into **state history** layers. The **root check** builds the state trie at `B` from the
     same data and compares its root with block `B`'s `stateRoot`; the trie is then discarded.
   - **Witnesses**: each block's pre-state, from executing the block in process (see below).
     Before the state history exists, this branch builds every full segment up to the blocks
     the client's state files cover; it finishes the last segment once `B` is known. The
     **witness check** compares one block in 997 with the state history at its parent block:
     two independent extractions of the same state must agree. For segments built before the
     state history existed, the sampled blocks are executed again once it does.
5. **Upload** every object to R2 with multipart uploads. Each object's SHA-256 is checked.
6. **Write the manifest** for generation 1, then **`HEAD.json`** with a create-if-absent write.

The backfill is done when `HEAD.json` names a manifest that ends at `B`. Every stage writes
its output to the work directory and records completion, so a rerun resumes at the first
unfinished stage.

### Witnesses

A witness is the value, before the block, of every account, storage slot and contract code
the block touches, including keys it only reads. The RPC Worker replays any transaction of
the block from it in memory.

The backfill executes every block in process with the client's own EVM, reading the archive
node's database directly and read-only: no RPC, no tracer and no JSON. The block's
transactions read state through the client's history at the start of the block, after its
pre-transaction system calls (on Ethereum: EIP-4788 beacon roots, EIP-2935 block hashes). The
executor records the first read of every account and storage slot. The EVM's in-block cache
answers any later read of the same key, so every recorded value is the key's value at the
start of the block, whether or not a later transaction changes it.

A replay therefore applies the witness and skips the pre-transaction system calls: their
effect is already in it. Post-transaction work (withdrawals, EIP-7002 and EIP-7251 requests)
does not affect any transaction.

**Carried state.** Reads from the history files are the slow part of execution, and
consecutive blocks touch many of the same keys. Each worker therefore executes a run of 4,096
consecutive blocks and carries state from one block to the next: the value after each block
of every key it touched, kept in memory. The next block reads those keys from memory and only
the others from the history. To keep the carried state exact, every block runs the way the
node runs it, with the client's engine: the pre-transaction system calls, the transactions,
and the block's end (rewards, withdrawals, request system calls), with every write applied to
the carried state. Nothing about which keys change outside transactions is assumed. The
witness records only the transactions' reads.

Execution is checked on every block, not sampled:

- The gas used must equal the header's `gasUsed`, and the blob gas used its `blobGasUsed`.
- From Byzantium on, the receipts the execution produced must hash to the header's
  `receiptsRoot`.
- One block in 128 is executed again from the history alone, without carried state, and
  must give the same witness byte for byte.

A block that fails any check stops the run.

Runs are independent, so the witness stage executes many of them in parallel
(`--exec-workers`, one per core by default), 64 blocks per short read transaction. It is the
longest stage of the backfill, and it must finish before the archive is deleted: a pruned
node cannot produce witnesses for old blocks.

## Phase 2: Prune

![Handoff DAG](diagrams/dag-handoff.svg)

1. **Restore the live node** on the live machine from the network's pruned snapshot, in a new
   datadir. The prune mode is set at the first start.
2. **Set the prune distance** before the first start: at least the promotion batch plus the
   finality lag plus a day of margin ([storage.md](storage.md), "Promotion"). This margin is
   how long the daemon can be down without losing blocks.
3. **Wait until the live node is past `B+1`.**
4. **Check the state root at `B`**: the live node's header `B` must match the archive's.
5. **Start the daemon at `B+1`.** It writes the live window from `B+1` and starts promoting.
6. **When the daemon reaches the head, delete the archive** and release the backfill machine.

The live node must still hold block `B+1` and the state at `B` when the daemon starts. Start
the daemon before the node's prune window passes `B`.

## Phase 3: Live

The daemon runs the block DAG for every new block, the promotion DAG when enough
blocks are final, and the reorg DAG when the blockchain reorganizes.

![Per-block DAG](diagrams/dag-block.svg)

### Extract

The daemon pulls from the node over local RPC:

| Data | Call |
|---|---|
| New heads | `eth_subscribe("newHeads")`, polling `eth_blockNumber` as a fallback |
| Block | `eth_getBlockByNumber(n, true)`, `debug_getRawBlock(n)` |
| Receipts | `eth_getBlockReceipts(n)` |
| Pre-state (witness) | `debug_traceBlockByNumber(n, {tracer: "prestateTracer"})` |
| Transactions' state changes | `debug_traceBlockByNumber(n, {tracer: "prestateTracer", tracerConfig: {diffMode: true}})` |
| Changes outside transactions | withdrawal recipients: `eth_getBalance`, `eth_getTransactionCount`, `eth_getCode` at `n`; system contract slots (EIP-4788 ring slots of the block's timestamp, EIP-2935 slot `(n−1) mod 8191`, EIP-7002 and EIP-7251 slots 0–3): `eth_getStorageAt` at `n` |
| Every account the block modified | `debug_getModifiedAccountsByNumber(n)`: any account the diff lacks is read at `n` |
| Finality | `eth_getBlockByNumber("finalized")`, `eth_getBlockByNumber("safe")` |

While catching up, `--window` blocks (default 16) are extracted in parallel and committed in
order. The tracer re-executes the block on the node, on the parent's state, which the node keeps
only within its prune distance. That distance is the furthest the daemon can fall behind.

The diff is each changed key's value after the block. Selfdestruct removes only an account
created in the same transaction (EIP-6780), so a removed account's storage is exactly the slots
the diff holds. An account that existed before the block can still be removed if it had no
nonce and no code: a contract created at its address and selfdestructed in the same transaction
(the address may hold a balance sent ahead of the deployment), or an empty account a transaction
touched (EIP-161). The daemon accepts such a removal once `debug_storageRangeAt` shows the
account held no storage at the start of the block. Any other removal of an account that existed
before the block stops the daemon.

### Verify

Before anything is written, the daemon checks:

- the header hashes to the block hash, and its parent hash is the spooled head;
- the transactions hash to `transactionsRoot`;
- the receipts hash to `receiptsRoot`;
- the diff holds every account the node reports as modified by the block.

A failed step is retried with backoff (RPC and R2 errors pass); after 10 consecutive failures, or
on a reorg below `F`, the daemon stops. It never writes a block it could not verify.

### Spool

![Spool file states](diagrams/spool.svg)

| Directory | Meaning | Next step |
|---|---|---|
| `tmp/` | being written | fsync, rename to `ready/` |
| `ready/` | durable, not yet in the Durable Objects | write shards and `ChainDO`, move the head |
| `live/` | visible in the live window | promotion |
| `acked/` | in an R2 generation that `HEAD.json` names | delete after 7 days |
| `orphaned/` | removed by a reorg | delete after 7 days |

One file per block, named `{number:020}-{hash}`. The rename is atomic, so a file in `ready/`
is always complete. On start the daemon replays `ready/` and checks that every file in
`live/` is in the Durable Objects. Every write to the Durable Objects and R2 is idempotent,
so a replay is safe.

### Write the live window

1. Write the diff to the `StateShard`s: one `applyMany` call per touched shard, all in
   parallel.
2. Write the block record and witness to `ChainDO`.
3. Move the head in `ChainDO`.

The head moves only after every row is written, so a reader never sees a block without its
state. On a blockchain with blocks faster than 2 seconds, the daemon writes groups of blocks
and the head moves per group ([storage.md](storage.md), "Parameters").

### Promote

![Promotion DAG](diagrams/dag-promotion.svg)

When `F` reaches `P` plus the batch size, or the oldest unpromoted finalized block is
2 hours old, the daemon promotes blocks `P+1` to `P′` (at most `F`):

1. Read the blocks from `live/` in the spool and check every parent link. The Durable
   Objects are not read back.
2. Build: one segment and one witness range per chunk the blocks touch, a hash index object,
   a log index object, and a level-0 state history layer from the blocks' diffs.
3. Upload the objects, write manifest N, and move `HEAD.json` with `If-Match` on generation
   N−1's ETag. A conflict means something else wrote `HEAD.json`: the daemon never overwrites.
4. Prune the shards and `ChainDO` at or below `P′`, and set `P = P′`.
5. Move the spool files to `acked/`.

Between promotions the daemon compacts, one merge per generation (docs/storage.md,
"Promotion"): state layers, hash index and log index objects into higher levels, and a complete
chunk's segments and witness ranges into one. Objects a generation no longer names are deleted 7
days later.

If promotion falls behind, the live window grows and keeps serving. Two limits apply: the
node's prune distance (the spool must hold every unpromoted block, and a lost spool can only
be rebuilt from the node) and the Durable Objects' storage.

### Reorgs

![Reorg DAG](diagrams/dag-reorg.svg)

When a new block's parent is not the spooled head, the daemon walks back on the node to the
common ancestor `A`, fences the removed blocks in every shard, lowers the head to `A`,
truncates the shards and `ChainDO` above `A`, moves the removed blocks to `orphaned/`, and
applies the new branch block by block. Readers never see a mix of branches
([storage.md](storage.md), "Reorgs").

An ancestor below `F` means finality was violated or the node is on a wrong fork. The daemon
stops and alerts.

## Guarantees

- R2 objects are never modified. A new generation adds objects and moves `HEAD.json`.
- `HEAD.json` moves last, and only forward.
- Every block from genesis to head is in R2 or the live window, never in neither. During
  promotion it is briefly in both, and readers may use either.
- The backfill and the daemon encode blocks, state and witnesses with the same code, so
  block `B` and block `B+1` have the same format.
- The node never waits for the daemon, R2 or the Durable Objects.
- Only the daemon writes to R2 and the Durable Objects.
