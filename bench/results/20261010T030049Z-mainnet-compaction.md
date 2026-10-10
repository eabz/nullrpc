# Mainnet compaction backlog, 2026-10-10: what the manifests say, what changes, what to expect

Namespace `1-d4e5…8fa3`, generations 225 to 925 (00:22 to 03:00 UTC on 2026-10-10), read from
R2 by walking each manifest's `previous` link from `HEAD.json`. The daemon's log was not
available; the manifests name every generation's kind (a promotion moves `archived_through`,
a merge shrinks one list) and `created_at` gives each step's duration.

## The last three hours, by run of generations

| generations | time | what | count |
|---|---|---|---|
| 225 | 00:22 | start of the window: 163 hash index objects, 163 log index objects, 129 state layers above the base; archive 3,891 blocks (13 h) behind the chain | |
| 226 to 372 | 00:23 to 00:57 | catch-up: promotions of 16 or 32 blocks, 7 to 15 s apart, with a state-layer merge every few promotions | 137 promotions, 19 merges |
| 373 to 605 | 00:57 to 01:52 | state-layer merges, 129 layers to 7, one 195-block promotion in between | 232 merges |
| 606 to 809 | 01:52 to 02:27 | hash index merges, 163 objects to 88, 8 to 12 s each | 204 merges |
| 810 to 822 | 02:29 to 02:31 | catch-up again: 13 promotions of 16 to 48 blocks | 13 promotions |
| 823 to 840 | 02:31 to 02:35 | layer merges, two 256-block promotions | |
| 841 to 925 | 02:35 to 03:00 | hash index merges, 101 objects to 17, 12 to 62 s each (longer as the merged spans grow to 1,363 blocks) | 85 merges |

Promotions by size over the window: 88 of 16 blocks, 49 of 32, 3 of 48, 1 of 64, 1 of 195,
2 of 256. The log index received no merge in the window and ended at 307 objects; its spans are
173 of 16 blocks, 122 of 32, and a handful of 48 to 256.

## Two causes

1. **Catch-up promotes the extraction window.** After an outage every spooled block is older
   than `--max-age`, so `promotionTarget` promotes as soon as anything is finalized and in the
   live window: 16 blocks per follower step, 7 to 15 s apart. A 13-hour outage wrote 140
   objects of each kind instead of 15 full batches. The same happened at 02:29 for 13 slices.
2. **One loop, fixed order, one pair per merge.** `compact` served state layers, then the hash
   index, then the log index, and merged two objects per generation. After each catch-up the
   layers took an hour of merges, the hash index the next hour, and a new catch-up (or the
   daemon stopping) arrived before the log index's turn. Merges themselves run fine: 8 to 60 s
   each, none failed in the window.

## What changes (services/internal/core, this commit)

- The promotion and each kind of merge (state layers, hash index, log index, chunks) run in
  their own goroutine. A merge builds and uploads from a snapshot of the manifest, then
  `commit` takes the publish lock, re-reads the manifest, replaces the same objects by key and
  moves `HEAD.json`; a promotion commits the same way and appends. A promotion waits for a
  merge only when an index list is at the manifest's limit of 1,024 objects.
- Above `--max-objects` a merge folds the run of 2 to 16 adjacent objects that removes the
  most objects per cost (span plus two batches for the generation), within 16 batches; when no
  run of three is worth it, the closest-sized pair merges, however large. At or under the cap,
  the widest run within a batch folds. All three kinds use the same rule and cap.
- The max-age rule applies only once the live window is within a batch of the node's head, so
  a catch-up promotes full batches.

## Expected on mainnet after the restart

Simulated from manifest 925's shape with mainnet's cadence (one 256-block promotion every 51
minutes, merges of 15 s plus 10 ms per block; `TestCompactionDrainsMainnetBacklog`):

| | now (gen. 925) | after the drain |
|---|---|---|
| state layers above the base | 6 | 6 (7 right after a promotion, until its merge) |
| hash index objects above the base | 16 | 6 |
| log index objects above the base | 307 | 6 |
| generations to drain | | 27 merges, about 9 minutes (the log index 306 to 6 in about 22 merges of up to 16 objects; the hash index 16 to 6 in 4) |
| deep receipt or transaction lookup | 44 to 52 R2 reads, 0.95 to 1.3 s | 7 objects per index (the base and six): about 8 reads, as on Hoodi |

Steady state: 6 objects per kind, 7 between a promotion and the merge that follows it (15 to
60 s). The oldest object above the base is rewritten when the history above the base doubles;
with 7,945 blocks above the base now, the first such merges are a few thousand blocks and take
a minute or two, during which a promotion may land. A catch-up of 140 slices
(`TestCompactionAbsorbsACatchUp`) peaks at 9 objects per kind and is back at the cap within a
minute of the catch-up ending; with the max-age gate it no longer produces slices at all.

Chunk consolidation, which never got a turn either (3,507 segments for 3,193 chunks; one
complete chunk holds 256 segments), now runs in its own goroutine and merges that chunk first.

Not verified here: the merge durations after the restart (the per-generation JSON lines report
them) and the daemon's reason for the 13-hour gap before 00:22.
