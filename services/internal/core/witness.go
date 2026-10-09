package core

// Witnesses (docs/storage.md, "Witnesses"; docs/pipeline.md, "Witnesses").
//
// A block's witness is the value, before the block, of every account and storage slot its
// transactions touch, including keys they only read: each key's value at the start of the
// block, after the block's pre-transaction system calls (whose writes a replay therefore takes
// from the witness instead of re-running them). The backfill executes every block in process
// against the archive node's database (executor.go) and records the first read of each key;
// every replay is checked against the header's gas used and receipts root.
//
// One witness range per segment: witnesses/{first}-{last}-{content-id}/ with offsets.bin
// (56 bytes per block) and witness.{n}.pack (one frame per block, codec 5). Workers execute
// runs of consecutive blocks in parallel, carrying state from block to block (executor.go);
// ranges are written in block order as their segments complete. A sample of blocks is
// cross-checked against the state history layer, an independent extraction of the same state.

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	witnessVersion    = 1
	witnessOffsetLen  = 56
	witnessPackLimit  = 1 << 30
	witnessFlagExists = 1
	witnessFlagCode   = 2
	witnessCheckEvery = 997 // cross-check one block in this many against the state layer
	witnessStateFile  = "witnesses.json"
	witnessBatch      = 16   // consecutive blocks per read transaction
	witnessRun        = 1024 // consecutive blocks a worker executes on carried state
	// witnessOverlayCheckEvery: one block in this many is executed again from the history
	// alone, and its witness must match the one built on carried state.
	witnessOverlayCheckEvery = 128
)

// Pre-transaction system call contracts: their slots in a witness hold the value after the
// system call, so the cross-check skips them.
var witnessCheckSkip = map[string]bool{
	"000f3df6d732807ef1319fb7b8bb8522d0beac02": true, // EIP-4788 beacon roots
	"0000f90827f1c53a10cb7a02335b175320002935": true, // EIP-2935 block hashes
}

// witnessState is WORK/witnesses.json.
type witnessState struct {
	FirstBlock uint64         `json:"first_block"`
	Ranges     []WitnessRange `json:"ranges"`
	// Uploaded: streaming mode only; ranges whose objects are in the bucket and removed locally.
	Uploaded map[uint64]bool `json:"uploaded,omitempty"`
	// Unchecked: first blocks of ranges built before the state layer existed, whose
	// cross-check witnessCheckStage still owes.
	Unchecked []uint64 `json:"unchecked,omitempty"`
	Checked   uint64   `json:"checked_blocks"`
}

type witnessAccount struct {
	exists   bool
	nonce    uint64
	balance  []byte
	codeHash [32]byte
	hasCode  bool
}

type blockWitness struct {
	accounts map[[20]byte]*witnessAccount
	storage  map[[20]byte]map[[32]byte][]byte
}

func newBlockWitness() *blockWitness {
	return &blockWitness{accounts: map[[20]byte]*witnessAccount{}, storage: map[[20]byte]map[[32]byte][]byte{}}
}

// encode is the witness frame:
//
//	witness  := u8(version) accounts storage
//	accounts := uvarint(n) (address[20] u8(flags) uvarint(nonce) uvarint(len) balance code_hash[32]?){n}
//	storage  := uvarint(n) (address[20] uvarint(m) (slot[32] uvarint(len) value){m}){n}
//
// Accounts and storage are sorted by address, slots by slot.
func (w *blockWitness) encode() []byte {
	out := []byte{witnessVersion}
	addrs := make([][20]byte, 0, len(w.accounts))
	for a := range w.accounts {
		addrs = append(addrs, a)
	}
	sort.Slice(addrs, func(i, j int) bool { return bytes.Compare(addrs[i][:], addrs[j][:]) < 0 })
	out = binary.AppendUvarint(out, uint64(len(addrs)))
	for _, a := range addrs {
		acc := w.accounts[a]
		var flags byte
		if acc.exists {
			flags |= witnessFlagExists
		}
		if acc.hasCode {
			flags |= witnessFlagCode
		}
		out = append(out, a[:]...)
		out = append(out, flags)
		out = binary.AppendUvarint(out, acc.nonce)
		out = binary.AppendUvarint(out, uint64(len(acc.balance)))
		out = append(out, acc.balance...)
		if acc.hasCode {
			out = append(out, acc.codeHash[:]...)
		}
	}
	saddrs := make([][20]byte, 0, len(w.storage))
	for a := range w.storage {
		saddrs = append(saddrs, a)
	}
	sort.Slice(saddrs, func(i, j int) bool { return bytes.Compare(saddrs[i][:], saddrs[j][:]) < 0 })
	out = binary.AppendUvarint(out, uint64(len(saddrs)))
	for _, a := range saddrs {
		slots := w.storage[a]
		keys := make([][32]byte, 0, len(slots))
		for k := range slots {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return bytes.Compare(keys[i][:], keys[j][:]) < 0 })
		out = append(out, a[:]...)
		out = binary.AppendUvarint(out, uint64(len(keys)))
		for _, k := range keys {
			out = append(out, k[:]...)
			out = binary.AppendUvarint(out, uint64(len(slots[k])))
			out = append(out, slots[k]...)
		}
	}
	return out
}

// checkWitness compares a witness with the state layer at block n-1, skipping the
// pre-transaction system call contracts. It returns the number of values compared.
func checkWitness(l *layerReader, n uint64, w *blockWitness) (int, error) {
	if n == 0 {
		return 0, nil
	}
	checked := 0
	for a, acc := range w.accounts {
		if witnessCheckSkip[hex.EncodeToString(a[:])] {
			continue
		}
		value, _, err := l.get("accounts", a[:], n-1)
		if err != nil {
			return checked, err
		}
		want := witnessAccount{}
		if len(value) > 0 {
			st, err := decodeAccount(value)
			if err != nil {
				return checked, err
			}
			want = witnessAccount{exists: true, nonce: st.nonce, balance: st.balance, codeHash: st.codeHash, hasCode: st.hasCode}
		}
		if acc.exists != want.exists || acc.nonce != want.nonce || !bytes.Equal(acc.balance, want.balance) ||
			acc.hasCode != want.hasCode || acc.codeHash != want.codeHash {
			return checked, fmt.Errorf("block %d: witness account %x differs from the state history at block %d", n, a, n-1)
		}
		checked++
	}
	for a, slots := range w.storage {
		if witnessCheckSkip[hex.EncodeToString(a[:])] {
			continue
		}
		for s, v := range slots {
			key := append(append(make([]byte, 0, 52), a[:]...), s[:]...)
			value, _, err := l.get("storage", key, n-1)
			if err != nil {
				return checked, err
			}
			if !bytes.Equal(trimLeadingZeros(value), v) {
				return checked, fmt.Errorf("block %d: witness slot %x/%x differs from the state history at block %d", n, a, s, n-1)
			}
			checked++
		}
	}
	return checked, nil
}

// writeWitnessRange writes one range's frames (index i is block first+i) as
// witnesses/{first}-{last}-{content-id}/.
func writeWitnessRange(archive localArchive, namespace string, first uint64, frames []frame) (WitnessRange, []streamObject, error) {
	last := first + uint64(len(frames)) - 1
	staging := fmt.Sprintf("%s/witnesses/%020d-%020d-building", namespace, first, last)
	os.RemoveAll(archive.path(staging))
	var packs []ObjectRef
	var pack *packWriter
	offsets := make([]byte, 0, len(frames)*witnessOffsetLen)
	closePack := func() error {
		size, sum, err := pack.close()
		if err != nil {
			return err
		}
		packs = append(packs, ObjectRef{Key: fmt.Sprintf("%s/witness.%04d.pack", staging, len(packs)), Bytes: size, Sha256: sum})
		pack = nil
		return nil
	}
	for i, fr := range frames {
		if pack != nil && pack.size+uint64(len(fr.data)) > witnessPackLimit {
			if err := closePack(); err != nil {
				return WitnessRange{}, nil, err
			}
		}
		if pack == nil {
			var err error
			if pack, err = newPackWriter(archive.path(fmt.Sprintf("%s/witness.%04d.pack", staging, len(packs))), codecWitness); err != nil {
				return WitnessRange{}, nil, err
			}
		}
		r, err := pack.push(first+uint64(i), fr)
		if err != nil {
			return WitnessRange{}, nil, err
		}
		if r.Length > math.MaxUint32 || r.UncompressedLength > math.MaxUint32 {
			return WitnessRange{}, nil, fmt.Errorf("block %d witness exceeds 4 GiB", first+uint64(i))
		}
		sum, _ := hex.DecodeString(r.Sha256)
		var rec [witnessOffsetLen]byte
		binary.LittleEndian.PutUint64(rec[0:], r.Offset)
		binary.LittleEndian.PutUint32(rec[8:], uint32(r.Length))
		binary.LittleEndian.PutUint32(rec[12:], uint32(r.UncompressedLength))
		binary.LittleEndian.PutUint16(rec[16:], uint16(len(packs)))
		copy(rec[24:], sum)
		offsets = append(offsets, rec[:]...)
	}
	if err := closePack(); err != nil {
		return WitnessRange{}, nil, err
	}
	offsetsRef, err := archive.putBytes(staging+"/offsets.bin", offsets)
	if err != nil {
		return WitnessRange{}, nil, err
	}
	fingerprints := map[string]string{"offsets.bin": offsetsRef.Sha256}
	for _, p := range packs {
		fingerprints[filepath.Base(p.Key)] = p.Sha256
	}
	fp, _ := json.Marshal(fingerprints)
	final := fmt.Sprintf("%s/witnesses/%020d-%020d-%s", namespace, first, last, sha256Hex(fp))
	os.RemoveAll(archive.path(final))
	if err := os.Rename(archive.path(staging), archive.path(final)); err != nil {
		return WitnessRange{}, nil, err
	}
	rename := func(r ObjectRef) ObjectRef { r.Key = final + strings.TrimPrefix(r.Key, staging); return r }
	rng := WitnessRange{First: first, Last: last, Offsets: rename(offsetsRef)}
	objs := []streamObject{{ref: rng.Offsets}}
	for _, p := range packs {
		p = rename(p)
		rng.Packs = append(rng.Packs, p)
		objs = append(objs, streamObject{ref: p})
	}
	return rng, objs, nil
}

// checkWitnessRanges: one range per segment, same boundaries, in order.
func checkWitnessRanges(st witnessState, bundles []BundleRef) error {
	if st.FirstBlock != 0 {
		return fmt.Errorf("witnesses start at block %d", st.FirstBlock)
	}
	if len(st.Ranges) != len(bundles) {
		return fmt.Errorf("%d witness ranges for %d segments", len(st.Ranges), len(bundles))
	}
	for i, r := range st.Ranges {
		if r.First != bundles[i].FirstBlock || r.Last != bundles[i].LastBlock || len(r.Packs) == 0 ||
			r.Offsets.Bytes != (r.Last-r.First+1)*witnessOffsetLen {
			return fmt.Errorf("witness range %d-%d does not match segment %d-%d", r.First, r.Last, bundles[i].FirstBlock, bundles[i].LastBlock)
		}
	}
	return nil
}

// witnessJob is a run of consecutive blocks one worker executes on carried state, within
// one segment (index seg of the segments being built).
type witnessJob struct {
	seg         int
	first, last uint64
}

// witnessJobs splits each segment into runs of run blocks.
func witnessJobs(segments [][2]uint64, run uint64) []witnessJob {
	var jobs []witnessJob
	for seg, r := range segments {
		for n := r[0]; n <= r[1]; n += run {
			jobs = append(jobs, witnessJob{seg: seg, first: n, last: min(n+run-1, r[1])})
		}
	}
	return jobs
}

// runWitnessJobs executes jobs on workers goroutines. Each job runs on a fresh overlay, one
// read transaction per witnessBatch blocks; onWitness is called from the workers for every
// block, onSegment once all of a segment's jobs are done (from whichever worker finishes
// it). One block in witnessOverlayCheckEvery is executed again from the history alone and
// must give the same witness. The first error stops everything.
func runWitnessJobs(exec *witnessExecutor, jobs []witnessJob, workers int,
	onWitness func(job witnessJob, n uint64, wit *blockWitness) error, onSegment func(seg int) error) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	remaining := map[int]int{}
	for _, j := range jobs {
		remaining[j.seg]++
	}
	var mu sync.Mutex
	var firstErr error
	fail := func(err error) {
		mu.Lock()
		if firstErr == nil {
			firstErr = err
		}
		mu.Unlock()
		cancel()
	}
	runJob := func(job witnessJob) error {
		ov := newStateOverlay()
		for _, r := range batchRanges(job.first, job.last) {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			err := func() error {
				tx, err := exec.readTx(ctx)
				if err != nil {
					return err
				}
				defer tx.Rollback()
				for n := r[0]; n <= r[1]; n++ {
					wit, err := exec.execute(ctx, tx, n, ov)
					if err != nil {
						return err
					}
					if n%witnessOverlayCheckEvery == 0 {
						ref, err := exec.execute(ctx, tx, n, nil)
						if err != nil {
							return err
						}
						if !bytes.Equal(ref.encode(), wit.encode()) {
							return fmt.Errorf("block %d: the witness built on carried state differs from the one built from the history", n)
						}
					}
					if err := onWitness(job, n, wit); err != nil {
						return err
					}
				}
				return nil
			}()
			if err != nil {
				return err
			}
		}
		return nil
	}
	queue := make(chan witnessJob)
	var wg sync.WaitGroup
	for range max(1, workers) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for job := range queue {
				if ctx.Err() != nil {
					continue
				}
				if err := runJob(job); err != nil {
					fail(err)
					continue
				}
				mu.Lock()
				remaining[job.seg]--
				last := remaining[job.seg] == 0
				mu.Unlock()
				if last {
					if err := onSegment(job.seg); err != nil {
						fail(err)
					}
				}
			}
		}()
	}
	for _, j := range jobs {
		select {
		case queue <- j:
		case <-ctx.Done():
		}
	}
	close(queue)
	wg.Wait()
	mu.Lock()
	defer mu.Unlock()
	return firstErr
}

// witnessPlan is the segment list the witness stage builds: the state layer's blocks when
// the layer exists (exact), else every full segment up to a bound no later than the layer
// will reach (what the state files cover, capped at the node's finalized block), so the
// stage can run before and alongside the state dump.
type witnessPlan struct {
	bound    uint64
	exact    bool
	segments [][2]uint64
}

func (w *workDir) witnessPlan() (witnessPlan, error) {
	chunk := w.opts.chunkBlocks
	if layer, _ := w.layerAndBundles(); layer != nil {
		p := witnessPlan{bound: layer.LastBlock, exact: true}
		for n := uint64(0); n <= p.bound; n += chunk {
			p.segments = append(p.segments, [2]uint64{n, min(n+chunk-1, p.bound)})
		}
		return p, nil
	}
	blocks, err := loadBlocks(w.at("blocks.bin"))
	if err != nil {
		return witnessPlan{}, err
	}
	finalized, err := rpcAnchor(w.rpc, "finalized")
	if err != nil {
		return witnessPlan{}, fmt.Errorf("read finalized block: %w", err)
	}
	bound := min(uint64(len(blocks))-1, finalized.Number)
	if through, err := w.stateFilesThrough(blocks); err != nil {
		fmt.Fprintf(os.Stderr, "warning: cannot read the state files' extent (%v); witnesses bounded by the finalized block\n", err)
	} else {
		bound = min(bound, through)
	}
	p := witnessPlan{bound: bound}
	for n := uint64(0); n+chunk-1 <= bound; n += chunk {
		p.segments = append(p.segments, [2]uint64{n, n + chunk - 1})
	}
	return p, nil
}

// stateFilesThrough is the last block the datadir's frozen state files fully cover, the
// bound the state layer will use (statebuild.go, buildStateLayer).
func (w *workDir) stateFilesThrough(blocks []blockTx) (uint64, error) {
	stepSize, err := erigonStepSize(w.datadir)
	if err != nil {
		return 0, err
	}
	var end uint64
	for _, d := range []string{"accounts", "storage", "code"} {
		rs, err := coverRanges(filepath.Join(w.datadir, "snapshots"), d)
		if err != nil {
			return 0, err
		}
		var domainEnd uint64
		for _, r := range rs {
			domainEnd = max(domainEnd, r.toStep*stepSize)
		}
		if end == 0 || domainEnd < end {
			end = domainEnd
		}
	}
	return stateThroughBlock(blocks, end)
}

// witnessStage executes every block of every segment of the plan, resuming after the ranges
// WORK/witnesses.json already lists. Segments are written in order as they complete. Ranges
// built before the state layer existed are cross-checked later by witnessCheckStage.
func witnessStage(w *workDir) error {
	plan, err := w.witnessPlan()
	if err != nil {
		return err
	}
	var st witnessState
	if err := readJSONFile(w.at(witnessStateFile), &st); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	save := func() error {
		data, _ := json.MarshalIndent(st, "", "  ")
		if err := os.WriteFile(w.at(witnessStateFile+".tmp"), data, 0o644); err != nil {
			return err
		}
		return os.Rename(w.at(witnessStateFile+".tmp"), w.at(witnessStateFile))
	}
	// Ranges that do not match the plan (a provisional bound past the layer's end) are dropped.
	keep := 0
	for keep < len(st.Ranges) && keep < len(plan.segments) &&
		st.Ranges[keep].First == plan.segments[keep][0] && st.Ranges[keep].Last == plan.segments[keep][1] {
		keep++
	}
	if keep < len(st.Ranges) {
		for _, r := range st.Ranges[keep:] {
			fmt.Fprintf(os.Stderr, "{\"witnesses\":\"%d-%d\",\"dropped\":\"past the state layer's end\"}\n", r.First, r.Last)
			os.RemoveAll(filepath.Dir(w.archive().path(r.Offsets.Key)))
			delete(st.Uploaded, r.First)
		}
		st.Ranges = st.Ranges[:keep]
		if err := save(); err != nil {
			return err
		}
	}
	if len(st.Ranges) == len(plan.segments) {
		return nil
	}
	var target *streamTarget
	if w.opts.stream {
		if target, err = w.streamTarget(); err != nil {
			return err
		}
	}
	// The state layer, for the inline cross-check, once it exists.
	var layer *layerReader
	if plan.exact {
		src := layeredSource{local: localSource{w.archive()}}
		if target != nil {
			src.remote = s3Source{target.client, target.bucket}
		}
		layerRef, _ := w.layerAndBundles()
		if layer, err = openLayerFrom(src, layerRef.Descriptor, newFrameCache(1<<30)); err != nil {
			return fmt.Errorf("open state layer: %w", err)
		}
	}
	exec, closeExec, err := newWitnessExecutor(context.Background(), w.datadir)
	if err != nil {
		return err
	}
	defer closeExec()
	segments := plan.segments[len(st.Ranges):]
	started := time.Now()
	var executed, checked atomic.Uint64
	// Frames of the segments in flight, by segment. A writer goroutine writes completed
	// segments in order and releases their frames; its error stops the workers.
	var mu sync.Mutex
	frames := map[int][]frame{}
	ready := make(chan int, len(segments))
	var writeErr error
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		complete := map[int]bool{}
		next := 0
		for seg := range ready {
			complete[seg] = true
			for complete[next] && writeErr == nil {
				first := segments[next][0]
				mu.Lock()
				segFrames := frames[next]
				delete(frames, next)
				mu.Unlock()
				rng, objs, err := writeWitnessRange(w.archive(), w.namespace, first, segFrames)
				if err == nil && target != nil {
					if _, err = target.put(context.Background(), w.archive(), objs); err == nil {
						if st.Uploaded == nil {
							st.Uploaded = map[uint64]bool{}
						}
						st.Uploaded[rng.First] = true
					}
				}
				if err == nil {
					st.Ranges = append(st.Ranges, rng)
					if layer == nil {
						st.Unchecked = append(st.Unchecked, rng.First)
					}
					st.Checked += checked.Swap(0)
					err = save()
				}
				mu.Lock()
				writeErr = err
				mu.Unlock()
				if err != nil {
					return
				}
				rate := float64(executed.Load()) / time.Since(started).Seconds()
				fmt.Fprintf(os.Stderr, "{\"witnesses\":\"%d-%d\",\"blocks_per_s\":%.0f,\"eta_s\":%.0f,\"cross_checked_values\":%d}\n",
					rng.First, rng.Last, rate, float64(plan.bound-rng.Last)/max(rate, 1e-9), st.Checked)
				next++
			}
		}
	}()
	onWitness := func(job witnessJob, n uint64, wit *blockWitness) error {
		if layer != nil && n%witnessCheckEvery == 0 {
			c, err := checkWitness(layer, n, wit)
			if err != nil {
				return err
			}
			checked.Add(uint64(c))
		}
		fr := compressFrame(wit.encode())
		mu.Lock()
		err := writeErr
		segFrames := frames[job.seg]
		if segFrames == nil && err == nil {
			segFrames = make([]frame, segments[job.seg][1]-segments[job.seg][0]+1)
			frames[job.seg] = segFrames
		}
		mu.Unlock()
		if err != nil {
			return err
		}
		segFrames[n-segments[job.seg][0]] = fr
		executed.Add(1)
		return nil
	}
	// Segments complete in bursts; a progress line every 30 s shows the stage is alive.
	stopProgress := make(chan struct{})
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-stopProgress:
				return
			case <-t.C:
				done := executed.Load()
				rate := float64(done) / time.Since(started).Seconds()
				fmt.Fprintf(os.Stderr, "{\"witness_progress\":%d,\"blocks_per_s\":%.0f,\"eta_s\":%.0f}\n",
					done, rate, float64(plan.bound+1-segments[0][0]-done)/max(rate, 1e-9))
			}
		}
	}()
	err = runWitnessJobs(exec, witnessJobs(segments, witnessRun), w.opts.execWorkers, onWitness, func(seg int) error {
		ready <- seg
		return nil
	})
	close(stopProgress)
	close(ready)
	<-writerDone
	if err != nil {
		return err
	}
	return writeErr
}

// witnessCheckStage cross-checks the ranges built before the state layer existed: one block
// in witnessCheckEvery of each is executed again and compared with the layer.
func witnessCheckStage(w *workDir) error {
	var st witnessState
	if err := readJSONFile(w.at(witnessStateFile), &st); err != nil {
		return err
	}
	if len(st.Unchecked) == 0 {
		return nil
	}
	layerRef, _ := w.layerAndBundles()
	if layerRef == nil {
		return errors.New("state layer missing")
	}
	src := layeredSource{local: localSource{w.archive()}}
	if w.opts.stream {
		target, err := w.streamTarget()
		if err != nil {
			return err
		}
		src.remote = s3Source{target.client, target.bucket}
	}
	layer, err := openLayerFrom(src, layerRef.Descriptor, newFrameCache(1<<30))
	if err != nil {
		return fmt.Errorf("open state layer: %w", err)
	}
	exec, closeExec, err := newWitnessExecutor(context.Background(), w.datadir)
	if err != nil {
		return err
	}
	defer closeExec()
	pending := map[uint64]bool{}
	for _, first := range st.Unchecked {
		pending[first] = true
	}
	var blocks []uint64
	for _, r := range st.Ranges {
		if !pending[r.First] {
			continue
		}
		for n := (r.First + witnessCheckEvery - 1) / witnessCheckEvery * witnessCheckEvery; n <= r.Last; n += witnessCheckEvery {
			if n > 0 {
				blocks = append(blocks, n)
			}
		}
	}
	var checked atomic.Uint64
	err = parallelEach(blocks, max(1, w.opts.execWorkers), func(n uint64) error {
		tx, err := exec.readTx(context.Background())
		if err != nil {
			return err
		}
		defer tx.Rollback()
		wit, err := exec.execute(context.Background(), tx, n, nil)
		if err != nil {
			return err
		}
		c, err := checkWitness(layer, n, wit)
		checked.Add(uint64(c))
		return err
	})
	if err != nil {
		return err
	}
	st.Checked += checked.Load()
	st.Unchecked = nil
	data, _ := json.MarshalIndent(st, "", "  ")
	if err := os.WriteFile(w.at(witnessStateFile+".tmp"), data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(w.at(witnessStateFile+".tmp"), w.at(witnessStateFile)); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "{\"witness_check\":%d,\"cross_checked_values\":%d}\n", len(blocks), st.Checked)
	return nil
}

// runWitnessTest executes a block range like the witness stage and reports its speed,
// without writing anything: `backfill witness-test --from N --to M`.
func runWitnessTest(args []string) {
	fs := flag.NewFlagSet("witness-test", flag.ExitOnError)
	_, datadir, _ := workFlags(fs) // --work and --rpc are accepted and unused
	from := fs.Uint64("from", 1, "first block")
	to := fs.Uint64("to", 10000, "last block")
	workers := fs.Int("exec-workers", runtime.NumCPU(), "blocks executed in parallel")
	fs.Parse(args)
	if *datadir == "" {
		var err error
		if *datadir, err = erigonDatadir(); err != nil {
			fail(err)
		}
	}
	exec, closeExec, err := newWitnessExecutor(context.Background(), *datadir)
	if err != nil {
		fail(err)
	}
	defer closeExec()
	started := time.Now()
	var blocks, accounts, slots, size atomic.Uint64
	// Segments of the pipeline's size, so the runs match the stage's.
	var segments [][2]uint64
	for n := *from; n <= *to; n += 8192 {
		segments = append(segments, [2]uint64{n, min(n+8191, *to)})
	}
	// Short runs on a small range, so every worker has several; the stage uses witnessRun.
	run := max(witnessBatch, min(witnessRun, (*to-*from+1)/uint64(max(1, *workers)*4)))
	fmt.Fprintf(os.Stderr, "{\"run_blocks\":%d,\"workers\":%d}\n", run, *workers)
	err = runWitnessJobs(exec, witnessJobs(segments, run), *workers, func(_ witnessJob, _ uint64, wit *blockWitness) error {
		blocks.Add(1)
		accounts.Add(uint64(len(wit.accounts)))
		for _, s := range wit.storage {
			slots.Add(uint64(len(s)))
		}
		size.Add(uint64(len(wit.encode())))
		return nil
	}, func(int) error { return nil })
	if err != nil {
		fail(err)
	}
	secs := time.Since(started).Seconds()
	fmt.Printf("{\"blocks\":%d,\"seconds\":%.1f,\"blocks_per_s\":%.0f,\"accounts\":%d,\"slots\":%d,\"witness_bytes\":%d}\n",
		blocks.Load(), secs, float64(blocks.Load())/secs, accounts.Load(), slots.Load(), size.Load())
}

// batchRanges splits first..last into runs of witnessBatch blocks.
func batchRanges(first, last uint64) [][2]uint64 {
	var out [][2]uint64
	for n := first; n <= last; n += witnessBatch {
		out = append(out, [2]uint64{n, min(n+witnessBatch-1, last)})
	}
	return out
}
