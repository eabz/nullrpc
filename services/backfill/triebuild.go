package main

// State root check (docs/pipeline.md, "Phase 1: Backfill").
//
// From the state history layer whose last block is B, every live account and storage slot
// at B (each key's last non-empty value) is streamed in key order. Storage tries are built
// per account by a worker pool (an account's slots are contiguous in the storage domain);
// account leaves keyed by keccak256(address) go to an external sort, then the account trie
// is built from the sorted stream. Its root must equal block B's stateRoot. The trie itself
// is not kept: nothing in nullrpc reads it.

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"runtime/debug"
	"slices"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/klauspost/compress/zstd"
)

// rootCheck is WORK/root-check.json: the state at the archive tip matches its header.
type rootCheck struct {
	Block     uint64    `json:"block"`
	StateRoot string    `json:"state_root"`
	Stats     trieStats `json:"stats"`
}

type trieOptions struct {
	workers int
	memory  int64 // bytes of sort buffers in total
	tmp     string
}

type trieStats struct {
	Block          uint64  `json:"block"`
	StateRoot      string  `json:"state_root"`
	LiveAccounts   uint64  `json:"live_accounts"`
	Contracts      uint64  `json:"accounts_with_storage"`
	LiveSlots      uint64  `json:"live_slots"`
	MaxSlots       uint64  `json:"max_slots_per_account"`
	OrphanSlots    uint64  `json:"orphan_slots"`
	EmittedNodes   uint64  `json:"emitted_nodes"`
	Nodes          uint64  `json:"nodes"`
	NodeBytes      uint64  `json:"node_bytes"`
	SpillBytes     uint64  `json:"spill_bytes"`
	LayerBytes     uint64  `json:"layer_bytes"`
	Pages          uint64  `json:"pages"`
	ScanSeconds    float64 `json:"storage_seconds"`
	AccountSeconds float64 `json:"account_trie_seconds"`
	WriteSeconds   float64 `json:"write_seconds"`
	Seconds        float64 `json:"seconds"`
	PeakRSSGB      float64 `json:"peak_rss_gb"`
}

// ---- sequential layer scan ----

type kv struct{ key, val []byte }

func readFrameAt(f *os.File, r RecordOffset, dec *zstd.Decoder) ([]byte, error) {
	buf := make([]byte, r.Length)
	if _, err := f.ReadAt(buf, int64(r.Offset)); err != nil && err != io.EOF {
		return nil, err
	}
	if sha256Hex(buf) != r.Sha256 {
		return nil, fmt.Errorf("%s@%d: frame digest mismatch", f.Name(), r.Offset)
	}
	plain, err := dec.DecodeAll(buf, make([]byte, 0, r.UncompressedLength))
	if err != nil || uint64(len(plain)) != r.UncompressedLength {
		return nil, fmt.Errorf("%s@%d: bad frame", f.Name(), r.Offset)
	}
	return plain, nil
}

func parseIndexPage(raw []byte) ([]dirEntry, error) {
	r := bytes.NewReader(raw)
	n, err := binary.ReadUvarint(r)
	if err != nil {
		return nil, err
	}
	out := make([]dirEntry, 0, n)
	for range n {
		var e dirEntry
		kl, _ := binary.ReadUvarint(r)
		e.key = make([]byte, kl)
		io.ReadFull(r, e.key)
		e.block, _ = binary.ReadUvarint(r)
		e.pack, _ = binary.ReadUvarint(r)
		e.record.Offset, _ = binary.ReadUvarint(r)
		e.record.Length, _ = binary.ReadUvarint(r)
		e.record.UncompressedLength, _ = binary.ReadUvarint(r)
		sum := make([]byte, 32)
		if _, err := io.ReadFull(r, sum); err != nil {
			return nil, errors.New("truncated index page")
		}
		e.record.Sha256 = hex.EncodeToString(sum)
		out = append(out, e)
	}
	return out, nil
}

// scanLiveValues streams, in key order, every key of a layer domain whose
// last value (its value at the layer's last block) is non-empty. Data pages
// are read and decompressed in parallel and consumed in order.
func scanLiveValues(archive localArchive, d *stateDomainSummary, workers int, out chan<- []kv) error {
	defer close(out)
	files := make([]*os.File, len(d.Packs))
	for i, p := range d.Packs {
		f, err := os.Open(archive.path(p.Key))
		if err != nil {
			return fmt.Errorf("state layer pack missing (was it uploaded with --delete-after?): %w", err)
		}
		defer f.Close()
		files[i] = f
	}
	index, err := os.Open(archive.path(d.Index.Key))
	if err != nil {
		return err
	}
	defer index.Close()
	type job struct {
		e   dirEntry
		res chan []byte
	}
	var firstErr error
	var errMu sync.Mutex
	setErr := func(err error) {
		errMu.Lock()
		if firstErr == nil {
			firstErr = err
		}
		errMu.Unlock()
	}
	jobs := make(chan job, 4*workers)
	order := make(chan chan []byte, 4*workers)
	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			dec, _ := zstd.NewReader(nil, zstd.WithDecoderConcurrency(1))
			defer dec.Close()
			for j := range jobs {
				if int(j.e.pack) >= len(files) {
					setErr(errors.New("index entry names a missing pack"))
					j.res <- nil
					continue
				}
				page, err := readFrameAt(files[j.e.pack], j.e.record, dec)
				if err != nil {
					setErr(err)
				}
				j.res <- page
			}
		}()
	}
	go func() {
		defer close(order)
		defer close(jobs)
		dec, _ := zstd.NewReader(nil, zstd.WithDecoderConcurrency(1))
		defer dec.Close()
		for _, root := range d.Root {
			raw, err := readFrameAt(index, root.Record, dec)
			if err == nil {
				var entries []dirEntry
				if entries, err = parseIndexPage(raw); err == nil {
					for _, e := range entries {
						res := make(chan []byte, 1)
						order <- res
						jobs <- job{e, res}
					}
					continue
				}
			}
			setErr(err)
			return
		}
	}()
	defer func() {
		for range order { // drain on early return
		}
		wg.Wait()
	}()
	batch := make([]kv, 0, 4096)
	var curKey, curVal []byte
	emit := func() {
		if curKey != nil && len(curVal) > 0 {
			batch = append(batch, kv{curKey, curVal})
			if len(batch) == cap(batch) {
				out <- batch
				batch = make([]kv, 0, 4096)
			}
		}
	}
	for res := range order {
		page := <-res
		if page == nil {
			break
		}
		for p := page; len(p) > 0; {
			kl, n := binary.Uvarint(p)
			if n <= 0 || len(p) < n+int(kl) {
				return errors.New("truncated data page")
			}
			key := p[n : n+int(kl)]
			p = p[n+int(kl):]
			count, n := binary.Uvarint(p)
			if n <= 0 || count == 0 {
				return errors.New("truncated data page")
			}
			p = p[n:]
			var last []byte
			for range count {
				_, n1 := binary.Uvarint(p)
				if n1 <= 0 {
					return errors.New("truncated data page")
				}
				vl, n2 := binary.Uvarint(p[n1:])
				if n2 <= 0 || len(p) < n1+n2+int(vl) {
					return errors.New("truncated data page")
				}
				last = p[n1+n2 : n1+n2+int(vl)]
				p = p[n1+n2+int(vl):]
			}
			if curKey != nil && bytes.Equal(key, curKey) {
				curVal = last // the key continues from the previous page
				continue
			}
			if curKey != nil && bytes.Compare(key, curKey) < 0 {
				return fmt.Errorf("layer keys out of order at %x", key)
			}
			emit()
			curKey, curVal = key, last
		}
	}
	errMu.Lock()
	err = firstErr
	errMu.Unlock()
	if err != nil {
		return err
	}
	emit()
	if len(batch) > 0 {
		out <- batch
	}
	return nil
}

// kvStream pulls items from a batched channel fed by scanLiveValues.
type kvStream struct {
	ch    <-chan []kv
	batch []kv
	i     int
}

func (s *kvStream) peek() (kv, bool) {
	for s.i >= len(s.batch) {
		b, ok := <-s.ch
		if !ok {
			return kv{}, false
		}
		s.batch, s.i = b, 0
	}
	return s.batch[s.i], true
}
func (s *kvStream) advance() { s.i++ }
func (s *kvStream) drain() {
	for range s.ch {
	}
}

// ---- build ----

type accountJob struct {
	addr  []byte
	acct  []byte
	slots []kv
}

type hashedSlot struct {
	key [32]byte
	val [34]byte
	n   uint8
}

// trieBuild holds the sorted node runs between computing the root and
// writing the layer.
type trieBuild struct {
	opts       trieOptions
	nodeSorts  []*extSorter
	root       [32]byte
	stats      trieStats
	started    time.Time
	sampleKeys [][32]byte
}

var bigAccountSlots = 1 << 20 // larger storage tries are sorted on disk (a variable for tests)

func computeStateTrie(archive localArchive, layer *stateLayer, opts trieOptions) (*trieBuild, error) {
	accounts, storage := layer.Domains["accounts"], layer.Domains["storage"]
	if accounts == nil || storage == nil {
		return nil, errors.New("state layer lacks the accounts or storage domain")
	}
	os.RemoveAll(opts.tmp)
	if err := os.MkdirAll(opts.tmp, 0o755); err != nil {
		return nil, err
	}
	workers := max(1, opts.workers)
	b := &trieBuild{opts: opts, started: time.Now()}
	nodeLimit := int(opts.memory * 5 / 8 / int64(workers+1))
	accLimit := int(opts.memory * 2 / 8 / int64(workers))
	var emitted atomic.Uint64
	nodeEmitter := func(s *extSorter) func(h [32]byte, rlp []byte) error {
		// Only the root is needed: nodes are counted, not kept.
		return func(h [32]byte, rlp []byte) error {
			emitted.Add(1)
			return nil
		}
	}
	mainNodes := newExtSorter(opts.tmp, nodeLimit)
	b.nodeSorts = append(b.nodeSorts, mainNodes)
	var accSorts []*extSorter

	// Storage tries, one account per job.
	jobs := make(chan accountJob, 4*workers)
	var wg sync.WaitGroup
	var firstErr error
	var errMu sync.Mutex
	setErr := func(err error) {
		errMu.Lock()
		if firstErr == nil {
			firstErr = err
		}
		errMu.Unlock()
	}
	failed := func() bool {
		errMu.Lock()
		defer errMu.Unlock()
		return firstErr != nil
	}
	for range workers {
		nodes := newExtSorter(opts.tmp, nodeLimit)
		accs := newExtSorter(opts.tmp, accLimit)
		b.nodeSorts = append(b.nodeSorts, nodes)
		accSorts = append(accSorts, accs)
		wg.Add(1)
		go func() {
			defer wg.Done()
			k := newKeccak()
			hb := newHashBuilder(nodeEmitter(nodes))
			var hs []hashedSlot
			for j := range jobs {
				if failed() {
					continue
				}
				root := emptyRootHash
				if len(j.slots) > 0 {
					hs = hs[:0]
					for _, s := range j.slots {
						leaf := slotLeaf(s.val)
						if leaf == nil {
							continue
						}
						var e hashedSlot
						e.key = k.sum(s.key[20:])
						e.n = uint8(copy(e.val[:], leaf))
						hs = append(hs, e)
					}
					slices.SortFunc(hs, func(x, y hashedSlot) int { return bytes.Compare(x.key[:], y.key[:]) })
					hb.reset()
					var err error
					for i := range hs {
						if err = hb.add(hs[i].key[:], hs[i].val[:hs[i].n]); err != nil {
							break
						}
					}
					if err == nil {
						root, err = hb.finish()
					}
					if err != nil {
						setErr(fmt.Errorf("storage of %x: %w", j.addr, err))
						continue
					}
				}
				leaf, err := accountLeafOf(j.acct, root)
				if err == nil {
					h := k.sum(j.addr)
					err = accs.add(h[:], leaf)
				}
				if err != nil {
					setErr(fmt.Errorf("account %x: %w", j.addr, err))
				}
			}
		}()
	}
	accCh, stCh := make(chan []kv, 16), make(chan []kv, 16)
	scanErrs := make(chan error, 2)
	scanWorkers := max(2, runtime.NumCPU()/4)
	go func() { scanErrs <- scanLiveValues(archive, accounts, scanWorkers, accCh) }()
	go func() { scanErrs <- scanLiveValues(archive, storage, scanWorkers, stCh) }()
	accStream, st := &kvStream{ch: accCh}, &kvStream{ch: stCh}

	// Accounts too large for a worker: hashed slots sorted on disk, trie built here.
	bigK := newKeccak()
	bigHB := newHashBuilder(nodeEmitter(mainNodes))
	bigAccounts := newExtSorter(opts.tmp, 64<<20)
	accSorts = append(accSorts, bigAccounts)
	buildBig := func(addr, acct []byte, slots []kv) error {
		sorter := newExtSorter(opts.tmp, int(opts.memory/8))
		defer sorter.release()
		addSlots := func(slots []kv) error {
			for _, s := range slots {
				if leaf := slotLeaf(s.val); leaf != nil {
					h := bigK.sum(s.key[20:])
					if err := sorter.add(h[:], leaf); err != nil {
						return err
					}
				}
			}
			return nil
		}
		if err := addSlots(slots); err != nil {
			return err
		}
		count := uint64(len(slots))
		for {
			s, ok := st.peek()
			if !ok || !bytes.Equal(s.key[:20], addr) {
				break
			}
			if err := addSlots([]kv{s}); err != nil {
				return err
			}
			st.advance()
			count++
		}
		b.stats.LiveSlots += count - uint64(len(slots))
		b.stats.MaxSlots = max(b.stats.MaxSlots, count)
		fmt.Fprintf(os.Stderr, "{\"large_storage\":\"0x%x\",\"slots\":%d}\n", addr, count)
		bigHB.reset()
		if err := mergeSorted([]*extSorter{sorter}, func(k, v []byte) error { return bigHB.add(k, v) }); err != nil {
			return err
		}
		root, err := bigHB.finish()
		if err != nil {
			return err
		}
		leaf, err := accountLeafOf(acct, root)
		if err != nil {
			return err
		}
		h := bigK.sum(addr)
		return bigAccounts.add(h[:], leaf)
	}

	progress := time.NewTicker(30 * time.Second)
	defer progress.Stop()
	var joinErr error
join:
	for {
		a, ok := accStream.peek()
		if !ok {
			break
		}
		accStream.advance()
		if len(a.key) != 20 {
			joinErr = fmt.Errorf("account key %x is not an address", a.key)
			break
		}
		if failed() {
			break
		}
		b.stats.LiveAccounts++
		var slots []kv
		for {
			s, ok := st.peek()
			if !ok {
				break
			}
			if len(s.key) != 52 {
				joinErr = fmt.Errorf("storage key %x is not address||slot", s.key)
				break join
			}
			c := bytes.Compare(s.key[:20], a.key)
			if c > 0 {
				break
			}
			st.advance()
			if c < 0 {
				b.stats.OrphanSlots++ // live slot of an account that does not exist at T
				continue
			}
			slots = append(slots, s)
			if len(slots) == bigAccountSlots {
				break
			}
		}
		if len(slots) > 0 {
			b.stats.Contracts++
		}
		b.stats.LiveSlots += uint64(len(slots))
		b.stats.MaxSlots = max(b.stats.MaxSlots, uint64(len(slots)))
		if len(slots) == bigAccountSlots {
			if joinErr = buildBig(a.key, a.val, slots); joinErr != nil {
				break
			}
			continue
		}
		jobs <- accountJob{a.key, a.val, slots}
		select {
		case <-progress.C:
			fmt.Fprintf(os.Stderr, "{\"trie_accounts\":%d,\"trie_slots\":%d,\"emitted_nodes\":%d,\"at\":\"0x%x\",\"rss_gb\":%.1f}\n",
				b.stats.LiveAccounts, b.stats.LiveSlots, emitted.Load(), a.key, rssGB())
		default:
		}
	}
	close(jobs)
	wg.Wait()
	if joinErr == nil {
		for {
			if _, ok := st.peek(); !ok {
				break
			}
			st.advance()
			b.stats.OrphanSlots++
		}
	}
	accStream.drain()
	st.drain()
	for range 2 {
		if err := <-scanErrs; err != nil && joinErr == nil {
			joinErr = err
		}
	}
	if joinErr == nil {
		joinErr = firstErr
	}
	if joinErr != nil {
		return nil, joinErr
	}
	b.stats.ScanSeconds = time.Since(b.started).Seconds()

	// Account trie from leaves sorted by keccak256(address).
	accStarted := time.Now()
	hb := newHashBuilder(nodeEmitter(mainNodes))
	if err := mergeSorted(accSorts, hb.add); err != nil {
		return nil, err
	}
	root, err := hb.finish()
	if err != nil {
		return nil, err
	}
	for _, s := range accSorts {
		s.release()
	}
	if b.stats.LiveAccounts > b.stats.Contracts {
		// Storage roots of accounts without storage resolve like any other.
		emitted.Add(1)
	}
	b.root = root
	b.stats.EmittedNodes = emitted.Load()
	b.stats.AccountSeconds = time.Since(accStarted).Seconds()
	return b, nil
}

// checkStateRoot computes the root at the state layer's last block and requires it to equal
// expectedRoot.
func checkStateRoot(src localArchive, layerRef StateHistoryLayerRef, expectedRoot string, opts trieOptions) (trieStats, error) {
	var layer stateLayer
	if err := readJSONFile(src.path(layerRef.Descriptor.Key), &layer); err != nil {
		return trieStats{}, err
	}
	if layer.LastBlock != layerRef.LastBlock {
		return trieStats{}, errors.New("state layer descriptor does not match its reference")
	}
	defer os.RemoveAll(opts.tmp)
	defer debug.SetGCPercent(debug.SetGCPercent(40))
	b, err := computeStateTrie(src, &layer, opts)
	if err != nil {
		return trieStats{}, err
	}
	for _, s := range b.nodeSorts {
		s.release()
	}
	b.stats.Block = layer.LastBlock
	b.stats.StateRoot = "0x" + hex.EncodeToString(b.root[:])
	b.stats.Seconds = time.Since(b.started).Seconds()
	b.stats.PeakRSSGB = rssGB()
	if b.stats.StateRoot != expectedRoot {
		stats, _ := json.Marshal(b.stats)
		return b.stats, fmt.Errorf("state root mismatch at block %d: computed %s, header has %s (%s)",
			layer.LastBlock, b.stats.StateRoot, expectedRoot, stats)
	}
	return b.stats, nil
}

// rssGB is the process's peak resident set size.
func rssGB() float64 {
	var ru syscall.Rusage
	if syscall.Getrusage(syscall.RUSAGE_SELF, &ru) != nil {
		return 0
	}
	maxrss := float64(ru.Maxrss)
	if runtime.GOOS == "linux" {
		maxrss *= 1024 // kilobytes on Linux, bytes on macOS
	}
	return maxrss / (1 << 30)
}

// rootCheckStage checks the state layer against the tip header and records it in out.
func rootCheckStage(rpc *rpcClient, src localArchive, layerPath string, opts trieOptions, out string) error {
	var ref StateHistoryLayerRef
	if err := readJSONFile(layerPath, &ref); err != nil {
		return err
	}
	header, err := rpcAnchor(rpc, fmt.Sprintf("0x%x", ref.LastBlock))
	if err != nil {
		return fmt.Errorf("read header of block %d: %w", ref.LastBlock, err)
	}
	if header.Number != ref.LastBlock || len(header.StateRoot) != 66 {
		return fmt.Errorf("node returned no header for block %d", ref.LastBlock)
	}
	stats, err := checkStateRoot(src, ref, header.StateRoot, opts)
	if err != nil {
		return err
	}
	data, _ := json.Marshal(rootCheck{Block: ref.LastBlock, StateRoot: header.StateRoot, Stats: stats})
	fmt.Fprintln(os.Stderr, string(data))
	if err := os.WriteFile(out+".tmp", data, 0o644); err != nil {
		return err
	}
	return os.Rename(out+".tmp", out)
}

func defaultTrieOptions(tmp string) trieOptions {
	return trieOptions{workers: min(16, max(1, runtime.NumCPU()/2)), memory: 8 << 30, tmp: tmp}
}
