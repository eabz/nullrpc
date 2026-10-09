# Storage

The specification of everything nullrpc stores: the R2 archive and the two Durable Object
classes. Writers (the backfill dumper and the daemon) and the reader (the RPC Worker) both
implement this document.

| Store | Holds | Written by | Read by |
|---|---|---|---|
| R2 | genesis to `P`: immutable generations | backfill once, then the daemon's promotions | RPC Worker |
| `ChainDO`, one | `P+1` to head: block records, witnesses, head and finality pointers | daemon | RPC Worker |
| `StateShard`, `N` of them | `P+1` to head: state diffs | daemon | RPC Worker |

All integers in binary formats are little-endian unless marked otherwise. `uvarint` is
unsigned LEB128. Hashes in object keys are lowercase hex without `0x`. Block numbers in keys
are zero-padded to 20 digits. Values in backticks such as `chunk_blocks`, `N` and `batch` are
parameters, set per blockchain in "Parameters" at the end.

## R2

### Objects

![R2 objects](diagrams/r2-layout.svg)

```text
{chain-id}-{genesis-hash}/
  HEAD.json
  live/HEAD.json                                    # the live window's pointers (see "Live pointers")
  live/records/{number:020}-{hash}.bin              # one block record per block above P (see "Live records")
  live/index/{first:020}-{last:020}-{last-hash}.bin # transaction hashes of the window, named by live/HEAD.json
  manifests/{generation:020}-{sha256}.json
  config/{sha256}.json                              # genesis allocation and fork schedule
  segments/{first:020}-{last:020}-{last-hash}/{content-id}/
    meta.json
    blocks.pack                                     # one block record per block
    offsets.bin                                     # 80 bytes per block
  hash-index/{first:020}-{last:020}/
    transactions-{sha256}.dir
    blocks-{sha256}.dir
    pack-{sha256}.pack
  log-index/{first:020}-{last:020}/
    directory-{sha256}.dir
    pack-{sha256}.pack
  state/layers/{first:020}-{last:020}-{content-id}/
    layer.json
    {domain}.{n:04}.pack                            # data pages
    {domain}.index.pack                             # index pages
    {domain}.filter                                 # blocked Bloom filter
  witnesses/{first:020}-{last:020}-{content-id}/
    offsets.bin                                     # 56 bytes per block
    witness.{n:04}.pack                             # one witness per block
```

One bucket for the archive. `content-id` is the SHA-256 of the sorted list of the directory's file
names and digests, so a directory's name changes whenever its content does.

### Rules

- **`HEAD.json` is the only object that changes**, apart from `live/HEAD.json` (below), which is
  not part of the archive. Every other object is written with `If-None-Match: *` and never
  rewritten. Writing the same key again must produce the same bytes. The `live/` records and
  index objects are immutable too (their keys carry a block hash) but, unlike the archive, they
  are deleted once the blocks are promoted (see "Live records").
- **Nothing is found by listing.** A reader starts at `HEAD.json`, reads the manifest it names,
  and reaches every other object through references in the manifest; the live objects are
  reached through `live/HEAD.json`.
- **Every reference is checked.** An `ObjectRef` is `{"key", "bytes", "sha256"}`. `key` is the
  object's full key in the bucket, namespace included (`{chain-id}-{genesis-hash}/…`). Readers
  check the size, and the SHA-256 of every frame they read.
- **A reader pins one generation per request.** It reads `HEAD.json` (cached in the isolate for
  up to 10 seconds) and uses that manifest for the whole request.
- **Garbage collection.** After a merge, objects that no manifest of the last 7 days references
  are deleted. A request never takes 7 days, so no reader loses an object it pinned.

### `HEAD.json` and the manifest

```json
{"version": 1, "generation": 42, "manifest": ObjectRef}
```

The manifest of generation N:

```json
{
  "format": "nullrpc-archive",
  "version": 1,
  "generation": 42,
  "previous": ObjectRef,
  "chain": {"id": 1, "network_id": "1", "genesis_hash": "0x…"},
  "config": ObjectRef,
  "first_block": 0,
  "archived_through": {"number": 23900000, "hash": "0x…", "state_root": "0x…"},
  "finalized_observed": {"number": 23900064, "hash": "0x…"},
  "chunk_blocks": 8192,
  "segments": [{"first": 0, "last": 8191, "last_hash": "0x…", "meta": ObjectRef}],
  "hash_index": {"key_bytes": 6, "objects": [HashIndexObject]},
  "log_index": {"key_bytes": 6, "partition_blocks": 65536, "objects": [LogIndexObject]},
  "state_history": {"layers": [{"first": 0, "last": 23899903, "level": 99, "descriptor": ObjectRef}]},
  "witnesses": {"first_block": 0, "ranges": [{"first": 0, "last": 8191, "offsets": ObjectRef, "packs": [ObjectRef]}]},
  "created_at": "2026-10-08T12:00:00Z"
}
```

- `archived_through` is `P`. Segments, state layers and witness ranges each cover every block
  from their first block to `P`, with no gaps.
- `witnesses.first_block` is the first block with a witness, normally 0.
- `config` holds the genesis allocation and the fork schedule, so the Worker knows each block's
  EVM rules without a node.

**Publication order:** data objects, then `meta.json` and `layer.json` descriptors, then the
manifest, then `HEAD.json`. The first generation writes `HEAD.json` with `If-None-Match: *`.
Every later one uses `If-Match` with the ETag of the `HEAD.json` it read. A conflict stops the
writer; it never overwrites.

### Live pointers

`live/HEAD.json` is the live window's pointers, as `ChainDO.state()` would answer them, so the
RPC Worker can open a request without a Durable Object call. It is the only object besides
`HEAD.json` that changes, and the only one no manifest references.

```json
{
  "version": 1,
  "head": {"number": 1500000, "hash": "0x…"},
  "safe": {"number": 1499968, "hash": "0x…"},
  "finalized": {"number": 1499936, "hash": "0x…"},
  "promoted": {"number": 1499904, "hash": "0x…"},
  "generation": 97,
  "written_at": "2026-10-09T12:00:00.5Z"
}
```

The daemon writes it after every head move in the live Worker (every group of blocks, every
reorg, every prune after a promotion, and at restart), unconditionally: the latest write wins,
and the daemon serializes its own writes. `head` is the live Worker's head at the moment of the
write, which is at least the head any block it has already written; `safe` and `finalized` are
null when the node's are above the head; `promoted` is `P` and `generation` the archive
generation the window was last pruned to. A failed write is logged and does not stop ingestion.

A reader uses the object only when `version` is 1, `head` and `promoted` are well formed and
`written_at` is less than a minute old (`POINTERS_MAX_AGE_MS` in apps/rpc/src/live.ts);
otherwise it asks the live Worker, so a daemon that does not write the object, or stopped, loses
nothing but the saved call. The reader caches the object for 2 s (per isolate and, through the
edge cache, per data center), so a request may see the head up to about 2 s late. Every live
read still carries the head it pinned, and a stale answer is always followed by a `state()` call
to the live Worker, never by another copy of this object (see "Reads above `P`").

The object also lists the window's blocks (two optional members; a daemon that writes neither
is an older one, and the reader asks the live Worker for blocks as before):

```json
{
  "blocks": {"first": 1499905, "hashes": ["…", "…"]},
  "tx_index": {"key": "…/live/index/00000000000001499905-00000000000001500000-….bin", "bytes": 8232, "sha256": "…"}
}
```

`blocks.hashes[i]` is the hash of block `first + i`, the last one the head's, for the newest
blocks above `P` (at most 1,024: `liveIndexBlocks` in services/internal/core/daemon_records.go;
a window that has outgrown it lists only its newest part). `tx_index` names the transaction
index of the same blocks (see "Live records"). The reader ignores the list unless it ends at
the head and starts above `P`.

### Live records

Every block the daemon writes to the live window also goes to R2, so that the RPC Worker reads
blocks above `P` (`eth_getBlockByNumber` at `latest`, fees, receipts of recent transactions,
`eth_call` at the head) from the bucket and its edge cache instead of `ChainDO`, which is one
object per chain and queues under load.

- `live/records/{number:020}-{hash}.bin` is the block record, uncompressed: the same bytes as
  `ChainDO`'s section payload and as a `blocks.pack` frame once decompressed. The daemon writes
  it (`If-None-Match: *`) before it writes the block to the live Worker, so `live/HEAD.json`
  never lists a block whose record is not there; a write that fails is logged
  (`live_record_error`) and the block is served by the live Worker until its record is deleted.
- `live/index/{first:020}-{last:020}-{last-hash}.bin` is the transaction index of blocks
  `first … last`, written before the `live/HEAD.json` that names it. A 32-byte header, then
  one 12-byte entry per transaction, sorted by hash:

  | Bytes | Field |
  |---|---|
  | 0–7 | `NRPCLIDX` |
  | 8–9 | format version, `1` |
  | 10–11 | zero |
  | 12–19 | `first` |
  | 20–27 | `last` |
  | 28–31 | entry count `m` |
  | 32– | `m` entries: the transaction hash's first 8 bytes, then `number - first` (uint32) |

  Two transactions sharing a prefix (both entries are kept) are told apart by the live Worker.

Both are immutable: a key names a block hash (the head's, for the index), and the chain of
hashes fixes the bytes. A reorg does not rewrite anything: the next `live/HEAD.json` lists the
new branch, and the removed blocks' records are deleted an hour later. A promotion likewise
lists only blocks above the new `P`, and the records at or below it are deleted an hour after
it (`liveRecordGrace`), long after any reader pinned a document that listed them (a document is
used for at most a minute, a manifest for 10 s). An index object is deleted 10 minutes after
the document that named it is replaced (`liveIndexGrace`). The deletions go through the
daemon's gc.json like compaction's. One live index object per head move is written on top of
the record and the pointers, about 3 Class A operations per block.

**Reads.** A block read carries the head the request pinned. When that head came from
`live/HEAD.json`, the Worker takes the block's hash from the document's list (by number, or
the number from the hash), reads the record through the archive's day-long edge cache, and
checks the decoded header's hash against the listed one, as it checks the live Worker's answer.
A transaction lookup reads the index object (checked against `tx_index`'s size and digest,
parsed once per isolate) and then the block. The list is *complete* when it starts at `P+1`: a
hash or transaction it lacks is then not in the window, and the Worker goes to the archive
without asking the live Worker. The live Worker is asked for whatever the objects cannot
answer: a pin that came from `state()` (after a stale answer; see "Reads above `P`"), a block
outside the listed range, a missing record, an index that fails its digest, or a transaction
prefix two entries share.

### Chain config

`config/{sha256}.json` is the blockchain's `genesis.json`, verbatim. Its `config` member is what
geth and the other clients read as the chain configuration: `chainId`, the fork activation blocks (`homesteadBlock`
through `londonBlock`, `mergeNetsplitBlock`), `terminalTotalDifficulty`, the fork timestamps
(`shanghaiTime`, `cancunTime`, `pragueTime`, `osakaTime`, and later `bpo*Time` forks),
`blobSchedule`, and `depositContractAddress`. The executor derives each block's EVM rules and
blob parameters from that member. The genesis allocation in the file is also the state history's
values at block 0.

### Packs

Every `.pack` file starts with a 16-byte header, followed by independent zstd frames:

| Bytes | Field |
|---|---|
| 0–7 | `NRPCPACK` |
| 8–9 | format version, `1` |
| 10–11 | codec: `1` block records, `2` state pages, `3` hash index buckets, `4` log index buckets, `5` witnesses |
| 12–15 | zero |

Each frame is one record, read with one range request. A reader checks the frame's length and
SHA-256 (from the reference that pointed to it) before decompressing, and the uncompressed
length after. The Worker refuses frames larger than 8 MiB uncompressed. Frame offsets are
absolute in the file (the first frame starts at byte 16), and each frame is one zstd frame with
its content size. Pack files rotate at 1 GiB.

### Block bundles

A segment holds consecutive blocks inside one chunk (`chunk_blocks` blocks, aligned to
multiples of it). Promotion adds segments to the open chunk; when a chunk is complete, its
segments are rewritten as one.

`meta.json` describes the segment and references its two data objects:

```json
{"first": 0, "last": 8191, "first_parent_hash": "0x…", "last_hash": "0x…",
 "files": {"blocks.pack": ObjectRef, "offsets.bin": ObjectRef}}
```

`first_parent_hash` is the parent of the first block (the previous segment's `last_hash`; zero
for block 0). `offsets.bin`'s `bytes` must be `(last − first + 1) × 80`.

`offsets.bin` has one 80-byte record per block, in block order, so block N's record is at
byte `(N − first) × 80`:

| Bytes | Field |
|---|---|
| 0–31 | block hash |
| 32–39 | frame offset in `blocks.pack` (u64) |
| 40–43 | compressed length (u32) |
| 44–47 | uncompressed length (u32) |
| 48–79 | SHA-256 of the compressed frame |

Reading a block is two range reads: the 80-byte record, then the frame. The decoded block's
number and hash must match the record. The 256 hashes before a block (for `BLOCKHASH`) are one
contiguous read of `offsets.bin`.

### Block records

Each frame in `blocks.pack` is the RLP list:

```text
[raw_block, senders, receipts, blob_gas_price, extras]
  raw_block       bytes  the block exactly as debug_getRawBlock returns it
  senders         bytes  20 bytes per transaction, in order
  receipts        list   per transaction: [type, status, cumulative_gas_used, logs]
                         status: empty (failed), 0x01 (success), or a 32-byte
                         post-state root before Byzantium
                         logs: [[address, [topics…], data], …]
  blob_gas_price  uint   the block's blob base fee, 0 without blob transactions
  extras          list   per transaction: [[name, value], …], receipt fields the
                         blockchain's RPC adds that cannot be derived (empty on Ethereum)
```

`extras` keeps the format usable on a blockchain whose receipts carry extra fields. Names are the
JSON field names; values are big-endian integers.

Senders are stored so the Worker never recovers signatures. Everything else in the JSON
response is derived: block and transaction hashes, `gasUsed` from consecutive cumulative gas,
`effectiveGasPrice` from the transaction and the base fee, `contractAddress` from sender and
nonce, `logIndex` across the block, `logsBloom` from the logs, `blobGasUsed` from the blob count.

Writers check every block: the header hash, every transaction hash, and the receipts root
(receipts re-encoded in consensus form must hash to `receiptsRoot`). Before Byzantium, where
some clients keep only a status, the receipts are checked against the header's logs bloom and
gas used instead.

### Hash index

Finds the block of a transaction hash or block hash with a fixed number of reads.

An index object covers a block range and has two parts, transactions and blocks:

```json
{"first": 0, "last": 23899903,
 "transactions": {"bucket_bits": 21, "entries": 2900000000, "directory": ObjectRef},
 "blocks": {"bucket_bits": 14, "entries": 23899904, "directory": ObjectRef},
 "packs": [ObjectRef]}
```

- **Key.** `K` is the first 6 bytes of the hash, big-endian. Its top `bucket_bits` select a
  bucket. Writers choose the fewest bits that keep the average bucket at or below 2,048 entries.
- **Directory.** `2^bucket_bits` records of 56 bytes: frame offset (u64), compressed length
  (u32), uncompressed length (u32), entries (u32), pack index in `packs` (u16), zero (u16),
  SHA-256 of the frame (32 bytes). An empty bucket is 56 zero bytes.
- **Bucket frame.** Entries sorted by `(K, block, index)`. Each entry is `uvarint(K − previous
  K)` (the first relative to the bucket's base key, `bucket << (48 − bucket_bits)`), `uvarint(block − first)` and, for transactions, `uvarint(index in block)`.

**Lookup:** for every object, one 56-byte directory read and one frame read, all objects in
parallel. Each candidate is confirmed by reading its block and comparing the full hash, so a
6-byte prefix collision never returns the wrong block.

### Log index

Finds the blocks that may contain logs matching an `eth_getLogs` filter.

- **Fields.** The emitting address (tag `0x00`) and the topic at position i (tag `0x01 + i`).
  `K` is the first 6 bytes of SHA-256(tag ‖ value).
- **Partitions.** An object's blocks are split at multiples of 65,536. A query reads only the
  partitions its range touches.
- **Object.** A `LogIndexObject` in the manifest is
  `{"first", "last", "partitions": [{"bucket_bits", "keys", "entries"}], "directory": ObjectRef, "packs": [ObjectRef]}`.
  Partition j is absolute partition `⌊first / partition_blocks⌋ + j` and covers its blocks within
  `[first, last]`; every partition the object's range touches is listed.
- **Directory.** One object: per partition, in order, `2^bucket_bits` records in the hash index's
  56-byte layout, so partition j's records start at the sum of `56 × 2^bucket_bits` over the
  partitions before it. A record's count is the number of keys in the bucket.
- **Bucket frame.** Per key, sorted by `K`: `uvarint(K − previous K)` (the first relative to the
  bucket's base key, `bucket << (48 − bucket_bits)`), `uvarint(n)`, `uvarint(b₀ − partition's first
  block)`, then `uvarint(bᵢ − bᵢ₋₁ − 1)` for the other blocks.

**Lookup:** the filter's addresses form one group, and each constrained topic position forms
another. A group's candidates are the union of its keys' blocks; the query's candidates are the
intersection of all groups. The Worker then reads each candidate block and applies the exact
filter, so results equal a full scan.

### Index tiers

Promotion adds one hash index object and one log index object per batch. Compaction merges
adjacent objects two at a time so that at most `max_objects` (6) sit above the backfill's base
object, with spans that stay roughly geometric ("Compaction" below). An object's level is
informational and follows from its span: level ℓ covers at least `batch × 4^ℓ` blocks; the base
is below all levels. A lookup reads every object in parallel, so it costs about one round of
range reads.

### State history

The value of every account, storage slot and code at the end of every block, stored only at
the blocks where it changed.

| Domain | Key | Value; empty means absent or zero |
|---|---|---|
| `accounts` | address, 20 bytes | `uvarint(nonce)`, `uvarint(len)`, balance (big-endian, `len` bytes), code hash (32 bytes, omitted for no code) |
| `storage` | address ‖ slot, 52 bytes | big-endian value (live layers remove leading zeros; the base layer keeps the client's bytes) |
| `code` | code hash, 32 bytes | bytecode; one entry, at block 0 |

A **layer** covers a block range. Per domain, its entries are sorted by `(key, block)`; an
entry `(key, block, value)` is the key's value at the end of that block.

```text
data page  := group*
group      := uvarint(len(key)) key uvarint(n) (uvarint(block_delta) uvarint(len(value)) value){n}
index page := uvarint(n) (uvarint(len(key)) key uvarint(first_block) uvarint(pack)
              uvarint(offset) uvarint(length) uvarint(uncompressed) sha256[32]){n}
```

A group's first block delta is the absolute block number, the others are relative to the previous
entry. Data pages are about 32 KiB uncompressed. An index page lists up to 1,024 data pages by
their first `(key, block)`. `pack` in an index page indexes the domain's `packs` in `layer.json`:

```json
{"first": 0, "last": 23899903,
 "domains": {
   "accounts": {"keys": 0, "entries": 0, "pages": 0, "packs": [ObjectRef], "index": ObjectRef,
                "root": [{"first_key": "<hex, no 0x>", "first_block": 0,
                          "record": {"block_number": 0, "offset": 16, "length": 0,
                                     "uncompressed_length": 0, "sha256": "<hex>"}}],
                "filter": ObjectRef},
   "code": {…}, "storage": {…}}}
```

`index` is `{domain}.index.pack`, `filter` is `{domain}.filter`, and `root` has one entry per index
page, in order: the page's first `(key, block)` and its frame in `index` (`record.block_number` is
the page's ordinal, not a block). Every domain is listed; one without entries has an empty `root`.
The layer's level is in the manifest only.

**Finding a page.** In the root, take the last index page whose first `(key, block)` is at or
before `(key, n)`; in that page, the last data page likewise. Keys compare as bytes, then blocks
as numbers. The key's newest entry at or before `n` is in that data page, or the key has none in
the layer.

**Lookup of `(key, n)` in a layer:** pick the index page from the root (cached), read it, pick
the data page, read it, and take the key's last entry at or before `n`. Two range reads.

**Blocked Bloom filter**, one per layer and domain, every layer, no size limit:

```text
"NRPCBLM1"  u32 block_count  u32 k  (block_count × 4096 bytes)
```

A key's block is `u32(keccak256(key)[0..4]) mod block_count`. Inside that 4 KiB block it sets
k = 7 bits at `(h1 + i·h2) mod 32768`, with h1 and h2 the u64 values of `keccak256(key)[8..16]`
and `[16..24]`. Writers size `block_count` for 10 bits per key (about 1 % false positives).
Bit `b` of a block is bit `b mod 8` (least significant first) of byte `b ÷ 8`; the u32 and u64
values are little-endian. Checking a key takes one 4 KiB range read per layer, and every layer's block can be read in the
same round.

**Lookup of `(key, n)` across layers:** read the filter blocks of every layer that starts at or
before `n`, in parallel. Search the layers whose filter accepts the key, newest first; the first
layer with an entry at or before `n` answers. If none does, the key was absent or zero at `n`.

**Tiers.** Promotion writes one level-0 layer per batch. Compaction merges adjacent layers two
at a time so that at most `max_objects` (6) sit above the backfill's base layer, with spans that
stay roughly geometric ("Compaction" below). A layer's level is informational and follows from
its span (level ℓ covers at least `batch × 4^ℓ` blocks); the base is below all levels. A lookup
therefore reads at most 7 filter blocks in one round and two pages after it, however long the
chain runs. The daemon runs merges one at a time between promotions; each publishes its own
generation, which replaces the merged layers and keeps every block.

### Witnesses

One frame per block in `witness.{n}.pack`. `offsets.bin` has one 56-byte record per block, in
block order:

| Bytes | Field |
|---|---|
| 0–7 | frame offset (u64) |
| 8–11 | compressed length (u32) |
| 12–15 | uncompressed length (u32) |
| 16–17 | pack number (u16) |
| 18–23 | zero |
| 24–55 | SHA-256 of the compressed frame |

```text
witness  := u8(version = 1) accounts storage
accounts := uvarint(n) (address[20] u8(flags) uvarint(nonce) uvarint(len) balance code_hash[32]?){n}
            flags: bit 0 = exists, bit 1 = has code
storage  := uvarint(n) (address[20] uvarint(m) (slot[32] uvarint(len) value){m}){n}
```

Values are the block's pre-state: what each key held when the block's first transaction to touch
it started (docs/pipeline.md, "Witnesses"). Bytecode is not repeated in the
witness: the Worker reads it from the `code` domain by hash and caches it with no expiry,
because a code hash names one immutable bytecode.

Witness ranges follow segments: one witness range per segment, rewritten with the segment
when a chunk completes.

### Reads per method

R2 range reads on a cache miss. Index roots, filter blocks, code and immutable frames are cached.

| Method | Reads |
|---|---|
| Block, header, receipts by number | 2: offset record, frame |
| Block or transaction by hash | 2 per index object in parallel, then 2 for the block |
| `eth_getLogs` | per index object: 2 when it is small (directory ≤ 64 KiB and pack ≤ 256 KiB, read whole), else 2 per field value per partition touched; then 1 per 256 offsets records and 1 per run of candidate blocks (`blocks.pack` in aligned 256 KiB windows, ≤ 2 MiB per read), six reads at a time, under a budget of 256 reads per query |
| Balance, nonce, storage, code at a block | 1 round of filter blocks, then 2 pages |
| `eth_call`, `eth_estimateGas` | the state lookup above for each new key, in dependent rounds |
| Trace of a mined transaction | 2 for the witness, 2 for the block, plus uncached code |

## Durable Objects

![Durable Objects](diagrams/do-layout.svg)

Both classes live in the chain's `nullrpc-live-{chain-id}` Worker (`apps/live`, one Wrangler
environment per chain). The daemon writes through its ingest route
(`https://live-{chain-id}.nullrpc.dev/ingest/*`) with a bearer token (the `INGEST_TOKEN` secret).
The chain's RPC Worker, `nullrpc-rpc-{chain-id}`, reads through a service binding to its
`LiveReads` entrypoint, and the status dashboard through one to its `LiveStatus` entrypoint
(named entrypoints have no public route). The daemon
writes to R2 through the S3 API with a token scoped to the archive bucket; the RPC Worker has
read-only R2 bindings.

### Rows

Both classes store one row per group of `group` consecutive blocks, keyed by the group's first
block. Groups are aligned: a group ends at a block `n` with `(n + 1) mod group = 0` (the first
group after `P` may be shorter). A row's data is one section per block:

```text
section := uvarint(number - first) hash[32] uvarint(len) payload
```

```sql
CREATE TABLE rows (first INTEGER, part INTEGER, last INTEGER, data BLOB, PRIMARY KEY (first, part));
CREATE TABLE orphans (hash TEXT PRIMARY KEY, number INTEGER, at INTEGER);  -- reorg fence, 1 hour
```

`part` is above 0 only when the data exceeds 1 MiB (SQLite rows are limited to 2 MB). A reorg into
the middle of a group rewrites the row with the blocks it keeps.

### `ChainDO`

One object, named by the chain ID. A section's payload is the block record (the same bytes as a
`blocks.pack` frame, uncompressed), its witness and its transaction hashes:

```text
payload := uvarint(len) record uvarint(len) witness uvarint(n) tx_hash[32]{n}
```

It also keeps `kv(k, v)`: head, safe, finalized, promoted (`P`), generation and the shard count,
and for the status page the network head, progress times, counters and the last ingest error.
Hash and transaction lookups use in-memory maps built from the rows on first use after a wake;
every write then updates them for the rows it touches, so reads after an ingest never rebuild.

| Call | Caller | Does |
|---|---|---|
| `init(promoted, generation, shards)` | daemon | first start after the backfill |
| `putRows([{first, last, data}])` | daemon | writes rows; rewriting a group replaces it |
| `setHead(head, safe, finalized, network_head)` | daemon | moves the head; the head's section must exist, or the head is `P` |
| `fence(removed)`, `truncateAbove(n)` | daemon | reorgs |
| `pruneAtOrBelow(promoted, generation)` | daemon | after a promotion; sets `P` |
| `state()` | Worker | head, safe, finalized, `P`, generation, shard count (normally read from R2's `live/HEAD.json` instead; see "Live pointers") |
| `block(number or hash, pin)` | Worker | a block's record, if at or below the pin (normally read from R2 instead; see "Live records") |
| `witness(number, pin)` | Worker | a block's witness |
| `txBlock(hash, pin)` | Worker | the block of a transaction hash above `P` (normally from the R2 index instead) |
| `status()`, `history(range)` | dashboard | pipeline status; head and network head once a minute |

`LiveReads` lowercases and checks every pin (`0x` and 64 hex digits, a block number ≥ 0) and
every state key (`0x` optional, any case, the domain's key length; domains 1, 2 and 3 only)
before it calls an object.

The Worker reads the pointers from `live/HEAD.json` in R2 (cached for 2 s per isolate and per
data center) and calls `state()` only when that object is unusable or after a stale answer; it
caches `state()` per isolate for half a block time, and block records and witnesses by block
hash with no expiry, so most reads never reach the object.

### `StateShard`

`N` objects, named `{chain-id}-{i}`. Account `a` and all its storage live in shard
`keccak256(a)[0] mod N`. Code lives in shard `code_hash[0] mod N`. A shard's row holds only the
blocks of the group that touch it. A section's payload is the block's changes for the shard:

```text
payload := (u8(domain) key uvarint(len) value)*      domain: 1 accounts (key 20 bytes),
                                                     2 storage (52), 3 code (32), 4 wipe (20, no value)
```

On first use after a wake the object builds an in-memory index, key → versions by block; every
write then updates it for the rows it touches.

| Call | Caller | Does |
|---|---|---|
| `applyMany([{first, last, data}])` | daemon | writes rows in one transaction |
| `fence(removed)`, `truncateAbove(n)` | daemon | reorgs |
| `pruneAtOrBelow(n)` | daemon | after a promotion |
| `getPinned(domain, key, n, pin)` | Worker | newest value at or below `min(n, pin)`; `stale` if the pin was removed |
| `getPinnedMany([{domain, key}…], n, pin)` | Worker | `getPinned` for many keys in one call, answered in order; `stale` as a whole |
| `scanPinned(address, n, pin)` | Worker | an account's slots changed in the window, with their newest values |

Durable Objects are billed for wall-clock time while busy and for every row written or deleted,
so `N` is small and fast chains use groups. The live window is about an hour, so each shard's
index stays a few MB.

### Ingest route

Every request carries `Authorization: Bearer INGEST_TOKEN`. Bodies are JSON; row data is base64.

| Request | Does |
|---|---|
| `GET /ingest/state` | the `ChainDO` pointers and the shard count |
| `POST /ingest/init {promoted, generation, promotion?}` | first start after the backfill |
| `POST /ingest/blocks {rows: [{first, last, chain, shards: {i: data}}], head, safe, finalized, network_head?, promotion?}` | shard rows, then `ChainDO` rows, then the head; `network_head` is the node's head |
| `POST /ingest/reorg {ancestor, removed}` | fence everywhere, lower the head, truncate everywhere |
| `POST /ingest/prune {promoted, generation, promotion?}` | prune every shard and `ChainDO` at or below `promoted` |

`promotion` is the daemon's promotion rule, `{batch, max_age_s, max_batches, group}`
("Promotion" below); `ChainDO` keeps the last one it was sent, for the status route.

### Status route

`LiveStatus` serves the status dashboard (`LIVE_{chain-id}` service binding):

| Request | Returns |
|---|---|
| `GET /internal/status` | `{chain: {executed_head, target, lag, safe, finalized, optimistic, archived_through, r2_tip, pending_blocks, last_progress, last_ingest, promotion: {params, next, last}, counters, halted, last_error, …}}` |
| `GET /internal/history?range=1h\|24h\|7d` | `{bucket_s, from, to, retention_s, points: [{t, executed, target, lag, rate}]}` |

`target` is the last `network_head` the daemon sent, or the head until it sends one; `lag` is
`target − head`. `promotion.next` applies the daemon's rule (`promotion.params`) to the window's
pointers: `finalized_above` is `finalized − P`, `due_block` the block whose finalization completes
a batch above `P` (on a group boundary), `deadline` when block `P+1` reaches `max_age` (null
while `P+1` is not in the window), and `due` whether a promotion is due now. It is null until the
daemon has sent its rule. `ChainDO` samples the head and target once a minute (an alarm) and keeps 7
days. History buckets are 1 minute (1h), 5 minutes (24h) and 1 hour (7d); each point is the
bucket's last sample, and `rate` is blocks per second since the sample before it. Times are
seconds, except `at`, `last_progress`, `last_ingest`, `deadline` and error times (milliseconds).

### Reads above `P`

![Read path](diagrams/read-path.svg)

A state read at block `n`:

1. The Worker pins the head `(M, H)` from `live/HEAD.json` (or its cached `state()`).
2. If `n ≤ P`, it reads R2 state history at `n`.
3. Otherwise it calls `getPinned(key, n, (M, H))` on the key's shard. A row in `P+1 … n`
   answers. No row means the key has not changed since `P`, and the Worker reads R2 history at
   `P`. The executor's reads (many keys per round) go through `getPinnedMany`: one call to the
   live Worker, which groups the keys by shard and asks every shard once.
4. `stale` means a reorg removed the pinned head. The Worker reads `state()` from the live
   Worker again (not `live/HEAD.json`, which may still name the removed head) and retries.

Block and transaction reads above `P` follow the same pin but normally never reach a Durable
Object (see "Live records"): a request pinned to a head that a reorg has just removed reads
that branch's records, consistently, until its state read reports `stale` and the request
re-pins through `state()`; from then on its block reads go to the live Worker too, since no
document lists blocks for a head taken from `state()`. A request that reads only blocks may
therefore serve the removed branch for up to the 2 s the document is cached, the same lag
`eth_blockNumber` has.

The executor's reads above `P` go through `getPinnedMany` and the R2 history at `P` together
(one round takes the slower of the two, not both), and most of a call's keys are answered
before it asks: the witness of `n+1` is the state at the end of `n` for every key that block
touched, and the witnesses of `n` and `n-1` name what those blocks touched, checked against the
window in one `getPinnedMany` at `n` (apps/rpc/src/state-source.ts, `hints`).

**Caches.** The RPC Worker keeps the window's answers per isolate (apps/rpc/src/live.ts,
`cachesFor`): a value at block `n` under pin `(M, H)` is fixed by `H`, since the hash fixes the
chain below it, and a "no row" answer stays right after a promotion (the key is then unchanged
since the new `P` as well, and the archive at the new `P` answers the same), so both are kept
by pin hash, block and key (32,768 entries; values over 4 KiB, code mostly, are not kept) and
witnesses by pin hash and block (32 MiB). A `getPinnedMany` then carries only the keys the
isolate has not seen under that pin: the hints wave of every call at one head is read from the
shards once per isolate per block, not once per call. The shards are asked under a new pin
after a `stale` answer, since the pin hash differs. The consequence is the one blocks have: a
request whose reads all hit the cache under a pin a reorg just removed is answered from that
branch, consistently, for up to the 2 s the pointers document is cached.

**Promotion race.** A promotion publishes `HEAD.json` first; `/ingest/prune` then prunes the
shards and sets `P` in `ChainDO` last. Once a shard is pruned, a state read at `n` in
`P+1 … P′` finds no row there, and a Worker that still holds the old `P` (from `state()` or its
manifest) would read R2 history at the old `P`. The Worker therefore re-reads `HEAD.json`
whenever `state().promoted` is newer than its manifest (`catchUpArchive` in
apps/rpc/src/chain.ts), and reads at or below the new `P` go to R2. This covers reads made after
`P` is set: a `state()` read between the shard prune and the `P` update still says the old `P`,
and the Worker keeps it for up to half a block time, so a read in that window can return a value
from before `P′`.

### Reorgs

The daemon runs a reorg to ancestor `A` in this order:

1. `fence(removed)` on every shard and `ChainDO`, with the hashes of every block above `A`.
   Fenced hashes are kept for one hour.
2. Lower the head in `ChainDO` to `A`.
3. `truncateAbove(A)` everywhere.
4. Apply the new branch, group by group: shards first, then `ChainDO`, then the head.

A read pinned to a removed block gets `stale` from the moment its rows can change, never a
mix of two branches.

## Promotion

A promotion starts when `F ≥ P + batch`, or when block `P+1` is finalized and older than
`max_age`. It promotes at most 8 batches at once, so a backlog clears in steps.

Each promotion writes, for blocks `P+1 … P′`: one segment and one witness range per chunk the
blocks touch, a hash index object, a log index object, a level-0 state layer built from the
blocks' diffs, the manifest and `HEAD.json`. That is tens of objects an hour.

### Compaction

Between promotions the daemon compacts, one step at a time, each step publishing its own
generation:

1. two adjacent state layers, neither the base, into one;
2. two adjacent hash index objects, then log index objects, likewise;
3. a chunk that is complete and has more than one segment: its segments into one, and its
   witness ranges into one.

**Which two.** The Worker reads every layer and index object in parallel and runs about six
subrequests at a time, so the count above the base is what a lookup costs. The daemon picks:

- the adjacent pair with the smallest combined span, when that is at most a batch: the small
  objects that `max_age` promotions write (32 to 64 blocks against a batch of 256) fold into
  their neighbour at once, before they count;
- otherwise, while more than `max_objects` (6, `--max-objects`) objects sit above the base, the
  adjacent pair whose spans are closest (the lowest larger/smaller ratio); ties go to the
  smaller pair.

The merged object replaces the pair in place, so the lists stay ordered by first block and
contiguous. The spans then stay roughly geometric: a promotion leaves at most `max_objects + 1`
objects, and the merge that follows brings the count back to the cap, usually by folding the
two newest. Each block is rewritten about log2 of the history above the base, in blocks, over
batch times: 10 to 25 times over the life of a chain. The oldest object above the base holds
most of that history and is rewritten once each time it doubles; that is the largest merge and
it never touches the base, which is never rewritten.

Merges read the objects they replace from R2 (no egress fees). The replaced objects are deleted 7
days after the generation that dropped them; manifests are kept.

The node's `prune_distance` is one batch plus the finality lag plus a day: the daemon can be down
for a day and still pull every block it missed.

## Parameters

Set once per blockchain. The values are Ethereum mainnet's, the benchmark.

| Parameter | Ethereum mainnet | Rule for another blockchain |
|---|---|---|
| block time | 12 s | |
| `chunk_blocks` | 8,192 | about 8 GB of block records per chunk |
| `N` (state shards) | 16 | 16 for blocks of mainnet size; fewer for smaller blocks |
| `group` (blocks per row) | 1 | 1 at 2 s or slower; enough blocks for about one row per second below that; divides `batch` and `chunk_blocks` |
| `batch` | 256 blocks (51 min) | about one hour of blocks |
| `max_age` | 2 h | 2 h |
| level-0 span | `batch` | `batch` |
| `prune_distance` | ≥ 8,000 blocks | `batch` + finality lag + one day |

## Sizing

Ethereum mainnet:

| Data | R2 |
|---|---|
| Blocks, receipts, indexes, state history | 1.6–1.9 TB |
| Witnesses | 0.5–2 TB (measure on a mainnet range) |
| Total | 2.1–3.9 TB |

The Durable Objects hold only the live window: a few GB.
