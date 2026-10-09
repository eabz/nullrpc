// nullrpc-backfill builds the nullrpc archive (docs/storage.md) from an Erigon v3 archive node:
// state history from Erigon's frozen files, blocks and receipts, witnesses from the node's
// tracer, the hash and log indexes, then uploads it to R2.
//
// The state dump streams Erigon v3.7.1 frozen state history without a running node.
//
// For each state domain and step range it walks three immutable files together:
//
//	idx/*.{domain}.{a}-{b}.ef      key -> ascending txNums that changed it
//	history/*.{domain}.{a}-{b}.v   value BEFORE each of those changes, same order
//	domain/*.{domain}.{a}-{b}.kv   value at the end of the range, for every changed key
//
// The value AFTER change i is the value before change i+1 of the same key, and
// the domain value for the key's last change in the range. Each domain range is
// therefore self-contained and ranges are processed in parallel. When history
// is merged in smaller pieces than the domain, a range merges its pieces per key.
//
// Files are opened read-only through Erigon's own decoders; no MDBX access.
package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime/pprof"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/erigontech/erigon/db/recsplit/multiencseq"
	"github.com/erigontech/erigon/db/seg"
	"github.com/klauspost/compress/zstd"
)

// Compression and page settings from db/state/statecfg/state_schema.go (v3.7.1).
type domainCfg struct {
	keyLen       int
	domainComp   seg.FileCompression
	historyComp  seg.FileCompression
	iiComp       seg.FileCompression
	legacyPageSz int // values per page for FileCompressionFormatV0 files
}

var domains = map[string]domainCfg{
	"accounts": {keyLen: 20, domainComp: seg.CompressNone, historyComp: seg.CompressNone, legacyPageSz: 64},
	"storage":  {keyLen: 52, domainComp: seg.CompressKeys, historyComp: seg.CompressNone},
	"code":     {keyLen: 20, domainComp: seg.CompressVals, historyComp: seg.CompressKeys | seg.CompressVals},
}

// historyPiece is one .ef/.v pair.
type historyPiece struct {
	fromStep, toStep uint64
	ef, v            string
}

// rangeFiles is one domain .kv range and the history pieces tiling it.
type rangeFiles struct {
	domain           string
	fromStep, toStep uint64
	kv               string
	pieces           []historyPiece
}

type stats struct {
	Domain     string `json:"domain"`
	FromStep   uint64 `json:"from_step"`
	ToStep     uint64 `json:"to_step"`
	FromTx     uint64 `json:"from_tx"`
	ToTx       uint64 `json:"to_tx"`
	Keys       uint64 `json:"keys"`
	Changes    uint64 `json:"changes"`
	ValueBytes uint64 `json:"value_bytes"`
	// Keys absent from a step-0 domain file because their final value is empty.
	DroppedDeletes uint64  `json:"dropped_deletes,omitempty"`
	InputBytes     int64   `json:"input_bytes"`
	OutputBytes    int64   `json:"output_bytes,omitempty"`
	Seconds        float64 `json:"seconds"`
}

var fileName = regexp.MustCompile(`^v[0-9.]+-([a-z]+)\.([0-9]+)-([0-9]+)\.(ef|v|kv)$`)

func main() {
	if len(os.Args) < 2 || strings.HasPrefix(os.Args[1], "-") {
		runPipeline(os.Args[1:])
		return
	}
	commands := map[string]func([]string){
		"run":          runPipeline,
		"status":       runStatus,
		"verify":       runVerify,
		"state-verify": runStateVerify,
	}
	cmd, ok := commands[os.Args[1]]
	if !ok {
		fail(fmt.Errorf("unknown command %q; run `nullrpc-backfill` with no command to build an archive, or see README.md", os.Args[1]))
	}
	// NULLRPC_CPUPROFILE=path writes a CPU profile of a command that returns normally.
	if path := os.Getenv("NULLRPC_CPUPROFILE"); path != "" {
		f, err := os.Create(path)
		if err != nil {
			fail(err)
		}
		if err := pprof.StartCPUProfile(f); err != nil {
			fail(err)
		}
		defer f.Close()
		defer pprof.StopCPUProfile()
	}
	cmd(os.Args[2:])
}

// erigonStepSize reads step_size from the datadir's erigondb.toml.
func erigonStepSize(datadir string) (uint64, error) {
	return readStepSize(filepath.Join(datadir, "snapshots", "erigondb.toml"))
}

// dumpState writes one change stream per domain and step range into out.
func dumpState(datadir string, domainList []string, stepSize uint64, out string, workers int, maxStep uint64) (stats, error) {
	var total stats
	if datadir == "" {
		return total, errors.New("--datadir is required")
	}
	snap := filepath.Join(datadir, "snapshots")
	if stepSize == 0 {
		var err error
		if stepSize, err = erigonStepSize(datadir); err != nil {
			return total, err
		}
	}
	var jobs []rangeFiles
	for _, d := range domainList {
		if _, ok := domains[d]; !ok {
			return total, fmt.Errorf("unsupported domain %q", d)
		}
		rs, err := coverRanges(snap, d)
		if err != nil {
			return total, err
		}
		for _, r := range rs {
			if maxStep == 0 || r.toStep <= maxStep {
				jobs = append(jobs, r)
			}
		}
	}
	// Largest ranges first so the long pole starts immediately.
	sort.Slice(jobs, func(i, j int) bool {
		return jobs[i].toStep-jobs[i].fromStep > jobs[j].toStep-jobs[j].fromStep
	})
	if out != "" {
		if err := os.MkdirAll(out, 0o755); err != nil {
			return total, err
		}
	}
	started := time.Now()
	results := make(chan stats, len(jobs))
	errs := make(chan error, len(jobs))
	sem := make(chan struct{}, max(1, workers))
	var wg sync.WaitGroup
	for _, job := range jobs {
		wg.Add(1)
		go func(job rangeFiles) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			s, err := dumpRange(job, stepSize, out)
			if err != nil {
				errs <- fmt.Errorf("%s %d-%d: %w", job.domain, job.fromStep, job.toStep, err)
				return
			}
			line, _ := json.Marshal(s)
			fmt.Fprintln(os.Stderr, string(line))
			results <- s
		}(job)
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		return total, err
	}
	total.Domain = "total"
	for s := range results {
		total.Keys += s.Keys
		total.Changes += s.Changes
		total.ValueBytes += s.ValueBytes
		total.InputBytes += s.InputBytes
		total.OutputBytes += s.OutputBytes
	}
	total.Seconds = time.Since(started).Seconds()
	return total, nil
}

// coverRanges picks a gap-free, non-overlapping chain of the largest domain
// ranges, each tiled by complete .ef/.v pieces. Erigon leaves merged inputs
// behind briefly, and caps history merges below domain merges (mainnet: an
// 8192-step .kv over 256-step history), so one range may span many pieces.
func coverRanges(snap, domain string) ([]rangeFiles, error) {
	pieces := map[[2]uint64]*historyPiece{}
	kvs := map[[2]uint64]string{}
	for _, sub := range []string{"idx", "history", "domain"} {
		entries, err := os.ReadDir(filepath.Join(snap, sub))
		if err != nil {
			return nil, err
		}
		for _, e := range entries {
			m := fileName.FindStringSubmatch(e.Name())
			if m == nil || m[1] != domain {
				continue
			}
			from, _ := strconv.ParseUint(m[2], 10, 64)
			to, _ := strconv.ParseUint(m[3], 10, 64)
			span, path := [2]uint64{from, to}, filepath.Join(snap, sub, e.Name())
			if m[4] == "kv" {
				kvs[span] = path
				continue
			}
			p := pieces[span]
			if p == nil {
				p = &historyPiece{fromStep: from, toStep: to}
				pieces[span] = p
			}
			if m[4] == "ef" {
				p.ef = path
			} else {
				p.v = path
			}
		}
	}
	tile := func(from, to uint64) []historyPiece {
		var out []historyPiece
		for next := from; next < to; {
			var best *historyPiece
			for _, p := range pieces {
				if p.fromStep == next && p.toStep <= to && p.ef != "" && p.v != "" &&
					(best == nil || p.toStep > best.toStep) {
					best = p
				}
			}
			if best == nil {
				return nil
			}
			out = append(out, *best)
			next = best.toStep
		}
		return out
	}
	var out []rangeFiles
	for next := uint64(0); ; {
		var best *rangeFiles
		for span, kv := range kvs {
			if span[0] != next || (best != nil && span[1] <= best.toStep) {
				continue
			}
			if ps := tile(span[0], span[1]); ps != nil {
				best = &rangeFiles{domain: domain, fromStep: span[0], toStep: span[1], kv: kv, pieces: ps}
			}
		}
		if best == nil {
			break
		}
		out = append(out, *best)
		next = best.toStep
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no complete %s file ranges in %s", domain, snap)
	}
	return out, nil
}

// pieceReader walks one .ef/.v pair; key and seqRaw hold its next key.
type pieceReader struct {
	fromTx, toTx uint64
	ef           *seg.Reader
	hist         *seg.PagedReader
	paged        bool
	key, seqRaw  []byte
	ok           bool
}

func (p *pieceReader) advance(keyLen int) error {
	if p.ok = p.ef.HasNext(); !p.ok {
		if p.hist.HasNext() {
			return errors.New(".v has values beyond .ef")
		}
		return nil
	}
	p.key, _ = p.ef.Next(p.key[:0])
	if !p.ef.HasNext() {
		return errors.New(".ef ends between key and sequence")
	}
	p.seqRaw, _ = p.ef.Next(p.seqRaw[:0])
	if len(p.key) != keyLen {
		return fmt.Errorf("unexpected key length %d", len(p.key))
	}
	return nil
}

func dumpRange(r rangeFiles, stepSize uint64, outDir string) (stats, error) {
	cfg := domains[r.domain]
	started := time.Now()
	s := stats{Domain: r.domain, FromStep: r.fromStep, ToStep: r.toStep,
		FromTx: r.fromStep * stepSize, ToTx: r.toStep * stepSize}
	open := func(path string) (*seg.Decompressor, error) {
		d, err := seg.NewDecompressor(path)
		if err == nil {
			s.InputBytes += d.Size()
		}
		return d, err
	}
	readers := make([]*pieceReader, len(r.pieces))
	for i, piece := range r.pieces {
		efFile, err := open(piece.ef)
		if err != nil {
			return s, err
		}
		defer efFile.Close()
		vFile, err := open(piece.v)
		if err != nil {
			return s, err
		}
		defer vFile.Close()
		ef := seg.NewReader(efFile.MakeGetter(), cfg.iiComp)
		ef.MadvSequential()
		pageSize := vFile.CompressedPageValuesCount()
		if vFile.CompressionFormatVersion() == seg.FileCompressionFormatV0 {
			pageSize = cfg.legacyPageSz
		}
		vRaw := seg.NewReader(vFile.MakeGetter(), cfg.historyComp)
		vRaw.MadvSequential()
		p := &pieceReader{fromTx: piece.fromStep * stepSize, toTx: piece.toStep * stepSize,
			ef: ef, hist: seg.NewPagedReader(vRaw, pageSize, true), paged: pageSize > 1}
		ef.Reset(0)
		p.hist.Reset(0)
		if err := p.advance(cfg.keyLen); err != nil {
			return s, fmt.Errorf("%s: %w", piece.ef, err)
		}
		readers[i] = p
	}
	kvFile, err := open(r.kv)
	if err != nil {
		return s, err
	}
	defer kvFile.Close()
	kv := seg.NewReader(kvFile.MakeGetter(), cfg.domainComp)
	kv.MadvSequential()
	kv.Reset(0)

	var w *changeWriter
	if outDir != "" {
		path := filepath.Join(outDir, fmt.Sprintf("%s.%d-%d.changes.zst", r.domain, r.fromStep, r.toStep))
		if w, err = newChangeWriter(path); err != nil {
			return s, err
		}
	}

	var (
		key, kvKey, kvVal []byte
		seq               multiencseq.SequenceReader
		it                multiencseq.SequenceIterator
		histKey           = make([]byte, 8+cfg.keyLen)
		havePending       bool
	)
	// A change's value AFTER is the next change's value BEFORE, so each change is
	// written as soon as the next one is read: memory stays constant however many
	// changes a key has (mainnet hot keys have millions across merged ranges).
	var (
		changes, prevTx uint64
		first           bool
	)
	emit := func(after []byte) error {
		s.ValueBytes += uint64(len(after))
		if w != nil {
			if err := w.change(key, first, prevTx, after); err != nil {
				return err
			}
		}
		first = false
		return nil
	}
	for {
		// The smallest next key over all pieces; pieces are in step order, so
		// visiting them in slice order keeps each key's txNums ascending.
		key = key[:0]
		for _, p := range readers {
			if p.ok && (len(key) == 0 || bytes.Compare(p.key, key) < 0) {
				key = append(key[:0], p.key...)
			}
		}
		if len(key) == 0 {
			break
		}
		changes, first = 0, true
		for _, p := range readers {
			if !p.ok || !bytes.Equal(p.key, key) {
				continue
			}
			seq.Reset(p.fromTx, p.seqRaw)
			it.Reset(&seq, 0)
			for it.HasNext() {
				txNum, err := it.Next()
				if err != nil {
					return s, err
				}
				if txNum < p.fromTx || txNum >= p.toTx || (changes > 0 && txNum <= prevTx) {
					return s, fmt.Errorf("txNum %d outside [%d,%d) or not ascending", txNum, p.fromTx, p.toTx)
				}
				if !p.hist.HasNext() {
					return s, errors.New(".v ended before .ef")
				}
				var v []byte
				if p.paged {
					var k []byte
					k, v, _, _ = p.hist.Next2(nil)
					binary.BigEndian.PutUint64(histKey, txNum)
					copy(histKey[8:], key)
					if !bytes.Equal(k, histKey) {
						return s, fmt.Errorf("paged .v key %x does not match expected %x", k, histKey)
					}
				} else {
					v, _ = p.hist.Next(nil)
				}
				if changes > 0 {
					if err := emit(v); err != nil {
						return s, err
					}
				}
				prevTx = txNum
				changes++
			}
			if err := p.advance(cfg.keyLen); err != nil {
				return s, err
			}
		}
		if changes == 0 {
			return s, fmt.Errorf("key %x has no changes", key)
		}
		// Domain keys are a superset in the same order. Merges into a file that
		// starts at step 0 drop deleted keys (db/state/merge.go: `deleted :=
		// r.values.from == 0 && len(lastVal) == 0`), so there absence = deleted.
		var final []byte
		found := false
		for {
			if !havePending {
				if !kv.HasNext() {
					break
				}
				kvKey, _ = kv.Next(kvKey[:0])
				kvVal, _ = kv.Next(kvVal[:0])
				havePending = true
			}
			c := bytes.Compare(kvKey, key)
			if c < 0 {
				havePending = false
				continue
			}
			if c == 0 {
				final, found = kvVal, true
				havePending = false
			}
			break
		}
		if !found {
			if r.fromStep != 0 {
				return s, fmt.Errorf("domain file lacks changed key %x", key)
			}
			s.DroppedDeletes++
			final = []byte{}
		}
		// kvKey/kvVal may still hold the next key's pending domain entry.
		s.Keys++
		s.Changes += changes
		if err := emit(final); err != nil {
			return s, err
		}
	}
	if w != nil {
		n, err := w.close()
		if err != nil {
			return s, err
		}
		s.OutputBytes = n
	}
	s.Seconds = time.Since(started).Seconds()
	return s, nil
}

// changeWriter: per key `0x01 keyLen key`, then per change
// `0x02 uvarint(txNum delta) uvarint(len) value`, zstd-compressed.
type changeWriter struct {
	f    *os.File
	buf  *bufio.Writer
	z    *zstd.Encoder
	last uint64
	tmp  [2 * binary.MaxVarintLen64]byte
}

func newChangeWriter(path string) (*changeWriter, error) {
	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	z, err := zstd.NewWriter(f, zstd.WithEncoderLevel(zstd.SpeedFastest), zstd.WithEncoderConcurrency(1))
	if err != nil {
		return nil, err
	}
	return &changeWriter{f: f, z: z, buf: bufio.NewWriterSize(z, 1<<20)}, nil
}

func (w *changeWriter) change(key []byte, first bool, txNum uint64, value []byte) error {
	if first {
		w.buf.WriteByte(1)
		w.buf.WriteByte(byte(len(key)))
		w.buf.Write(key)
		w.last = 0
	}
	w.buf.WriteByte(2)
	n := binary.PutUvarint(w.tmp[:], txNum-w.last)
	n += binary.PutUvarint(w.tmp[n:], uint64(len(value)))
	w.buf.Write(w.tmp[:n])
	_, err := w.buf.Write(value)
	w.last = txNum
	return err
}

func (w *changeWriter) close() (int64, error) {
	if err := w.buf.Flush(); err != nil {
		return 0, err
	}
	if err := w.z.Close(); err != nil {
		return 0, err
	}
	info, err := w.f.Stat()
	if err != nil {
		return 0, err
	}
	return info.Size(), w.f.Close()
}

func readStepSize(path string) (uint64, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	m := regexp.MustCompile(`(?m)^step_size\s*=\s*([0-9]+)`).FindSubmatch(data)
	if m == nil {
		return 0, fmt.Errorf("step_size missing in %s", path)
	}
	return strconv.ParseUint(string(m[1]), 10, 64)
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "nullrpc-backfill:", err)
	os.Exit(1)
}
