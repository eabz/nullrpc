package core

// Log index (docs/storage.md, "Log index"). An index object covers a block range
// and is split into absolute partitions of logIndexPartitionBlocks blocks;
// each partition has a bucket directory (the hash index's 56-byte records)
// and one zstd frame per non-empty bucket, holding each key's posting list
// (the partition's blocks with a log carrying the key's field). Keys are the
// first 6 bytes of SHA-256(tag || value): tag 0 and the emitting address, or
// tag 1+i and topic i.
//
// buildLogIndex builds one object from the block records of the archive's segments (local,
// or in the bucket in streaming mode) with a bounded-memory external sort (extsort.go).

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/klauspost/compress/zstd"
)

const (
	logIndexFormat    = 1
	logIndexKeyBytes  = 6
	logIndexMaxParts  = 1 << 16
	logIndexMaxPartSz = 1 << 24
)

var (
	// Writers choose a partition's fewest bucket bits that keep the average
	// bucket at or below this many (key, block) entries. Tests lower it.
	logIndexBucketTarget uint64 = 2048
	// Packs rotate at this size. Tests lower it.
	logIndexPackLimit int64 = 1 << 30
	// Blocks per partition. Tests lower it.
	logIndexPartitionBlocks uint64 = 1 << 16
)

type LogIndexPartition struct {
	BucketBits uint8  `json:"bucket_bits"`
	Keys       uint64 `json:"keys"`
	Entries    uint64 `json:"entries"`
}

type LogIndexObject struct {
	FirstBlock      uint64              `json:"first"`
	LastBlock       uint64              `json:"last"`
	KeyBytes        uint8               `json:"-"` // the manifest's log_index.key_bytes
	PartitionBlocks uint64              `json:"-"` // the manifest's log_index.partition_blocks
	Partitions      []LogIndexPartition `json:"partitions"`
	Directory       ObjectRef           `json:"directory"`
	Packs           []ObjectRef         `json:"packs"`
}

type LogIndex struct {
	KeyBytes        uint8            `json:"key_bytes"`
	PartitionBlocks uint64           `json:"partition_blocks"`
	Objects         []LogIndexObject `json:"objects"`
}

func logPartitionCount(first, last, size uint64) int {
	return int(last/size - first/size + 1)
}

func logPartitionRange(first, last, size, p uint64) (uint64, uint64) {
	return max(p*size, first), min(p*size+size-1, last)
}

func (o *LogIndexObject) partitionRange(i int) (uint64, uint64) {
	return logPartitionRange(o.FirstBlock, o.LastBlock, o.PartitionBlocks, o.FirstBlock/o.PartitionBlocks+uint64(i))
}

func (o *LogIndexObject) entries() (n uint64) {
	for _, p := range o.Partitions {
		n += p.Entries
	}
	return n
}

func (o *LogIndexObject) keys() (n uint64) {
	for _, p := range o.Partitions {
		n += p.Keys
	}
	return n
}

// objects lists an object's files (all data objects).
func (o *LogIndexObject) objects() []streamObject {
	out := []streamObject{{ref: o.Directory}}
	for _, p := range o.Packs {
		out = append(out, streamObject{ref: p})
	}
	return out
}

func logAddressDigest(address []byte) [32]byte {
	return sha256.Sum256(append([]byte{0}, address...))
}

func logTopicDigest(position int, topic []byte) [32]byte {
	return sha256.Sum256(append([]byte{byte(1 + position)}, topic...))
}

// logPosting is one key's blocks in one partition, strictly increasing.
type logPosting struct {
	key    uint64
	blocks []uint64
}

// encodeLogBucket: per key, uvarint(key - previous key; the first from the
// bucket base), uvarint(blocks), uvarint(first block - lo), then
// uvarint(block - previous block - 1) for each further block.
func encodeLogBucket(postings []logPosting, base, lo uint64) []byte {
	var out []byte
	prev := base
	for _, p := range postings {
		out = binary.AppendUvarint(out, p.key-prev)
		out = binary.AppendUvarint(out, uint64(len(p.blocks)))
		for i, b := range p.blocks {
			if i == 0 {
				out = binary.AppendUvarint(out, b-lo)
			} else {
				out = binary.AppendUvarint(out, b-p.blocks[i-1]-1)
			}
		}
		prev = p.key
	}
	return out
}

// ---- writer ----

// logIndexWriter writes one object into a local archive tree, partition
// after partition: packs and the directory go to temporary files, so
// memory is one partition's directory plus a bucket.
type logIndexWriter struct {
	archive     localArchive
	prefix, tmp string
	first, last uint64
	size        uint64
	keyBytes    uint8
	target      uint64
	pack        *packWriter
	packIndex   int
	packs       []ObjectRef
	dir         *packWriter // the directory, without a pack header
	partitions  []LogIndexPartition
	open        bool
	lo, hi      uint64
	bits        uint8
	pdir        []byte
	bucket      uint64
	buf         []logPosting
	lastKey     uint64
	lastBlock   uint64
	hasLast     bool
	keys        uint64
	entries     uint64
	frameBytes  uint64
}

func newLogIndexWriter(archive localArchive, ns string, first, last uint64) *logIndexWriter {
	return &logIndexWriter{archive: archive,
		prefix: fmt.Sprintf("%s/log-index/%020d-%020d", ns, first, last),
		tmp:    archive.path(fmt.Sprintf("%s/.tmp/log-index-%020d-%020d", ns, first, last)),
		first:  first, last: last, size: logIndexPartitionBlocks, keyBytes: logIndexKeyBytes,
		target: logIndexBucketTarget, packs: []ObjectRef{}}
}

func (w *logIndexWriter) partitionCount() int { return logPartitionCount(w.first, w.last, w.size) }

// beginPartition starts the next partition; expected (an upper bound of its
// entries) sizes its buckets.
func (w *logIndexWriter) beginPartition(expected uint64) error {
	if w.open {
		return errors.New("a log index partition is open")
	}
	i := len(w.partitions)
	if i >= w.partitionCount() {
		return errors.New("too many log index partitions")
	}
	w.open, w.hasLast, w.keys, w.entries, w.buf = true, false, 0, 0, w.buf[:0]
	w.lo, w.hi = logPartitionRange(w.first, w.last, w.size, w.first/w.size+uint64(i))
	w.bits = bucketBitsFor(expected, w.target, w.keyBytes)
	w.pdir = make([]byte, hashIndexDirRecord<<w.bits)
	return nil
}

func (w *logIndexWriter) push(key, block uint64) error {
	if !w.open {
		return errors.New("no log index partition is open")
	}
	if w.hasLast && (key < w.lastKey || (key == w.lastKey && block <= w.lastBlock)) {
		return fmt.Errorf("log index entries out of order or duplicated at block %d", block)
	}
	if block < w.lo || block > w.hi {
		return fmt.Errorf("log index entry block %d outside %d-%d", block, w.lo, w.hi)
	}
	if w.keyBytes < 8 && key>>(uint(w.keyBytes)*8) != 0 {
		return errors.New("log index key wider than the key length")
	}
	b := bucketOf(key, w.keyBytes, w.bits)
	if b != w.bucket && len(w.buf) > 0 {
		if err := w.flushBucket(); err != nil {
			return err
		}
	}
	w.bucket = b
	if n := len(w.buf); n > 0 && w.buf[n-1].key == key {
		w.buf[n-1].blocks = append(w.buf[n-1].blocks, block)
	} else {
		w.buf = append(w.buf, logPosting{key: key, blocks: []uint64{block}})
		w.keys++
	}
	w.lastKey, w.lastBlock, w.hasLast = key, block, true
	w.entries++
	return nil
}

func (w *logIndexWriter) flushBucket() error {
	if len(w.buf) == 0 {
		return nil
	}
	plain := encodeLogBucket(w.buf, bucketBase(w.bucket, w.keyBytes, w.bits), w.lo)
	fr := compressFrame(plain)
	if w.pack != nil && w.pack.size > packHeader && int64(w.pack.size)+int64(len(fr.data)) > logIndexPackLimit {
		if err := w.closePack(); err != nil {
			return err
		}
	}
	if w.pack == nil {
		var err error
		if w.pack, err = newPackWriter(filepath.Join(w.tmp, fmt.Sprintf("pack-%04d", w.packIndex)), codecLogIndex); err != nil {
			return err
		}
	}
	if w.packIndex > 1<<16-1 {
		return errors.New("too many log index packs")
	}
	sum, _ := hex.DecodeString(fr.sha256)
	r := dirRecord{offset: w.pack.size, length: uint32(len(fr.data)), uncompressed: uint32(fr.uncompressed),
		count: uint32(len(w.buf)), pack: uint16(w.packIndex)}
	copy(r.sha256[:], sum)
	copy(w.pdir[w.bucket*hashIndexDirRecord:], r.encode())
	if _, err := w.pack.push(w.bucket, fr); err != nil {
		return err
	}
	w.frameBytes += uint64(len(fr.data))
	// Postings are rebuilt per bucket; drop them so their arrays are freed.
	clear(w.buf)
	w.buf = w.buf[:0]
	return nil
}

func (w *logIndexWriter) closePack() error {
	size, sum, err := w.pack.close()
	if err != nil {
		return err
	}
	ref, err := w.archive.adoptFile(fmt.Sprintf("%s/pack-%s.pack", w.prefix, sum), w.pack.path, size, sum)
	if err != nil {
		return err
	}
	w.packs = append(w.packs, ref)
	w.pack = nil
	w.packIndex++
	return nil
}

func (w *logIndexWriter) endPartition() error {
	if err := w.flushBucket(); err != nil {
		return err
	}
	if !w.open {
		return errors.New("no log index partition is open")
	}
	if w.dir == nil {
		if err := os.MkdirAll(w.tmp, 0o755); err != nil {
			return err
		}
		f, err := os.Create(filepath.Join(w.tmp, "directory"))
		if err != nil {
			return err
		}
		w.dir = &packWriter{path: f.Name(), f: f, sum: newHashWriter()}
	}
	if err := w.dir.write(w.pdir); err != nil {
		return err
	}
	w.partitions = append(w.partitions, LogIndexPartition{BucketBits: w.bits, Keys: w.keys, Entries: w.entries})
	w.open, w.pdir = false, nil
	return nil
}

func (w *logIndexWriter) finish() (LogIndexObject, error) {
	if w.open || len(w.partitions) != w.partitionCount() || w.dir == nil {
		return LogIndexObject{}, errors.New("log index partitions incomplete")
	}
	if w.pack != nil {
		if err := w.closePack(); err != nil {
			return LogIndexObject{}, err
		}
	}
	size, sum, err := w.dir.close()
	if err != nil {
		return LogIndexObject{}, err
	}
	dir, err := w.archive.adoptFile(fmt.Sprintf("%s/directory-%s.dir", w.prefix, sum), w.dir.path, size, sum)
	if err != nil {
		return LogIndexObject{}, err
	}
	os.RemoveAll(w.tmp)
	return LogIndexObject{FirstBlock: w.first, LastBlock: w.last, KeyBytes: w.keyBytes, PartitionBlocks: w.size,
		Partitions: w.partitions, Directory: dir, Packs: w.packs}, nil
}

// logEntry is one (key, block) of the index.
type logEntry struct{ key, block uint64 }

// ---- lookup (checks and tests) ----

// checkLogIndex validates the manifest's `log_index`.
func checkLogIndex(ns string, m *Manifest) error {
	x := m.LogIndex
	if x == nil {
		return nil
	}
	if x.KeyBytes != logIndexKeyBytes || len(x.Objects) > 1024 {
		return errors.New("unsupported log index")
	}
	prefix := ns + "/log-index/"
	for i, o := range x.Objects {
		if o.FirstBlock < m.FirstBlock || o.FirstBlock > o.LastBlock || o.LastBlock > m.ArchivedThrough.Number {
			return fmt.Errorf("log index object %d-%d outside the archived blocks", o.FirstBlock, o.LastBlock)
		}
		if i > 0 {
			p := x.Objects[i-1]
			if p.FirstBlock > o.FirstBlock || (p.FirstBlock == o.FirstBlock && p.LastBlock > o.LastBlock) {
				return errors.New("log index objects are not ordered")
			}
		}
		if o.KeyBytes < 4 || o.KeyBytes > 8 || o.PartitionBlocks < 1 || o.PartitionBlocks > logIndexMaxPartSz {
			return errors.New("invalid log index object")
		}
		n := logPartitionCount(o.FirstBlock, o.LastBlock, o.PartitionBlocks)
		if n > logIndexMaxParts || len(o.Partitions) != n {
			return errors.New("log index partitions do not match the object's blocks")
		}
		var dir uint64
		for j, p := range o.Partitions {
			lo, hi := o.partitionRange(j)
			if p.BucketBits > min(hashIndexMaxBits, o.KeyBytes*8) || p.Keys > p.Entries || (p.Keys == 0) != (p.Entries == 0) ||
				(p.Keys > 0 && p.Entries/p.Keys > hi-lo+1) {
				return errors.New("invalid log index partition")
			}
			dir += hashIndexDirRecord << p.BucketBits
		}
		if o.Directory.Bytes != dir || !strings.HasPrefix(o.Directory.Key, prefix) {
			return errors.New("invalid log index directory")
		}
		if len(o.Packs) > 1<<16 {
			return errors.New("too many log index packs")
		}
		for _, p := range o.Packs {
			if !strings.HasPrefix(p.Key, prefix) {
				return errors.New("log index pack outside the archive namespace")
			}
		}
		if (o.entries() == 0) != (len(o.Packs) == 0) {
			return errors.New("log index packs do not match its entries")
		}
	}
	return nil
}

// ---- builder from block records ----

type logIndexOptions struct {
	workers  int
	memory   int64  // sort arena bytes in total
	tmp      string // sort run directory
	from, to uint64 // index only these blocks
}

type logIndexStats struct {
	FirstBlock uint64  `json:"first_block"`
	LastBlock  uint64  `json:"last_block"`
	Bundles    int     `json:"bundles"`
	Blocks     uint64  `json:"blocks"`
	Logs       uint64  `json:"logs"`
	Entries    uint64  `json:"entries"`
	Keys       uint64  `json:"keys"`
	Partitions int     `json:"partitions"`
	ReadGB     float64 `json:"read_gb"`
	SortRunsGB float64 `json:"sort_runs_gb"`
	IndexGB    float64 `json:"index_gb"`
	Packs      int     `json:"packs"`
	ReadS      float64 `json:"read_s"`
	WriteS     float64 `json:"write_s"`
	TotalS     float64 `json:"total_s"`
	PeakRSSGB  float64 `json:"peak_rss_gb"`
}

// logSortKey: partition (4, relative to the object's first) | key (6) | block (5), big endian.
const logSortKey = 15

// blockRangeBytes bounds one range read of consecutive block frames.
const blockRangeBytes = 32 << 20

type logBuildCounters struct {
	read, blocks, logs, entries atomic.Uint64
	partitions                  []atomic.Uint64
}

// buildLogIndex builds the object for blocks opts.from..opts.to from the
// block records of bundles, read through src, into archive. Memory is
// bounded by opts.memory (sort arenas) plus one 32 MiB range of block
// frames per worker.
func buildLogIndex(src objectSource, archive localArchive, ns string, bundles []BundleRef, opts logIndexOptions) (LogIndexObject, logIndexStats, error) {
	started := time.Now()
	st := logIndexStats{FirstBlock: opts.from, LastBlock: opts.to}
	list, err := sortedBundles(bundles, opts.from, opts.to)
	if err != nil {
		return LogIndexObject{}, st, err
	}
	st.Bundles = len(list)
	workers := max(1, opts.workers)
	if err := os.MkdirAll(opts.tmp, 0o755); err != nil {
		return LogIndexObject{}, st, err
	}
	runDir, err := os.MkdirTemp(opts.tmp, "log-index-sort-")
	if err != nil {
		return LogIndexObject{}, st, err
	}
	defer os.RemoveAll(runDir)
	size := logIndexPartitionBlocks
	parts := logPartitionCount(opts.from, opts.to, size)
	if parts > logIndexMaxParts {
		return LogIndexObject{}, st, fmt.Errorf("%d partitions exceed the format's %d", parts, logIndexMaxParts)
	}
	c := &logBuildCounters{partitions: make([]atomic.Uint64, parts)}
	per := max(opts.memory/int64(workers), 4096)
	sorters := make([]*extSorter, workers)
	for i := range workers {
		sorters[i] = newExtSorterKey(runDir, int(per), logSortKey)
	}
	jobs := make(chan BundleRef)
	errs := make(chan error, workers)
	var done atomic.Uint64
	var wg sync.WaitGroup
	for i := range workers {
		wg.Add(1)
		go func(s *extSorter) {
			defer wg.Done()
			var failed error
			for b := range jobs {
				if failed != nil {
					continue
				}
				failed = addBundleLogs(src, b, opts.from, opts.to, s, c)
				if n := done.Add(1); failed == nil && (n%64 == 0 || int(n) == len(list)) {
					fmt.Fprintf(os.Stderr, "{\"log_index_read\":%d,\"bundles\":%d,\"blocks\":%d,\"logs\":%d,\"entries\":%d,\"gb\":%.2f,\"s\":%.0f}\n",
						n, len(list), c.blocks.Load(), c.logs.Load(), c.entries.Load(), float64(c.read.Load())/1e9, time.Since(started).Seconds())
				}
			}
			errs <- failed
		}(sorters[i])
	}
	for _, b := range list {
		jobs <- b
	}
	close(jobs)
	wg.Wait()
	close(errs)
	for e := range errs {
		if e != nil {
			return LogIndexObject{}, st, e
		}
	}
	st.ReadGB, st.Blocks, st.Logs, st.Entries = float64(c.read.Load())/1e9, c.blocks.Load(), c.logs.Load(), c.entries.Load()
	if st.Blocks != opts.to-opts.from+1 {
		return LogIndexObject{}, st, fmt.Errorf("bundles hold %d blocks of the range, it has %d", st.Blocks, opts.to-opts.from+1)
	}
	st.ReadS = time.Since(started).Seconds()
	t0 := time.Now()
	for _, s := range sorters {
		st.SortRunsGB += float64(s.runBytes) / 1e9
	}
	w := newLogIndexWriter(archive, ns, opts.from, opts.to)
	next := 0
	advance := func(to int) error {
		for ; next <= to; next++ {
			if next > 0 {
				if err := w.endPartition(); err != nil {
					return err
				}
			}
			if err := w.beginPartition(c.partitions[next].Load()); err != nil {
				return err
			}
		}
		return nil
	}
	var prev [logSortKey]byte
	first := true
	err = mergeSorted(sorters, func(k, _ []byte) error {
		// Equal keys (a 6-byte prefix shared by two fields of a block) are one entry.
		if !first && string(prev[:]) == string(k) {
			return nil
		}
		copy(prev[:], k)
		first = false
		if err := advance(int(binary.BigEndian.Uint32(k[:4]))); err != nil {
			return err
		}
		return w.push(hashKey(k[4:10], logIndexKeyBytes), getUint40(k[10:15]))
	})
	if err == nil {
		err = advance(parts - 1)
	}
	if err == nil {
		err = w.endPartition()
	}
	if err != nil {
		return LogIndexObject{}, st, err
	}
	for _, s := range sorters {
		s.release()
	}
	obj, err := w.finish()
	if err != nil {
		return obj, st, err
	}
	st.Keys, st.Entries, st.Partitions, st.Packs = obj.keys(), obj.entries(), len(obj.Partitions), len(obj.Packs)
	for _, o := range obj.objects() {
		st.IndexGB += float64(o.ref.Bytes) / 1e9
	}
	st.WriteS, st.TotalS, st.PeakRSSGB = time.Since(t0).Seconds(), time.Since(started).Seconds(), rssGB()
	return obj, st, nil
}

// addBundleLogs adds the (partition, key, block) records of one bundle's
// blocks in from..to: blocks.pack is read in ranges of consecutive frames,
// each frame checked against its offsets.bin record (SHA-256, length, and
// the decoded header's hash and number).
func addBundleLogs(src objectSource, b BundleRef, from, to uint64, s *extSorter, c *logBuildCounters) error {
	meta, err := readBundleMeta(src, b)
	if err != nil {
		return err
	}
	offRef, ok1 := meta.Files["offsets.bin"]
	packRef, ok2 := meta.Files["blocks.pack"]
	if !ok1 || !ok2 {
		return fmt.Errorf("bundle %d-%d lacks offsets.bin or blocks.pack", b.FirstBlock, b.LastBlock)
	}
	offsets, err := src.get(offRef.Key)
	if err != nil {
		return err
	}
	n := b.LastBlock - b.FirstBlock + 1
	if uint64(len(offsets)) != offRef.Bytes || sha256Hex(offsets) != offRef.Sha256 || uint64(len(offsets)) != n*80 {
		return fmt.Errorf("%s does not match its reference", offRef.Key)
	}
	c.read.Add(uint64(len(offsets)))
	type rec struct {
		number               uint64
		hash                 []byte
		offset               uint64
		length, uncompressed uint32
		sha256               []byte
	}
	var recs []rec
	for i := uint64(0); i < n; i++ {
		number := b.FirstBlock + i
		if number < from || number > to {
			continue
		}
		o := offsets[i*80 : (i+1)*80]
		r := rec{number: number, hash: o[:32], offset: binary.LittleEndian.Uint64(o[32:]),
			length: binary.LittleEndian.Uint32(o[40:]), uncompressed: binary.LittleEndian.Uint32(o[44:]), sha256: o[48:80]}
		if r.offset < packHeader || r.offset+uint64(r.length) > packRef.Bytes || r.length == 0 {
			return fmt.Errorf("block %d frame outside %s", number, packRef.Key)
		}
		recs = append(recs, r)
	}
	dec := hashIndexDecoders.Get().(*zstd.Decoder)
	defer hashIndexDecoders.Put(dec)
	k := newKeccak()
	firstPartition := from / logIndexPartitionBlocks
	var key [logSortKey]byte
	var keys []uint64
	for start := 0; start < len(recs); {
		// Consecutive frames up to blockRangeBytes (a frame larger than that alone).
		end := start + 1
		for end < len(recs) && recs[end].offset == recs[end-1].offset+uint64(recs[end-1].length) &&
			recs[end].offset+uint64(recs[end].length)-recs[start].offset <= blockRangeBytes {
			end++
		}
		lo := recs[start].offset
		hi := recs[end-1].offset + uint64(recs[end-1].length)
		data, err := src.getRange(packRef.Key, lo, hi-lo)
		if err != nil {
			return err
		}
		c.read.Add(hi - lo)
		for _, r := range recs[start:end] {
			fr := data[r.offset-lo : r.offset-lo+uint64(r.length)]
			if sum := sha256.Sum256(fr); string(sum[:]) != string(r.sha256) {
				return fmt.Errorf("block %d frame checksum mismatch", r.number)
			}
			plain, err := dec.DecodeAll(fr, make([]byte, 0, r.uncompressed))
			if err != nil || uint32(len(plain)) != r.uncompressed {
				return fmt.Errorf("block %d frame does not decode", r.number)
			}
			keys = keys[:0]
			logs, err := recordLogs(plain, k, r.hash, r.number, func(address []byte, topics [][]byte) {
				d := logAddressDigest(address)
				keys = append(keys, hashKey(d[:], logIndexKeyBytes))
				for i, t := range topics {
					d := logTopicDigest(i, t)
					keys = append(keys, hashKey(d[:], logIndexKeyBytes))
				}
			})
			if err != nil {
				return err
			}
			c.logs.Add(logs)
			c.blocks.Add(1)
			sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
			p := r.number/logIndexPartitionBlocks - firstPartition
			binary.BigEndian.PutUint32(key[:4], uint32(p))
			putUint40(key[10:15], r.number)
			var added uint64
			for i, kk := range keys {
				if i > 0 && kk == keys[i-1] {
					continue
				}
				key[4], key[5], key[6], key[7], key[8], key[9] = byte(kk>>40), byte(kk>>32), byte(kk>>24), byte(kk>>16), byte(kk>>8), byte(kk)
				if err := s.add(key[:], nil); err != nil {
					return err
				}
				added++
			}
			c.entries.Add(added)
			c.partitions[p].Add(added)
		}
		start = end
	}
	return nil
}

// recordLogs decodes a block record (docs/storage.md, "Block
// records"), checks its header hash and number, and calls fn with every
// log's address and topics. It returns the number of logs.
func recordLogs(plain []byte, k *keccak, hash []byte, number uint64, fn func(address []byte, topics [][]byte)) (uint64, error) {
	fail := func(format string, a ...any) (uint64, error) {
		return 0, fmt.Errorf("block %d record: %s", number, fmt.Sprintf(format, a...))
	}
	items, err := rlpListItems(plain)
	if err != nil || len(items) != 5 {
		return fail("not an RLP list of 5 items")
	}
	raw, list, _, _, err := rlpItem(items[0])
	if err != nil || list {
		return fail("raw block is not a byte string")
	}
	fields, err := rlpListItems(raw)
	if err != nil || len(fields) < 3 {
		return fail("raw block is not an RLP block")
	}
	if h := k.sum(fields[0]); string(h[:]) != string(hash) {
		return fail("header hash differs from its offsets record")
	}
	header, err := rlpListItems(fields[0])
	if err != nil || len(header) < 9 {
		return fail("header is not an RLP list")
	}
	if got, err := rlpUint64(header[8]); err != nil || got != number {
		return fail("header number %d", got)
	}
	receipts, err := rlpListItems(items[2])
	if err != nil {
		return fail("receipts: %v", err)
	}
	var logs uint64
	for i, rc := range receipts {
		parts, err := rlpListItems(rc)
		if err != nil || len(parts) != 4 {
			return fail("receipt %d is not a list of 4 items", i)
		}
		entries, err := rlpListItems(parts[3])
		if err != nil {
			return fail("receipt %d logs: %v", i, err)
		}
		for j, l := range entries {
			lp, err := rlpListItems(l)
			if err != nil || len(lp) != 3 {
				return fail("receipt %d log %d is not a list of 3 items", i, j)
			}
			address, list, _, _, err := rlpItem(lp[0])
			if err != nil || list || len(address) != 20 {
				return fail("receipt %d log %d address", i, j)
			}
			ts, err := rlpListItems(lp[1])
			if err != nil || len(ts) > 4 {
				return fail("receipt %d log %d topics", i, j)
			}
			topics := make([][]byte, len(ts))
			for t, item := range ts {
				if topics[t], err = rlpHash(item); err != nil {
					return fail("receipt %d log %d topic %d", i, j, t)
				}
			}
			fn(address, topics)
			logs++
		}
	}
	return logs, nil
}

// ---- pipeline stage ----

// logIndexStateFile is the pipeline's log index (WORK/log-index.json).
const logIndexStateFile = "log-index.json"

// logIndexStage builds the index of blocks 0..tip from the bundles of
// bundles.json; a streaming run uploads it and removes the local copy.
func logIndexStage(w *workDir) error {
	layer, bundles := w.layerAndBundles()
	if layer == nil || len(bundles) == 0 {
		return errors.New("block bundles missing")
	}
	src := layeredSource{local: localSource{w.archive()}}
	var target *streamTarget
	if w.opts.stream {
		var err error
		if target, err = w.streamTarget(); err != nil {
			return err
		}
		src.remote = s3Source{target.client, target.bucket}
	}
	tmp := w.at("log-index.tmp")
	if w.opts.tmp != "" {
		abs, _ := filepath.Abs(w.root)
		tmp = filepath.Join(w.opts.tmp, "nullrpc-log-index-"+sha256Hex([]byte(abs))[:12]+".tmp")
	}
	defer os.RemoveAll(tmp)
	obj, st, err := buildLogIndex(src, w.archive(), w.namespace, bundles, logIndexOptions{
		workers: max(1, runtime.NumCPU()/2), memory: 2 << 30, tmp: tmp, from: 0, to: layer.LastBlock})
	if err != nil {
		return err
	}
	line, _ := json.Marshal(st)
	fmt.Fprintln(os.Stderr, string(line))
	if target != nil {
		sst, err := target.put(context.Background(), w.archive(), obj.objects())
		if err != nil {
			return err
		}
		fmt.Fprintln(os.Stderr, describeStreamStats("log index", sst))
	}
	data, _ := json.MarshalIndent(logIndexState{Object: obj, Stats: st}, "", "  ")
	if err := os.WriteFile(w.at(logIndexStateFile+".tmp"), data, 0o644); err != nil {
		return err
	}
	return os.Rename(w.at(logIndexStateFile+".tmp"), w.at(logIndexStateFile))
}

// logIndexState is OUT/{generation}/log-index.json: the object built for a
// published manifest, so a rerun (or --publish later) reuses it.
type logIndexState struct {
	Manifest   ObjectRef      `json:"manifest"`
	Generation uint64         `json:"generation"`
	Object     LogIndexObject `json:"object"`
	Stats      logIndexStats  `json:"stats"`
}

// ---- readers and in-memory writers (promotion and merges) ----

func decodeLogBucket(plain []byte, count uint32, keyBytes, bits uint8, bucket, lo, hi uint64) ([]logPosting, error) {
	key := bucketBase(bucket, keyBytes, bits)
	at := 0
	out := make([]logPosting, 0, min(count, 1<<16))
	for i := uint32(0); i < count; i++ {
		d, err := readUvarint(plain, &at)
		if err != nil {
			return nil, err
		}
		if i > 0 && d == 0 {
			return nil, errors.New("log index keys out of order")
		}
		key += d
		if (keyBytes < 8 && key>>(uint(keyBytes)*8) != 0) || bucketOf(key, keyBytes, bits) != bucket {
			return nil, errors.New("log index key outside its bucket")
		}
		n, err := readUvarint(plain, &at)
		if err != nil {
			return nil, err
		}
		if n == 0 || n > hi-lo+1 {
			return nil, errors.New("log index posting length out of range")
		}
		p := logPosting{key: key, blocks: make([]uint64, 0, n)}
		block := lo
		for j := uint64(0); j < n; j++ {
			step, err := readUvarint(plain, &at)
			if err != nil {
				return nil, err
			}
			if j == 0 {
				block = lo + step
			} else {
				block += step + 1
			}
			if block > hi || block < lo {
				return nil, errors.New("log index block outside its partition")
			}
			p.blocks = append(p.blocks, block)
		}
		out = append(out, p)
	}
	if at != len(plain) {
		return nil, errors.New("trailing data in log index frame")
	}
	return out, nil
}

// writeLogIndexEntries writes an object from entries held in memory.
func writeLogIndexEntries(archive localArchive, ns string, first, last uint64, entries []logEntry) (LogIndexObject, error) {
	w := newLogIndexWriter(archive, ns, first, last)
	size := w.size
	sort.Slice(entries, func(i, j int) bool {
		a, b := entries[i], entries[j]
		if a.block/size != b.block/size {
			return a.block/size < b.block/size
		}
		if a.key != b.key {
			return a.key < b.key
		}
		return a.block < b.block
	})
	at := 0
	for i := range w.partitionCount() {
		p := first/size + uint64(i)
		end := at
		for end < len(entries) && entries[end].block/size == p {
			end++
		}
		if err := w.beginPartition(uint64(end - at)); err != nil {
			return LogIndexObject{}, err
		}
		for k := at; k < end; k++ {
			if k > at && entries[k] == entries[k-1] {
				continue
			}
			if err := w.push(entries[k].key, entries[k].block); err != nil {
				return LogIndexObject{}, err
			}
		}
		if err := w.endPartition(); err != nil {
			return LogIndexObject{}, err
		}
		at = end
	}
	if at != len(entries) {
		return LogIndexObject{}, errors.New("log index entries outside the object's blocks")
	}
	return w.finish()
}

func readLogIndexFrame(src objectSource, o *LogIndexObject, r dirRecord) ([]byte, error) {
	if int(r.pack) >= len(o.Packs) || r.offset < packHeader || r.offset+uint64(r.length) > o.Packs[r.pack].Bytes {
		return nil, errors.New("log index frame outside its pack")
	}
	data, err := src.getRange(o.Packs[r.pack].Key, r.offset, uint64(r.length))
	if err != nil {
		return nil, err
	}
	return decodeHashIndexFrame(data, r)
}

// readLogIndexEntries reads every (key, block) of o, partition by partition.
func readLogIndexEntries(src objectSource, o *LogIndexObject) ([]logEntry, error) {
	dir, err := src.get(o.Directory.Key)
	if err != nil {
		return nil, err
	}
	if uint64(len(dir)) != o.Directory.Bytes || sha256Hex(dir) != o.Directory.Sha256 {
		return nil, fmt.Errorf("%s does not match its reference", o.Directory.Key)
	}
	var out []logEntry
	for i, p := range o.Partitions {
		off := o.directoryOffset(i)
		lo, hi := o.partitionRange(i)
		var n uint64
		for b := uint64(0); b < 1<<p.BucketBits; b++ {
			at := off + b*hashIndexDirRecord
			r, err := decodeDirRecord(dir[at : at+hashIndexDirRecord])
			if err != nil {
				return nil, err
			}
			if r.count == 0 {
				continue
			}
			plain, err := readLogIndexFrame(src, o, r)
			if err != nil {
				return nil, err
			}
			ps, err := decodeLogBucket(plain, r.count, o.KeyBytes, p.BucketBits, b, lo, hi)
			if err != nil {
				return nil, err
			}
			for _, posting := range ps {
				for _, blk := range posting.blocks {
					out = append(out, logEntry{posting.key, blk})
					n++
				}
			}
		}
		if n != p.Entries {
			return nil, fmt.Errorf("log index partition %d has %d entries, its reference %d", i, n, p.Entries)
		}
	}
	return out, nil
}

func (o *LogIndexObject) directoryOffset(i int) uint64 {
	var off uint64
	for _, p := range o.Partitions[:i] {
		off += hashIndexDirRecord << p.BucketBits
	}
	return off
}
