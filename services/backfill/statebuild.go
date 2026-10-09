package main

// State history layer builder (docs/storage.md, "State history").
//
// Per domain, change streams from all Erigon step ranges are merged by key.
// Each key's changes become (block, value-after-block) entries: txNums map to
// blocks, only a block's last change is kept, and no-op entries are dropped.
// Entries are packed into binary pages sorted by (key, block), with a two-level
// page directory so a reader finds any (key, block) in two range reads.

import (
	"bufio"
	"bytes"
	"container/heap"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/sha3"
)

const statePackLimit = 1 << 30 // rotate data packs at 1 GiB

// Variables only so test vectors can force small pages.
var (
	statePageTarget  = 32 << 10 // uncompressed bytes per data page (soft)
	stateIndexFanout = 1024     // directory entries per index page
)

type stateDomainSummary struct {
	Keys    uint64          `json:"keys"`
	Entries uint64          `json:"entries"`
	Pages   uint64          `json:"pages"`
	Packs   []ObjectRef     `json:"packs"`
	Index   ObjectRef       `json:"index"`
	Root    []stateRootPage `json:"root"`
	// Filter: the blocked Bloom filter of the domain's keys (keyfilter.go).
	Filter ObjectRef `json:"filter"`
}

type stateRootPage struct {
	FirstKey   string       `json:"first_key"`
	FirstBlock uint64       `json:"first_block"`
	Record     RecordOffset `json:"record"`
}

// stateLayer is a layer's layer.json.
type stateLayer struct {
	FirstBlock uint64                         `json:"first"`
	LastBlock  uint64                         `json:"last"`
	Domains    map[string]*stateDomainSummary `json:"domains"`
}

var changesName = regexp.MustCompile(`^([a-z]+)\.([0-9]+)-([0-9]+)\.changes\.zst$`)

type changeFile struct {
	path             string
	fromStep, toStep uint64
}

func listChangeFiles(dir string) (map[string][]changeFile, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := map[string][]changeFile{}
	for _, e := range entries {
		m := changesName.FindStringSubmatch(e.Name())
		if m == nil {
			continue
		}
		from, _ := strconv.ParseUint(m[2], 10, 64)
		to, _ := strconv.ParseUint(m[3], 10, 64)
		out[m[1]] = append(out[m[1]], changeFile{filepath.Join(dir, e.Name()), from, to})
	}
	for d, files := range out {
		sort.Slice(files, func(i, j int) bool { return files[i].fromStep < files[j].fromStep })
		for i := 1; i < len(files); i++ {
			if files[i].fromStep != files[i-1].toStep {
				return nil, fmt.Errorf("%s change files are not contiguous at step %d", d, files[i-1].toStep)
			}
		}
	}
	return out, nil
}

// stateThroughBlock is the last block whose transactions all lie below the
// end of the frozen state files: its post-state is completely described.
func stateThroughBlock(blocks []blockTx, stateEndTx uint64) (uint64, error) {
	i := sort.Search(len(blocks), func(n int) bool {
		return blocks[n].base+uint64(blocks[n].count) > stateEndTx
	})
	if i == 0 {
		return 0, errors.New("no block is fully covered by state history")
	}
	return uint64(i - 1), nil
}

// buildStateLayer covers blocks 0..min(frozen state end, finalized). Nothing
// past the node's finalized block is ever written.
func buildStateLayer(rpc *rpcClient, changesDir, blocksPath string, archive localArchive, namespace string, stepSize uint64) (StateHistoryLayerRef, error) {
	files, err := listChangeFiles(changesDir)
	if err != nil {
		return StateHistoryLayerRef{}, err
	}
	var stateEnd uint64
	for _, d := range []string{"accounts", "storage", "code"} {
		fs := files[d]
		if len(fs) == 0 || fs[0].fromStep != 0 {
			return StateHistoryLayerRef{}, fmt.Errorf("%s change files must start at step 0", d)
		}
		end := fs[len(fs)-1].toStep * stepSize
		if stateEnd != 0 && end != stateEnd {
			return StateHistoryLayerRef{}, errors.New("domains end at different steps")
		}
		stateEnd = end
	}
	blocks, err := loadBlocks(blocksPath)
	if err != nil {
		return StateHistoryLayerRef{}, err
	}
	through, err := stateThroughBlock(blocks, stateEnd)
	if err != nil {
		return StateHistoryLayerRef{}, err
	}
	finalized, err := rpcAnchor(rpc, "finalized")
	if err != nil {
		return StateHistoryLayerRef{}, fmt.Errorf("read finalized block: %w", err)
	}
	if finalized.Number < through {
		fmt.Fprintf(os.Stderr, "state files reach block %d; capping at finalized block %d\n", through, finalized.Number)
		through = finalized.Number
	}
	layer := &stateLayer{FirstBlock: 0, LastBlock: through, Domains: map[string]*stateDomainSummary{}}
	// Built under a staging name, then renamed to its content-id once every file is written.
	base := fmt.Sprintf("%s/state/layers/%020d-%020d-building", namespace, 0, through)
	os.RemoveAll(archive.path(base))
	var mu sync.Mutex
	var wg sync.WaitGroup
	errs := make(chan error, 3)
	for _, domain := range []string{"accounts", "storage", "code"} {
		wg.Add(1)
		go func(domain string) {
			defer wg.Done()
			started := time.Now()
			summary, err := buildStateDomain(domain, files[domain], blocks, through, archive, base, changesDir)
			if err != nil {
				errs <- fmt.Errorf("%s: %w", domain, err)
				return
			}
			mu.Lock()
			layer.Domains[domain] = summary
			mu.Unlock()
			fmt.Fprintf(os.Stderr, "{\"domain\":%q,\"keys\":%d,\"entries\":%d,\"pages\":%d,\"seconds\":%.1f}\n",
				domain, summary.Keys, summary.Entries, summary.Pages, time.Since(started).Seconds())
		}(domain)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		return StateHistoryLayerRef{}, err
	}
	final, err := finishLayerDir(archive, base, fmt.Sprintf("%s/state/layers/%020d-%020d", namespace, 0, through), layer)
	if err != nil {
		return StateHistoryLayerRef{}, err
	}
	descriptor, err := archive.putJSON(final+"/layer.json", layer)
	if err != nil {
		return StateHistoryLayerRef{}, err
	}
	return StateHistoryLayerRef{FirstBlock: 0, LastBlock: through, Level: baseLevel, Descriptor: descriptor}, nil
}

// finishLayerDir renames a layer's staging directory to `{prefix}-{content-id}`, where
// content-id is the SHA-256 of the sorted file name -> digest map, and rewrites the layer's
// object keys to match. It returns the final directory key.
func finishLayerDir(archive localArchive, staging, prefix string, layer *stateLayer) (string, error) {
	os.RemoveAll(archive.path(staging + "/.filter-spill"))
	fingerprints := map[string]string{}
	var refs []*ObjectRef
	for _, d := range layer.Domains {
		for i := range d.Packs {
			refs = append(refs, &d.Packs[i])
		}
		refs = append(refs, &d.Index, &d.Filter)
	}
	for _, r := range refs {
		fingerprints[strings.TrimPrefix(r.Key, staging+"/")] = r.Sha256
	}
	fp, _ := json.Marshal(fingerprints)
	final := prefix + "-" + sha256Hex(fp)
	os.RemoveAll(archive.path(final))
	if err := os.Rename(archive.path(staging), archive.path(final)); err != nil {
		return "", err
	}
	for _, r := range refs {
		r.Key = final + strings.TrimPrefix(r.Key, staging)
	}
	return final, nil
}

// ---- merging change streams ----

// keyVisitor receives every key once, in key order, with its changes from all
// files in txNum order: begin, change for each change, end. A value is only
// valid during its call, so no key's history is ever held in memory.
type keyVisitor interface {
	begin(key []byte) error
	change(txNum uint64, value []byte) error
	end() error
}

type mergeItem struct {
	key  []byte
	file int
	it   *changeIter
}

type mergeHeap []*mergeItem

func (h mergeHeap) Len() int { return len(h) }
func (h mergeHeap) Less(i, j int) bool {
	if c := bytes.Compare(h[i].key, h[j].key); c != 0 {
		return c < 0
	}
	return h[i].file < h[j].file // earlier step range first
}
func (h mergeHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *mergeHeap) Push(x any)   { *h = append(*h, x.(*mergeItem)) }
func (h *mergeHeap) Pop() any {
	old := *h
	x := old[len(old)-1]
	*h = old[:len(old)-1]
	return x
}

// mergeKeys streams each key's complete, txNum-ordered change list to v.
func mergeKeys(files []changeFile, v keyVisitor) error {
	h := &mergeHeap{}
	for i, f := range files {
		it, err := openChangeIter(f.path)
		if err != nil {
			return err
		}
		defer it.close()
		key, ok, err := it.nextKey()
		if err != nil {
			return err
		}
		if ok {
			heap.Push(h, &mergeItem{key: key, file: i, it: it})
		}
	}
	var (
		cur  []byte
		last uint64
		any  bool
	)
	for h.Len() > 0 {
		top := (*h)[0]
		if cur == nil || !bytes.Equal(cur, top.key) {
			if cur != nil {
				if err := v.end(); err != nil {
					return err
				}
			}
			cur, any = top.key, false
			if err := v.begin(cur); err != nil {
				return err
			}
		}
		for {
			tx, value, ok, err := top.it.nextChange()
			if err != nil {
				return err
			}
			if !ok {
				break
			}
			if any && tx <= last {
				return fmt.Errorf("key %x: overlapping change ranges", cur)
			}
			last, any = tx, true
			if err := v.change(tx, value); err != nil {
				return err
			}
		}
		key, ok, err := top.it.nextKey()
		if err != nil {
			return err
		}
		if ok {
			top.key = key
			heap.Fix(h, 0)
		} else {
			heap.Pop(h)
		}
	}
	if cur != nil {
		return v.end()
	}
	return nil
}

// ---- per-domain build ----

type pageEntry struct {
	block uint64
	value []byte
}

// historyKeys turns a key's changes into page entries: the last value of each
// block up to `through`, dropping entries that do not change the visible value
// (absent == empty).
type historyKeys struct {
	pw      *pageWriter
	convert func([]byte) ([]byte, error) // value conversion (accounts); nil keeps values
	blocks  []blockTx
	through uint64
	key     []byte
	block   uint64
	value   []byte // pending: the block's last change so far
	pending bool
	prev    []byte // last value written for the key
	stop    bool   // past `through`
}

func (k *historyKeys) begin(key []byte) error {
	k.key, k.pending, k.prev, k.stop = key, false, nil, false
	k.pw.beginKey(key)
	return nil
}

func (k *historyKeys) change(tx uint64, value []byte) error {
	if k.stop {
		return nil
	}
	b := blockOf(k.blocks, tx)
	if b < 0 {
		// State files frozen after the block boundaries were read can reach past
		// the last known block; `through` is at or below that block.
		if n := len(k.blocks); n > 0 && tx >= k.blocks[n-1].base+uint64(k.blocks[n-1].count) {
			k.stop = true
			return nil
		}
		return fmt.Errorf("txNum %d of key %x is outside frozen blocks", tx, k.key)
	}
	if uint64(b) > k.through {
		k.stop = true
		return nil
	}
	if k.convert != nil {
		var err error
		if value, err = k.convert(value); err != nil {
			return fmt.Errorf("key %x: %w", k.key, err)
		}
	}
	if k.pending && k.block == uint64(b) {
		k.value = append(k.value[:0], value...) // keep the block's last change
		return nil
	}
	k.flush()
	k.block, k.value, k.pending = uint64(b), bytes.Clone(value), true
	return nil
}

func (k *historyKeys) flush() {
	if !k.pending {
		return
	}
	if !bytes.Equal(k.value, k.prev) {
		k.pw.addEntry(pageEntry{k.block, k.value})
		k.prev = k.value
	}
	k.value, k.pending = nil, false // owned by the page writer now
}

func (k *historyKeys) end() error {
	k.flush()
	k.pw.endKey()
	return nil
}

// codeKeys collects distinct contract code (by keccak256) up to `through` in a
// spill file, keeping only hashes and offsets in memory.
type codeKeys struct {
	blocks  []blockTx
	through uint64
	f       *os.File
	w       *bufio.Writer
	off     int64
	seen    map[[32]byte]struct{}
	refs    []codeRef
}

type codeRef struct {
	hash [32]byte
	off  int64
	n    int
}

func (c *codeKeys) begin([]byte) error { return nil }
func (c *codeKeys) end() error         { return nil }

func (c *codeKeys) change(tx uint64, value []byte) error {
	if b := blockOf(c.blocks, tx); len(value) == 0 || b < 0 || uint64(b) > c.through {
		return nil
	}
	var h [32]byte
	k := sha3.NewLegacyKeccak256()
	k.Write(value)
	k.Sum(h[:0])
	if _, ok := c.seen[h]; ok {
		return nil
	}
	c.seen[h] = struct{}{}
	if _, err := c.w.Write(value); err != nil {
		return err
	}
	c.refs = append(c.refs, codeRef{h, c.off, len(value)})
	c.off += int64(len(value))
	return nil
}

func buildStateDomain(domain string, files []changeFile, blocks []blockTx, through uint64, archive localArchive, base, tmpDir string) (*stateDomainSummary, error) {
	pw, err := newPageWriter(archive, base, domain)
	if err != nil {
		return nil, err
	}
	if domain == "code" {
		// Contract code is content-addressed: key = keccak256(code), block 0.
		f, err := os.CreateTemp(tmpDir, "code-*.spill")
		if err != nil {
			return nil, err
		}
		defer os.Remove(f.Name())
		defer f.Close()
		c := &codeKeys{blocks: blocks, through: through, f: f, w: bufio.NewWriterSize(f, 4<<20), seen: map[[32]byte]struct{}{}}
		if err := mergeKeys(files, c); err != nil {
			return nil, err
		}
		if err := c.w.Flush(); err != nil {
			return nil, err
		}
		c.seen = nil
		sort.Slice(c.refs, func(i, j int) bool { return bytes.Compare(c.refs[i].hash[:], c.refs[j].hash[:]) < 0 })
		var buf []byte
		for _, r := range c.refs {
			if cap(buf) < r.n {
				buf = make([]byte, r.n)
			}
			buf = buf[:r.n]
			if _, err := f.ReadAt(buf, r.off); err != nil {
				return nil, err
			}
			// addKey copies the value into the page before returning.
			if err := pw.addKey(r.hash[:], []pageEntry{{0, buf}}); err != nil {
				return nil, err
			}
		}
		return pw.finish()
	}
	hk := &historyKeys{pw: pw, blocks: blocks, through: through}
	if domain == "accounts" {
		hk.convert = convertAccountV3
	}
	if err := mergeKeys(files, hk); err != nil {
		return nil, err
	}
	return pw.finish()
}

// pageWriter encodes (key, block, value) runs into binary pages:
//
//	page  := group*
//	group := uvarint(len key) key uvarint(n) n * (uvarint(block delta) uvarint(len v) v)
//
// The first delta of a group is the absolute block. A key's run may continue
// in the next page; that page repeats the key with an absolute first block.
// Pages are compressed concurrently and appended in order to rotating packs.
type pageWriter struct {
	archive localArchive
	base    string
	domain  string

	page          []byte
	pageFirstKey  []byte
	pageFirstBlk  uint64
	pageHasData   bool
	order         chan chan pageResult
	jobs          chan pageJob
	done          chan error
	workers       sync.WaitGroup
	dir           []dirEntry
	packs         []ObjectRef
	keys, entries uint64

	// filter: the domain's keys for its Bloom filter (keyfilter.go).
	filter    *filterSpill
	filterErr error

	// The key being added (beginKey/addEntry/endKey): entries of its current
	// chunk, their encoded size and the chunk's byte budget.
	curKey     []byte
	curEntries []pageEntry
	curSize    int
	curBudget  int
	curAny     bool
}

type pageJob struct {
	raw        []byte
	firstKey   []byte
	firstBlock uint64
	res        chan pageResult
}

type pageResult struct {
	fr         frame
	firstKey   []byte
	firstBlock uint64
}

type dirEntry struct {
	key    []byte
	block  uint64
	pack   uint64
	record RecordOffset
}

func newPageWriter(archive localArchive, base, domain string) (*pageWriter, error) {
	filter, err := newFilterSpill(archive.path(base + "/.filter-spill"))
	if err != nil {
		return nil, err
	}
	w := &pageWriter{archive: archive, base: base, domain: domain, filter: filter,
		order: make(chan chan pageResult, 1024), jobs: make(chan pageJob, 1024), done: make(chan error, 1)}
	for range max(1, runtime.NumCPU()/3) {
		w.workers.Add(1)
		go func() {
			defer w.workers.Done()
			for j := range w.jobs {
				j.res <- pageResult{fr: compressFrame(j.raw), firstKey: j.firstKey, firstBlock: j.firstBlock}
			}
		}()
	}
	go w.writeLoop()
	return w, nil
}

func (w *pageWriter) packKey(n int) string {
	return fmt.Sprintf("%s/%s.%04d.pack", w.base, w.domain, n)
}

func (w *pageWriter) writeLoop() {
	var pack *packWriter
	finishPack := func() error {
		size, sum, err := pack.close()
		if err != nil {
			return err
		}
		ref, err := w.archive.adoptFile(w.packKey(len(w.packs)), pack.path, size, sum)
		if err != nil {
			return err
		}
		w.packs = append(w.packs, ref)
		pack = nil
		return nil
	}
	var err error
	for rc := range w.order {
		r := <-rc
		if err != nil {
			continue
		}
		if pack == nil {
			pack, err = newPackWriter(w.archive.path(w.packKey(len(w.packs))), codecState)
			if err != nil {
				continue
			}
		}
		var rec RecordOffset
		rec, err = pack.push(uint64(len(w.dir)), r.fr)
		w.dir = append(w.dir, dirEntry{key: r.firstKey, block: r.firstBlock, pack: uint64(len(w.packs)), record: rec})
		if err == nil && pack.size >= statePackLimit {
			err = finishPack()
		}
	}
	if err == nil && pack != nil {
		err = finishPack()
	}
	w.done <- err
}

func (w *pageWriter) flushPage() {
	if !w.pageHasData {
		return
	}
	rc := make(chan pageResult, 1)
	w.order <- rc // reserve the page's position before compressing out of order
	w.jobs <- pageJob{raw: w.page, firstKey: w.pageFirstKey, firstBlock: w.pageFirstBlk, res: rc}
	w.page = make([]byte, 0, statePageTarget+4096)
	w.pageHasData = false
}

func (w *pageWriter) addKey(key []byte, entries []pageEntry) error {
	w.beginKey(key)
	for _, e := range entries {
		w.addEntry(e)
	}
	if len(entries) == 0 {
		w.keys++
	}
	w.endKey()
	return nil
}

// beginKey starts a key whose entries follow in block order (addEntry). A key
// is split into chunks that fit the page budget (at least one entry each); a
// chunk followed by more entries of the key ends its page.
func (w *pageWriter) beginKey(key []byte) {
	w.curKey, w.curEntries, w.curSize, w.curAny = key, w.curEntries[:0], 0, false
	w.curBudget = w.chunkBudget()
}

func (w *pageWriter) chunkBudget() int {
	return statePageTarget - len(w.page) - len(w.curKey) - 2*binary.MaxVarintLen64
}

// addEntry adds an entry of the current key; the page writer keeps e.value.
func (w *pageWriter) addEntry(e pageEntry) {
	size := func() int {
		prev := uint64(0)
		if n := len(w.curEntries); n > 0 {
			prev = w.curEntries[n-1].block
		}
		return uvarintLen(e.block-prev) + uvarintLen(uint64(len(e.value))) + len(e.value)
	}
	s := size()
	if len(w.curEntries) > 0 && w.curSize+s > w.curBudget {
		w.writeChunk()
		w.flushPage()
		w.curBudget = w.chunkBudget()
		s = size()
	}
	w.curEntries = append(w.curEntries, e)
	w.curSize += s
	w.curAny = true
}

func (w *pageWriter) endKey() {
	if len(w.curEntries) > 0 {
		w.writeChunk()
		if len(w.page) >= statePageTarget {
			w.flushPage()
		}
	}
	if w.curAny {
		w.keys++
		if err := w.filter.add(w.curKey); err != nil && w.filterErr == nil {
			w.filterErr = err
		}
	}
	w.curKey = nil
}

// writeChunk appends the current key's buffered entries to the page.
func (w *pageWriter) writeChunk() {
	entries := w.curEntries
	if !w.pageHasData {
		w.pageFirstKey = bytes.Clone(w.curKey)
		w.pageFirstBlk = entries[0].block
		w.pageHasData = true
	}
	var tmp [binary.MaxVarintLen64]byte
	w.page = append(w.page, tmp[:binary.PutUvarint(tmp[:], uint64(len(w.curKey)))]...)
	w.page = append(w.page, w.curKey...)
	w.page = append(w.page, tmp[:binary.PutUvarint(tmp[:], uint64(len(entries)))]...)
	prev := uint64(0)
	for _, e := range entries {
		w.page = append(w.page, tmp[:binary.PutUvarint(tmp[:], e.block-prev)]...)
		w.page = append(w.page, tmp[:binary.PutUvarint(tmp[:], uint64(len(e.value)))]...)
		w.page = append(w.page, e.value...)
		prev = e.block
	}
	w.entries += uint64(len(entries))
	clear(w.curEntries)
	w.curEntries, w.curSize = w.curEntries[:0], 0
}

func uvarintLen(v uint64) int {
	n := 1
	for v >= 0x80 {
		v >>= 7
		n++
	}
	return n
}

// finish flushes data pages, then writes the directory:
//
//	index page := uvarint(n) n * (uvarint(len key) key uvarint(first block)
//	              uvarint(pack) uvarint(offset) uvarint(length)
//	              uvarint(uncompressed length) sha256[32])
//
// and returns the root (one entry per index page) for layer.json.
func (w *pageWriter) finish() (*stateDomainSummary, error) {
	w.flushPage()
	close(w.jobs)
	close(w.order)
	if err := <-w.done; err != nil {
		return nil, err
	}
	w.workers.Wait()
	if len(w.packs) == 0 {
		// A domain without entries still has one (empty) data pack.
		pack, err := newPackWriter(w.archive.path(w.packKey(0)), codecState)
		if err != nil {
			return nil, err
		}
		size, sum, err := pack.close()
		if err != nil {
			return nil, err
		}
		ref, err := w.archive.adoptFile(w.packKey(0), pack.path, size, sum)
		if err != nil {
			return nil, err
		}
		w.packs = append(w.packs, ref)
	}
	s := &stateDomainSummary{Keys: w.keys, Entries: w.entries, Pages: uint64(len(w.dir)), Packs: w.packs, Root: []stateRootPage{}}
	indexKey := fmt.Sprintf("%s/%s.index.pack", w.base, w.domain)
	pack, err := newPackWriter(w.archive.path(indexKey), codecState)
	if err != nil {
		return nil, err
	}
	var tmp [binary.MaxVarintLen64]byte
	put := func(b []byte, v uint64) []byte { return append(b, tmp[:binary.PutUvarint(tmp[:], v)]...) }
	for start := 0; start < len(w.dir); start += stateIndexFanout {
		chunk := w.dir[start:min(start+stateIndexFanout, len(w.dir))]
		var raw []byte
		raw = put(raw, uint64(len(chunk)))
		for _, d := range chunk {
			raw = put(raw, uint64(len(d.key)))
			raw = append(raw, d.key...)
			raw = put(raw, d.block)
			raw = put(raw, d.pack)
			raw = put(raw, d.record.Offset)
			raw = put(raw, d.record.Length)
			raw = put(raw, d.record.UncompressedLength)
			sum, err := hex.DecodeString(d.record.Sha256)
			if err != nil || len(sum) != 32 {
				return nil, errors.New("invalid page digest")
			}
			raw = append(raw, sum...)
		}
		rec, err := pack.push(uint64(len(s.Root)), compressFrame(raw))
		if err != nil {
			return nil, err
		}
		s.Root = append(s.Root, stateRootPage{FirstKey: hex.EncodeToString(chunk[0].key), FirstBlock: chunk[0].block, Record: rec})
	}
	size, sum, err := pack.close()
	if err != nil {
		return nil, err
	}
	if s.Index, err = w.archive.adoptFile(indexKey, pack.path, size, sum); err != nil {
		return nil, err
	}
	if w.filterErr != nil {
		return nil, w.filterErr
	}
	filter, err := w.filter.build()
	if err != nil {
		return nil, err
	}
	if s.Filter, err = w.archive.putBytes(fmt.Sprintf("%s/%s.filter", w.base, w.domain), filter); err != nil {
		return nil, err
	}
	return s, nil
}
