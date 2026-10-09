package core

// Live block records and the live index in R2 (docs/storage.md, "Live records"): every block
// written to the live window also goes to `live/records/{number}-{hash}.bin` (the record bytes
// LiveReads.block would answer), so the RPC Worker reads blocks above P from R2 and its edge
// cache instead of ChainDO. `live/HEAD.json` lists the window's hashes (number to hash) and
// names `live/index/{first}-{last}-{hash}.bin`, the transaction hash index of the same blocks,
// so lookups by hash need no Durable Object either.
//
// Records and index objects are immutable: a key names a block hash (or a head hash), and the
// chain of hashes fixes the bytes. Reorgs and promotions never rewrite them; a reorg stops
// listing the removed blocks, a promotion lists only blocks above the new P. The objects are
// deleted after a grace period (gc.json, as compaction's replaced objects are, with a shorter
// delay). The writes are best effort, like live/HEAD.json: a failed record write is logged and
// the Worker falls back to the live Worker for that block.

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	// liveIndexBlocks caps the blocks listed in live/HEAD.json and the index: the newest ones.
	// A window that outgrows it (promotion stalled) keeps serving its older blocks from ChainDO.
	liveIndexBlocks = 1024
	// liveRecordGrace is how long after a promotion (or a reorg) a record stays in R2: a reader
	// pins live/HEAD.json for at most a minute and its manifest for 10 s.
	liveRecordGrace = time.Hour
	// liveIndexGrace is how long a superseded index object stays.
	liveIndexGrace = 10 * time.Minute
	// liveIndexMagic starts every index object.
	liveIndexMagic = "NRPCLIDX"
	// liveIndexEntry is the size of one entry: 8 bytes of the transaction hash, uint32 block offset.
	liveIndexEntry  = 12
	liveIndexHeader = 32
	// recordWriters is how many records are written to R2 at once.
	recordWriters = 8
)

// liveRecordKey is the record's key: hashes are lowercase hex without 0x, numbers zero-padded.
func liveRecordKey(ns string, id BlockID) string {
	return fmt.Sprintf("%s/live/records/%020d-%s.bin", ns, id.Number, strings.ToLower(strings.TrimPrefix(id.Hash, "0x")))
}

// liveIndexKey is the index object's key for blocks first..last ending at last's hash.
func liveIndexKey(ns string, first uint64, last BlockID) string {
	return fmt.Sprintf("%s/live/index/%020d-%020d-%s.bin", ns, first, last.Number, strings.ToLower(strings.TrimPrefix(last.Hash, "0x")))
}

// windowBlock is what the daemon keeps per block of the live window for the pointers.
type windowBlock struct {
	hash string
	txs  []string
}

// liveWindow mirrors the live Worker's window: every block written to it, by number. The
// follower adds and truncates, the promotion loop prunes; publishPointers snapshots it.
type liveWindow struct {
	mu     sync.Mutex
	blocks map[uint64]windowBlock
	// lastIndex is the key of the index object live/HEAD.json names, to skip rewriting it.
	lastIndex string
}

func (w *liveWindow) add(blocks []*liveBlock) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.blocks == nil {
		w.blocks = map[uint64]windowBlock{}
	}
	for _, b := range blocks {
		w.blocks[b.Number] = windowBlock{hash: strings.ToLower(b.Hash), txs: b.TxHashes}
	}
}

// truncateAbove drops the blocks above n (a reorg) and returns them; pruneAtOrBelow those at
// or below n (a promotion).
func (w *liveWindow) truncateAbove(n uint64) []BlockID {
	return w.remove(func(k uint64) bool { return k > n })
}

func (w *liveWindow) pruneAtOrBelow(n uint64) []BlockID {
	return w.remove(func(k uint64) bool { return k <= n })
}

func (w *liveWindow) remove(gone func(uint64) bool) []BlockID {
	w.mu.Lock()
	defer w.mu.Unlock()
	var out []BlockID
	for k, b := range w.blocks {
		if gone(k) {
			out = append(out, BlockID{Number: k, Hash: b.hash})
			delete(w.blocks, k)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Number < out[j].Number })
	return out
}

// liveBlocks is the `blocks` member of live/HEAD.json: the hashes of first..head, in order.
type liveBlocks struct {
	First  uint64   `json:"first"`
	Hashes []string `json:"hashes"`
}

type liveIndexEntryT struct {
	prefix [8]byte
	offset uint32
}

// snapshot lists the window's newest blocks ending at head: contiguous, above promoted and at
// most liveIndexBlocks, and the transaction index entries of the same blocks. A gap or a head
// the window does not hold (a write in progress elsewhere) shortens the list to what is
// certain; the next publish lists the rest. Hashes carry 0x; the window is never nil here.
func (w *liveWindow) snapshot(head BlockID, promoted uint64) (liveBlocks, []liveIndexEntryT) {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := liveBlocks{First: head.Number + 1, Hashes: []string{}}
	if head.Number <= promoted {
		out.First = promoted + 1
		return out, nil
	}
	lowest := promoted + 1
	if head.Number >= liveIndexBlocks && head.Number-liveIndexBlocks+1 > lowest {
		lowest = head.Number - liveIndexBlocks + 1
	}
	first := head.Number + 1
	for n := head.Number; n >= lowest; n-- {
		b, ok := w.blocks[n]
		if !ok || (n == head.Number && b.hash != strings.ToLower(head.Hash)) {
			break
		}
		first = n
		if n == 0 {
			break
		}
	}
	var entries []liveIndexEntryT
	for n := first; n <= head.Number; n++ {
		b := w.blocks[n]
		out.Hashes = append(out.Hashes, b.hash)
		for _, tx := range b.txs {
			raw, err := hex.DecodeString(strings.TrimPrefix(tx, "0x"))
			if err != nil || len(raw) != 32 {
				continue
			}
			var e liveIndexEntryT
			copy(e.prefix[:], raw[:8])
			e.offset = uint32(n - first)
			entries = append(entries, e)
		}
	}
	out.First = first
	sort.Slice(entries, func(i, j int) bool {
		if c := bytes.Compare(entries[i].prefix[:], entries[j].prefix[:]); c != 0 {
			return c < 0
		}
		return entries[i].offset < entries[j].offset
	})
	return out, entries
}

// encodeLiveIndex is the index object (docs/storage.md, "Live records"): a 32-byte header
// (magic, version 1, first, last, entry count) and the entries sorted by hash prefix, each the
// first 8 bytes of a transaction hash and the block's offset from first (uint32).
func encodeLiveIndex(first, last uint64, entries []liveIndexEntryT) []byte {
	out := make([]byte, 0, liveIndexHeader+len(entries)*liveIndexEntry)
	out = append(out, liveIndexMagic...)
	out = binary.LittleEndian.AppendUint16(out, 1)
	out = binary.LittleEndian.AppendUint16(out, 0)
	out = binary.LittleEndian.AppendUint64(out, first)
	out = binary.LittleEndian.AppendUint64(out, last)
	out = binary.LittleEndian.AppendUint32(out, uint32(len(entries)))
	for _, e := range entries {
		out = append(out, e.prefix[:]...)
		out = binary.LittleEndian.AppendUint32(out, e.offset)
	}
	return out
}

// putRecords writes the blocks' records to R2 (recordWriters at a time) and adds the blocks to
// the window. A failed write is logged: the block is still listed, and the Worker falls back
// to the live Worker for it until its record is deleted after promotion.
func (d *daemon) putRecords(blocks []*liveBlock) {
	d.window.add(blocks)
	if d.r2 == nil || len(blocks) == 0 {
		return
	}
	sem := make(chan struct{}, recordWriters)
	var wg sync.WaitGroup
	for _, b := range blocks {
		wg.Add(1)
		sem <- struct{}{}
		go func(b *liveBlock) {
			defer wg.Done()
			defer func() { <-sem }()
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			if err := d.r2.putImmutable(ctx, liveRecordKey(d.r2.ns, b.id()), b.Record); err != nil {
				fmt.Fprintf(os.Stderr, "{\"live_record_error\":%q,\"block\":%d}\n", err.Error(), b.Number)
			}
		}(b)
	}
	wg.Wait()
}

// publishIndex writes the index object for the snapshot, unless it is the one already named,
// and schedules the one it replaces for deletion. It returns the reference for live/HEAD.json,
// or nil when the write failed (the Worker then asks the live Worker for hashes).
func (d *daemon) publishIndex(blocks liveBlocks, head BlockID, entries []liveIndexEntryT) *ObjectRef {
	if len(blocks.Hashes) == 0 {
		return nil
	}
	data := encodeLiveIndex(blocks.First, head.Number, entries)
	key := liveIndexKey(d.r2.ns, blocks.First, head)
	ref := &ObjectRef{Key: key, Bytes: uint64(len(data)), Sha256: sha256Hex(data)}
	d.window.mu.Lock()
	previous := d.window.lastIndex
	d.window.mu.Unlock()
	if previous == key {
		return ref
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := d.r2.putImmutable(ctx, key, data); err != nil {
		fmt.Fprintf(os.Stderr, "{\"live_index_error\":%q,\"head\":%d}\n", err.Error(), head.Number)
		return nil
	}
	d.window.mu.Lock()
	d.window.lastIndex = key
	d.window.mu.Unlock()
	if previous != "" {
		d.scheduleLiveDelete([]string{previous}, liveIndexGrace)
	}
	return ref
}

// scheduleLiveDelete queues live objects for deletion after `after` (gc.json; nil in tests).
func (d *daemon) scheduleLiveDelete(keys []string, after time.Duration) {
	if d.gc == nil || len(keys) == 0 {
		return
	}
	if err := d.gc.scheduleAfter(keys, after); err != nil {
		fmt.Fprintf(os.Stderr, "{\"live_gc_error\":%q}\n", err.Error())
	}
}

// dropRecords schedules the records of blocks that left the window (promoted, or removed by a
// reorg) for deletion after the grace period.
func (d *daemon) dropRecords(ids []BlockID) {
	if d.r2 == nil {
		return
	}
	keys := make([]string, len(ids))
	for i, id := range ids {
		keys[i] = liveRecordKey(d.r2.ns, id)
	}
	d.scheduleLiveDelete(keys, liveRecordGrace)
}

// putImmutable writes an object that is never rewritten (If-None-Match: *); an existing object
// with the same bytes counts as written.
func (r *r2Archive) putImmutable(ctx context.Context, key string, data []byte) error {
	return putImmutable(ctx, r.client, r.bucket, key, data)
}
