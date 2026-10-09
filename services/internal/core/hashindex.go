package core

// Hash index (docs/storage.md, "Hash index"). An index object covers a block range; each
// of its two parts (transactions, blocks) is a directory of 56-byte bucket records and one
// zstd frame per non-empty bucket, in packs.
//
// buildHashIndex builds one object from the entries each segment spilled while it was
// written (hashes.go), with a bounded-memory external sort (extsort.go).

import (
	"context"
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
	hashIndexFormat    = 1
	hashIndexKeyBytes  = 6 // stored hash prefix: N entries give ~N/2^48 false candidates per lookup
	hashIndexDirRecord = 56
	hashIndexMaxBits   = 24
)

var (
	// Writers choose the fewest bucket bits that keep the average bucket at
	// or below this many entries (about 16 KiB of frame). Tests lower it.
	hashIndexBucketTarget uint64 = 2048
	// Packs rotate at this size. Tests lower it.
	hashIndexPackLimit int64 = 1 << 30
)

type HashIndexPart struct {
	BucketBits uint8     `json:"bucket_bits"`
	Entries    uint64    `json:"entries"`
	Directory  ObjectRef `json:"directory"`
}

type HashIndexObject struct {
	FirstBlock   uint64        `json:"first"`
	LastBlock    uint64        `json:"last"`
	KeyBytes     uint8         `json:"-"` // the manifest's hash_index.key_bytes
	Transactions HashIndexPart `json:"transactions"`
	Blocks       HashIndexPart `json:"blocks"`
	Packs        []ObjectRef   `json:"packs"`
}

type HashIndex struct {
	KeyBytes uint8             `json:"key_bytes"`
	Objects  []HashIndexObject `json:"objects"`
}

// hashEntry: a hash's key prefix, its block and (transactions) its index.
type hashEntry struct {
	key, block uint64
	index      uint32
}

func (a hashEntry) less(b hashEntry) bool {
	if a.key != b.key {
		return a.key < b.key
	}
	if a.block != b.block {
		return a.block < b.block
	}
	return a.index < b.index
}

func hashKey(hash []byte, keyBytes uint8) uint64 {
	var k uint64
	for _, b := range hash[:keyBytes] {
		k = k<<8 | uint64(b)
	}
	return k
}

func bucketOf(key uint64, keyBytes, bits uint8) uint64 {
	if bits == 0 {
		return 0
	}
	return key >> (uint(keyBytes)*8 - uint(bits))
}

func bucketBase(bucket uint64, keyBytes, bits uint8) uint64 {
	if bits == 0 {
		return 0
	}
	return bucket << (uint(keyBytes)*8 - uint(bits))
}

func bucketBitsFor(entries, target uint64, keyBytes uint8) uint8 {
	bits := uint8(0)
	for bits < min(hashIndexMaxBits, keyBytes*8) && entries>>bits > max(target, 1) {
		bits++
	}
	return bits
}

type dirRecord struct {
	offset                      uint64
	length, uncompressed, count uint32
	pack                        uint16
	sha256                      [32]byte
}

func (r dirRecord) encode() []byte {
	out := make([]byte, hashIndexDirRecord)
	binary.LittleEndian.PutUint64(out, r.offset)
	binary.LittleEndian.PutUint32(out[8:], r.length)
	binary.LittleEndian.PutUint32(out[12:], r.uncompressed)
	binary.LittleEndian.PutUint32(out[16:], r.count)
	binary.LittleEndian.PutUint16(out[20:], r.pack)
	copy(out[24:], r.sha256[:])
	return out
}

// encodeBucket: per entry, uvarint(key - previous key; the first from the
// bucket base), uvarint(block - first block), and for transactions uvarint(index).
func encodeBucket(entries []hashEntry, base, firstBlock uint64, tx bool) []byte {
	out := make([]byte, 0, len(entries)*9)
	prev := base
	for _, e := range entries {
		out = binary.AppendUvarint(out, e.key-prev)
		out = binary.AppendUvarint(out, e.block-firstBlock)
		if tx {
			out = binary.AppendUvarint(out, uint64(e.index))
		}
		prev = e.key
	}
	return out
}

// ---- writer ----

// hashIndexWriter writes one object into a local archive tree: packs to
// temporary files (rotated at hashIndexPackLimit), directories in memory.
type hashIndexWriter struct {
	archive      localArchive
	prefix, tmp  string
	first, last  uint64
	keyBytes     uint8
	target       uint64
	pack         *packWriter
	packIndex    int
	packs        []ObjectRef
	open         bool
	tx           bool
	bits         uint8
	dir          []byte
	bucket       uint64
	buf          []hashEntry
	lastEntry    hashEntry
	hasLast      bool
	entries      uint64
	parts        [2]*HashIndexPart // transactions, blocks
	frameBytes   uint64
	nonEmptyBkts uint64
}

func newHashIndexWriter(archive localArchive, ns string, first, last uint64) *hashIndexWriter {
	prefix := fmt.Sprintf("%s/hash-index/%020d-%020d", ns, first, last)
	return &hashIndexWriter{archive: archive, prefix: prefix,
		tmp:   archive.path(fmt.Sprintf("%s/.tmp/hash-index-%020d-%020d", ns, first, last)),
		first: first, last: last, keyBytes: hashIndexKeyBytes, target: hashIndexBucketTarget, packs: []ObjectRef{}}
}

func (w *hashIndexWriter) begin(tx bool, expected uint64) {
	w.open, w.tx, w.hasLast, w.entries, w.buf = true, tx, false, 0, w.buf[:0]
	w.bits = bucketBitsFor(expected, w.target, w.keyBytes)
	w.dir = make([]byte, hashIndexDirRecord<<w.bits)
}

func (w *hashIndexWriter) push(e hashEntry) error {
	if !w.open {
		return errors.New("no hash index part is open")
	}
	if w.hasLast && !w.lastEntry.less(e) {
		return fmt.Errorf("hash index entries out of order or duplicated at block %d", e.block)
	}
	if e.block < w.first || e.block > w.last {
		return fmt.Errorf("hash index entry block %d outside %d-%d", e.block, w.first, w.last)
	}
	if w.keyBytes < 8 && e.key>>(uint(w.keyBytes)*8) != 0 {
		return errors.New("hash index key wider than the key length")
	}
	b := bucketOf(e.key, w.keyBytes, w.bits)
	if b != w.bucket && len(w.buf) > 0 {
		if err := w.flushBucket(); err != nil {
			return err
		}
	}
	w.bucket = b
	w.buf = append(w.buf, e)
	w.lastEntry, w.hasLast = e, true
	w.entries++
	return nil
}

func (w *hashIndexWriter) flushBucket() error {
	if len(w.buf) == 0 {
		return nil
	}
	plain := encodeBucket(w.buf, bucketBase(w.bucket, w.keyBytes, w.bits), w.first, w.tx)
	fr := compressFrame(plain)
	if w.pack != nil && w.pack.size > packHeader && int64(w.pack.size)+int64(len(fr.data)) > hashIndexPackLimit {
		if err := w.closePack(); err != nil {
			return err
		}
	}
	if w.pack == nil {
		var err error
		if w.pack, err = newPackWriter(filepath.Join(w.tmp, fmt.Sprintf("pack-%04d", w.packIndex)), codecHashIndex); err != nil {
			return err
		}
	}
	if w.packIndex > 1<<16-1 {
		return errors.New("too many hash index packs")
	}
	sum, _ := hex.DecodeString(fr.sha256)
	r := dirRecord{offset: w.pack.size, length: uint32(len(fr.data)), uncompressed: uint32(fr.uncompressed),
		count: uint32(len(w.buf)), pack: uint16(w.packIndex)}
	copy(r.sha256[:], sum)
	copy(w.dir[w.bucket*hashIndexDirRecord:], r.encode())
	if _, err := w.pack.push(w.bucket, fr); err != nil {
		return err
	}
	w.frameBytes += uint64(len(fr.data))
	w.nonEmptyBkts++
	w.buf = w.buf[:0]
	return nil
}

func (w *hashIndexWriter) closePack() error {
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

func (w *hashIndexWriter) end() error {
	if err := w.flushBucket(); err != nil {
		return err
	}
	name, slot := "blocks", 1
	if w.tx {
		name, slot = "transactions", 0
	}
	if w.parts[slot] != nil {
		return errors.New("hash index part written twice")
	}
	ref, err := w.archive.putBytes(fmt.Sprintf("%s/%s-%s.dir", w.prefix, name, sha256Hex(w.dir)), w.dir)
	if err != nil {
		return err
	}
	w.parts[slot] = &HashIndexPart{BucketBits: w.bits, Entries: w.entries, Directory: ref}
	w.open, w.dir = false, nil
	return nil
}

func (w *hashIndexWriter) finish() (HashIndexObject, error) {
	if w.open || w.parts[0] == nil || w.parts[1] == nil {
		return HashIndexObject{}, errors.New("hash index parts incomplete")
	}
	if w.pack != nil {
		if err := w.closePack(); err != nil {
			return HashIndexObject{}, err
		}
	}
	os.RemoveAll(w.tmp)
	return HashIndexObject{FirstBlock: w.first, LastBlock: w.last, KeyBytes: w.keyBytes,
		Transactions: *w.parts[0], Blocks: *w.parts[1], Packs: w.packs}, nil
}

// ---- lookup (checks and tests) ----

var hashIndexDecoders = sync.Pool{New: func() any {
	d, err := zstd.NewReader(nil, zstd.WithDecoderConcurrency(1), zstd.WithDecoderMaxMemory(1<<30))
	if err != nil {
		panic(err)
	}
	return d
}}

// checkHashIndex validates the manifest's `hash_index`.
func checkHashIndex(ns string, m *Manifest) error {
	h := m.HashIndex
	if h == nil {
		return nil
	}
	if h.KeyBytes != hashIndexKeyBytes || len(h.Objects) > 1024 {
		return errors.New("unsupported hash index")
	}
	prefix := ns + "/hash-index/"
	for i, o := range h.Objects {
		if o.FirstBlock < m.FirstBlock || o.FirstBlock > o.LastBlock || o.LastBlock > m.ArchivedThrough.Number {
			return fmt.Errorf("hash index object %d-%d outside the archived blocks", o.FirstBlock, o.LastBlock)
		}
		if i > 0 {
			p := h.Objects[i-1]
			if p.FirstBlock > o.FirstBlock || (p.FirstBlock == o.FirstBlock && p.LastBlock > o.LastBlock) {
				return errors.New("hash index objects are not ordered")
			}
		}
		if o.KeyBytes < 4 || o.KeyBytes > 8 || len(o.Packs) > 1<<16 {
			return errors.New("invalid hash index object")
		}
		for _, p := range []HashIndexPart{o.Transactions, o.Blocks} {
			if p.BucketBits > min(hashIndexMaxBits, o.KeyBytes*8) || p.Directory.Bytes != hashIndexDirRecord<<p.BucketBits ||
				!strings.HasPrefix(p.Directory.Key, prefix) {
				return errors.New("invalid hash index directory")
			}
		}
		for _, p := range o.Packs {
			if !strings.HasPrefix(p.Key, prefix) {
				return errors.New("hash index pack outside the archive namespace")
			}
		}
		if (o.Transactions.Entries+o.Blocks.Entries == 0) != (len(o.Packs) == 0) {
			return errors.New("hash index packs do not match its entries")
		}
	}
	return nil
}

// objectsOf lists an object's files (all data objects).
func (o *HashIndexObject) objects() []streamObject {
	out := []streamObject{{ref: o.Transactions.Directory}, {ref: o.Blocks.Directory}}
	for _, p := range o.Packs {
		out = append(out, streamObject{ref: p})
	}
	return out
}

// ---- builder from the spilled entries ----

type hashIndexOptions struct {
	workers  int
	memory   int64  // sort arena bytes in total
	tmp      string // sort run directory
	from, to uint64 // index only these blocks
	spill    string // the chunks' spilled entries (hashes.go)
}

type hashIndexStats struct {
	FirstBlock   uint64  `json:"first_block"`
	LastBlock    uint64  `json:"last_block"`
	Bundles      int     `json:"bundles"`
	Transactions uint64  `json:"transactions"`
	Blocks       uint64  `json:"blocks"`
	ReadGB       float64 `json:"read_gb"`
	SortRunsGB   float64 `json:"sort_runs_gb"`
	IndexGB      float64 `json:"index_gb"`
	Packs        int     `json:"packs"`
	TxBucketBits uint8   `json:"transaction_bucket_bits"`
	ReadS        float64 `json:"read_s"`
	WriteS       float64 `json:"write_s"`
	TotalS       float64 `json:"total_s"`
}

const (
	txSortKey    = 14 // key (6) | block (5) | index (3), big endian
	blockSortKey = 11 // key (6) | block (5)
)

func putUint40(b []byte, v uint64) {
	b[0], b[1], b[2], b[3], b[4] = byte(v>>32), byte(v>>24), byte(v>>16), byte(v>>8), byte(v)
}
func getUint40(b []byte) uint64 {
	return uint64(b[0])<<32 | uint64(b[1])<<24 | uint64(b[2])<<16 | uint64(b[3])<<8 | uint64(b[4])
}

func readBundleMeta(src objectSource, ref BundleRef) (*BundleMetadata, error) {
	raw, err := src.get(ref.Metadata.Key)
	if err != nil {
		return nil, err
	}
	if uint64(len(raw)) != ref.Metadata.Bytes || sha256Hex(raw) != ref.Metadata.Sha256 {
		return nil, fmt.Errorf("%s does not match its reference", ref.Metadata.Key)
	}
	var meta BundleMetadata
	if err := json.Unmarshal(raw, &meta); err != nil {
		return nil, err
	}
	if meta.First != ref.FirstBlock || meta.Last != ref.LastBlock || meta.LastHash != ref.LastBlockHash {
		return nil, fmt.Errorf("%s does not describe bundle %d-%d", ref.Metadata.Key, ref.FirstBlock, ref.LastBlock)
	}
	return &meta, nil
}

// sortedBundles orders bundles and checks they cover from..to contiguously.
func sortedBundles(bundles []BundleRef, from, to uint64) ([]BundleRef, error) {
	all := append([]BundleRef{}, bundles...)
	sort.Slice(all, func(i, j int) bool { return all[i].FirstBlock < all[j].FirstBlock })
	var out []BundleRef
	next := from
	for _, b := range all {
		if b.LastBlock < from || b.FirstBlock > to {
			continue
		}
		if b.FirstBlock > next || (len(out) > 0 && b.FirstBlock != next) {
			return nil, fmt.Errorf("bundles do not cover block %d", next)
		}
		out = append(out, b)
		next = b.LastBlock + 1
	}
	if len(out) == 0 || next <= to {
		return nil, fmt.Errorf("bundles do not cover blocks %d-%d", from, to)
	}
	return out, nil
}

// buildHashIndex builds the object for blocks opts.from..opts.to from the segments' spilled
// entries, into archive. Memory is bounded by opts.memory (sort arenas).
func buildHashIndex(src objectSource, archive localArchive, ns string, bundles []BundleRef, opts hashIndexOptions) (HashIndexObject, hashIndexStats, error) {
	started := time.Now()
	st := hashIndexStats{FirstBlock: opts.from, LastBlock: opts.to}
	list, err := sortedBundles(bundles, opts.from, opts.to)
	if err != nil {
		return HashIndexObject{}, st, err
	}
	st.Bundles = len(list)
	workers := max(1, opts.workers)
	if err := os.MkdirAll(opts.tmp, 0o755); err != nil {
		return HashIndexObject{}, st, err
	}
	runDir, err := os.MkdirTemp(opts.tmp, "hash-index-sort-")
	if err != nil {
		return HashIndexObject{}, st, err
	}
	defer os.RemoveAll(runDir)
	per := max(opts.memory/int64(workers), 4096)
	txSorters := make([]*extSorter, workers)
	blockSorters := make([]*extSorter, workers)
	for i := range workers {
		txSorters[i] = newExtSorterKey(runDir, int(per*7/8), txSortKey)
		blockSorters[i] = newExtSorterKey(runDir, int(per/8), blockSortKey)
	}
	var readBytes, txCount, blockCount, done atomic.Uint64
	jobs := make(chan BundleRef)
	errs := make(chan error, workers)
	var wg sync.WaitGroup
	for i := range workers {
		wg.Add(1)
		go func(txs, blks *extSorter) {
			defer wg.Done()
			var failed error
			for b := range jobs {
				if failed != nil {
					continue
				}
				failed = addBundleEntries(opts.spill, b, opts.from, opts.to, txs, blks, &readBytes, &txCount, &blockCount)
				if n := done.Add(1); failed == nil && (n%256 == 0 || int(n) == len(list)) {
					fmt.Fprintf(os.Stderr, "{\"hash_index_read\":%d,\"bundles\":%d,\"transactions\":%d,\"gb\":%.2f,\"s\":%.0f}\n",
						n, len(list), txCount.Load(), float64(readBytes.Load())/1e9, time.Since(started).Seconds())
				}
			}
			errs <- failed
		}(txSorters[i], blockSorters[i])
	}
	for _, b := range list {
		jobs <- b
	}
	close(jobs)
	wg.Wait()
	close(errs)
	for e := range errs {
		if e != nil {
			return HashIndexObject{}, st, e
		}
	}
	st.ReadGB, st.Transactions, st.Blocks = float64(readBytes.Load())/1e9, txCount.Load(), blockCount.Load()
	if st.Blocks != opts.to-opts.from+1 {
		return HashIndexObject{}, st, fmt.Errorf("spilled entries list %d blocks, the range has %d", st.Blocks, opts.to-opts.from+1)
	}
	st.ReadS = time.Since(started).Seconds()
	t0 := time.Now()
	for _, s := range append(append([]*extSorter{}, txSorters...), blockSorters...) {
		st.SortRunsGB += float64(s.runBytes) / 1e9
	}
	w := newHashIndexWriter(archive, ns, opts.from, opts.to)
	for _, part := range []struct {
		tx      bool
		sorters []*extSorter
		count   uint64
	}{{true, txSorters, st.Transactions}, {false, blockSorters, st.Blocks}} {
		w.begin(part.tx, part.count)
		err := mergeSorted(part.sorters, func(k, _ []byte) error {
			e := hashEntry{key: hashKey(k, hashIndexKeyBytes), block: getUint40(k[6:11])}
			if part.tx {
				e.index = uint32(k[11])<<16 | uint32(k[12])<<8 | uint32(k[13])
			}
			return w.push(e)
		})
		if err != nil {
			return HashIndexObject{}, st, err
		}
		if err := w.end(); err != nil {
			return HashIndexObject{}, st, err
		}
		for _, s := range part.sorters {
			s.release()
		}
	}
	obj, err := w.finish()
	if err != nil {
		return obj, st, err
	}
	st.Packs, st.TxBucketBits = len(obj.Packs), obj.Transactions.BucketBits
	for _, o := range obj.objects() {
		st.IndexGB += float64(o.ref.Bytes) / 1e9
	}
	st.WriteS, st.TotalS = time.Since(t0).Seconds(), time.Since(started).Seconds()
	return obj, st, nil
}

// addBundleEntries feeds one chunk's spilled hash entries (hashes.go) to the sorters.
func addBundleEntries(spillDir string, b BundleRef, from, to uint64, txs, blks *extSorter, readBytes, txCount, blockCount *atomic.Uint64) error {
	for _, part := range []struct {
		name string
		size int
		sort *extSorter
		n    *atomic.Uint64
	}{{"tx", txSortKey, txs, txCount}, {"blk", blockSortKey, blks, blockCount}} {
		data, err := os.ReadFile(spillPath(spillDir, b.ChunkID, part.name))
		if err != nil {
			return fmt.Errorf("bundle %d-%d: %w", b.FirstBlock, b.LastBlock, err)
		}
		if len(data)%part.size != 0 {
			return fmt.Errorf("bundle %d-%d: truncated %s entries", b.FirstBlock, b.LastBlock, part.name)
		}
		readBytes.Add(uint64(len(data)))
		for at := 0; at < len(data); at += part.size {
			k := data[at : at+part.size]
			block := getUint40(k[6:11])
			if block < b.FirstBlock || block > b.LastBlock {
				return fmt.Errorf("bundle %d-%d: %s entry for block %d", b.FirstBlock, b.LastBlock, part.name, block)
			}
			if block < from || block > to {
				continue
			}
			if err := part.sort.add(k, nil); err != nil {
				return err
			}
			part.n.Add(1)
		}
	}
	return nil
}

// ---- pipeline stage ----

// hashIndexStateFile is the pipeline's hash index (WORK/hash-index.json).
const hashIndexStateFile = "hash-index.json"

// layeredSource reads the local tree, and the bucket for objects a
// streaming run already uploaded and removed.
type layeredSource struct {
	local  localSource
	remote objectSource
}

func (s layeredSource) get(key string) ([]byte, error) {
	data, err := s.local.get(key)
	if errors.Is(err, errNoObject) && s.remote != nil {
		return s.remote.get(key)
	}
	return data, err
}

func (s layeredSource) getRange(key string, offset, length uint64) ([]byte, error) {
	if _, err := os.Stat(s.local.archive.path(key)); errors.Is(err, os.ErrNotExist) && s.remote != nil {
		return s.remote.getRange(key, offset, length)
	}
	return s.local.getRange(key, offset, length)
}

// hashIndexStage builds the index of blocks 0..tip from the bundles of
// bundles.json; a streaming run uploads it and removes the local copy.
func hashIndexStage(w *workDir) error {
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
	tmp := w.at("hash-index.tmp")
	if w.opts.tmp != "" {
		abs, _ := filepath.Abs(w.root)
		tmp = filepath.Join(w.opts.tmp, "nullrpc-hash-index-"+sha256Hex([]byte(abs))[:12]+".tmp")
	}
	defer os.RemoveAll(tmp)
	obj, st, err := buildHashIndex(src, w.archive(), w.namespace, bundles, hashIndexOptions{
		workers: max(1, runtime.NumCPU()/2), memory: 2 << 30, tmp: tmp, from: 0, to: layer.LastBlock, spill: hashSpillDir(w.archive())})
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
		fmt.Fprintln(os.Stderr, describeStreamStats("hash index", sst))
	}
	data, _ := json.MarshalIndent(hashIndexState{Object: obj, Stats: st}, "", "  ")
	if err := os.WriteFile(w.at(hashIndexStateFile+".tmp"), data, 0o644); err != nil {
		return err
	}
	return os.Rename(w.at(hashIndexStateFile+".tmp"), w.at(hashIndexStateFile))
}

// hashIndexState is WORK/hash-index.json: the object the pipeline built.
type hashIndexState struct {
	Manifest   ObjectRef       `json:"manifest"`
	Generation uint64          `json:"generation"`
	Object     HashIndexObject `json:"object"`
	Stats      hashIndexStats  `json:"stats"`
}

// ---- readers and in-memory writers (promotion and merges) ----

func decodeDirRecord(b []byte) (dirRecord, error) {
	if len(b) != hashIndexDirRecord {
		return dirRecord{}, errors.New("directory record must be 56 bytes")
	}
	r := dirRecord{offset: binary.LittleEndian.Uint64(b), length: binary.LittleEndian.Uint32(b[8:]),
		uncompressed: binary.LittleEndian.Uint32(b[12:]), count: binary.LittleEndian.Uint32(b[16:]),
		pack: binary.LittleEndian.Uint16(b[20:])}
	copy(r.sha256[:], b[24:])
	if b[22] != 0 || b[23] != 0 {
		return r, errors.New("reserved directory bytes are set")
	}
	if r.count == 0 && r != (dirRecord{}) {
		return r, errors.New("empty bucket record is not zero")
	}
	if r.count > 0 && (r.length == 0 || r.uncompressed == 0) {
		return r, errors.New("non-empty bucket without a frame")
	}
	return r, nil
}

func readUvarint(b []byte, at *int) (uint64, error) {
	v, n := binary.Uvarint(b[*at:])
	if n <= 0 {
		return 0, errors.New("invalid varint in hash index frame")
	}
	*at += n
	return v, nil
}

func decodeBucket(plain []byte, count uint32, bucket uint64, o *HashIndexObject, tx bool) ([]hashEntry, error) {
	p := o.part(tx)
	key := bucketBase(bucket, o.KeyBytes, p.BucketBits)
	out := make([]hashEntry, 0, count)
	at := 0
	for i := uint32(0); i < count; i++ {
		var e hashEntry
		d, err := readUvarint(plain, &at)
		if err != nil {
			return nil, err
		}
		key += d
		b, err := readUvarint(plain, &at)
		if err != nil {
			return nil, err
		}
		e.key, e.block = key, o.FirstBlock+b
		if tx {
			idx, err := readUvarint(plain, &at)
			if err != nil {
				return nil, err
			}
			if idx > 1<<32-1 {
				return nil, errors.New("transaction index out of range")
			}
			e.index = uint32(idx)
		}
		if (o.KeyBytes < 8 && key>>(uint(o.KeyBytes)*8) != 0) || bucketOf(key, o.KeyBytes, p.BucketBits) != bucket || e.block > o.LastBlock || (len(out) > 0 && !out[len(out)-1].less(e)) {
			return nil, errors.New("hash index frame entry out of order or range")
		}
		out = append(out, e)
	}
	if at != len(plain) {
		return nil, errors.New("trailing data in hash index frame")
	}
	return out, nil
}

// writeHashIndexEntries writes an object from entries held in memory.
func writeHashIndexEntries(archive localArchive, ns string, first, last uint64, txs, blocks []hashEntry) (HashIndexObject, error) {
	w := newHashIndexWriter(archive, ns, first, last)
	for _, part := range []struct {
		tx      bool
		entries []hashEntry
	}{{true, txs}, {false, blocks}} {
		sort.Slice(part.entries, func(i, j int) bool { return part.entries[i].less(part.entries[j]) })
		w.begin(part.tx, uint64(len(part.entries)))
		for _, e := range part.entries {
			if err := w.push(e); err != nil {
				return HashIndexObject{}, err
			}
		}
		if err := w.end(); err != nil {
			return HashIndexObject{}, err
		}
	}
	return w.finish()
}

func decodeHashIndexFrame(data []byte, r dirRecord) ([]byte, error) {
	if sha256Hex(data) != hex.EncodeToString(r.sha256[:]) {
		return nil, errors.New("hash index frame checksum mismatch")
	}
	dec := hashIndexDecoders.Get().(*zstd.Decoder)
	defer hashIndexDecoders.Put(dec)
	plain, err := dec.DecodeAll(data, make([]byte, 0, r.uncompressed))
	if err != nil {
		return nil, err
	}
	if uint32(len(plain)) != r.uncompressed {
		return nil, errors.New("hash index frame length mismatch")
	}
	return plain, nil
}

// readHashIndexEntries reads every entry of one part, in order.
func readHashIndexEntries(src objectSource, o *HashIndexObject, tx bool) ([]hashEntry, error) {
	p := o.part(tx)
	dir, err := src.get(p.Directory.Key)
	if err != nil {
		return nil, err
	}
	if uint64(len(dir)) != p.Directory.Bytes || sha256Hex(dir) != p.Directory.Sha256 {
		return nil, fmt.Errorf("%s does not match its reference", p.Directory.Key)
	}
	var out []hashEntry
	for b := uint64(0); b < uint64(len(dir)/hashIndexDirRecord); b++ {
		r, err := decodeDirRecord(dir[b*hashIndexDirRecord : (b+1)*hashIndexDirRecord])
		if err != nil {
			return nil, err
		}
		if r.count == 0 {
			continue
		}
		data, err := src.getRange(o.Packs[r.pack].Key, r.offset, uint64(r.length))
		if err != nil {
			return nil, err
		}
		plain, err := decodeHashIndexFrame(data, r)
		if err != nil {
			return nil, err
		}
		es, err := decodeBucket(plain, r.count, b, o, tx)
		if err != nil {
			return nil, err
		}
		out = append(out, es...)
	}
	if uint64(len(out)) != p.Entries {
		return nil, fmt.Errorf("hash index part has %d entries, its reference %d", len(out), p.Entries)
	}
	return out, nil
}

func (o *HashIndexObject) part(tx bool) *HashIndexPart {
	if tx {
		return &o.Transactions
	}
	return &o.Blocks
}
