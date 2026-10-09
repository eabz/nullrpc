package core

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"reflect"
	"testing"
)

func testBlock(n uint64, diff ...diffEntry) *liveBlock {
	return &liveBlock{Number: n, Hash: fmt.Sprintf("0x%064x", n+1000), Parent: fmt.Sprintf("0x%064x", n+999), Diff: diff}
}

func acct(nonce uint64, bal byte) []byte {
	return encodeAccount(account{nonce: nonce, balance: []byte{bal}})
}

func TestDiffLayersMerge(t *testing.T) {
	archive := localArchive{t.TempDir()}
	a1 := bytes.Repeat([]byte{1}, 20)
	a2 := bytes.Repeat([]byte{2}, 20)
	slot := append(bytes.Clone(a1), bytes.Repeat([]byte{9}, 32)...)
	code := bytes.Repeat([]byte{0xcc}, 32)
	// Four layers of two blocks each; a1 changes in every block, a2 once, the slot twice.
	var refs []StateHistoryLayerRef
	var layers []*stateLayer
	for l := range uint64(4) {
		var blocks []*liveBlock
		for i := range uint64(2) {
			n := 10 + l*2 + i
			diff := []diffEntry{{Domain: diffAccounts, Key: a1, Value: acct(n, byte(n))}, {Domain: diffCode, Key: code, Value: []byte{0x60, 0x00}}}
			if n == 11 {
				diff = append(diff, diffEntry{Domain: diffAccounts, Key: a2, Value: acct(1, 1)}, diffEntry{Domain: diffStorage, Key: slot, Value: []byte{5}})
			}
			if n == 16 {
				diff = append(diff, diffEntry{Domain: diffStorage, Key: slot, Value: nil})
			}
			blocks = append(blocks, testBlock(n, diff...))
		}
		ref, _, err := buildDiffLayer(archive, "1-ab", 10+l*2, 11+l*2, blocks)
		if err != nil {
			t.Fatal(err)
		}
		refs = append(refs, ref)
		var layer stateLayer
		if err := readJSONFile(archive.path(ref.Descriptor.Key), &layer); err != nil {
			t.Fatal(err)
		}
		layers = append(layers, &layer)
	}
	merged, _, err := mergeLayers(localSource{archive}, layers, refs, archive, "1-ab", 1)
	if err != nil {
		t.Fatal(err)
	}
	if merged.FirstBlock != 10 || merged.LastBlock != 17 || merged.Level != 1 {
		t.Fatalf("merged %+v", merged)
	}
	l, err := openLayer(archive, merged.Descriptor.Key)
	if err != nil {
		t.Fatal(err)
	}
	for n := uint64(10); n <= 17; n++ {
		v, _, err := l.get("accounts", a1, n)
		if err != nil || !bytes.Equal(v, acct(n, byte(n))) {
			t.Fatalf("a1 at %d: %x %v", n, v, err)
		}
	}
	if v, ok, _ := l.get("accounts", a2, 10); ok || v != nil {
		t.Fatal("a2 exists before block 11")
	}
	if v, _, _ := l.get("accounts", a2, 17); !bytes.Equal(v, acct(1, 1)) {
		t.Fatal("a2 after block 11")
	}
	if v, _, _ := l.get("storage", slot, 15); !bytes.Equal(v, []byte{5}) {
		t.Fatalf("slot at 15: %x", v)
	}
	if v, _, err := l.get("storage", slot, 16); err != nil || len(v) != 0 {
		t.Fatalf("slot cleared at 16: %x %v", v, err)
	}
	if v, _, _ := l.get("code", code, 17); !bytes.Equal(v, []byte{0x60, 0x00}) {
		t.Fatal("code")
	}
}

func TestIndexMerges(t *testing.T) {
	archive := localArchive{t.TempDir()}
	var hobjs []HashIndexObject
	var lobjs []LogIndexObject
	var wantTx, wantBlk []hashEntry
	var wantLogs []logEntry
	for r := range uint64(4) {
		first, last := 100+r*10, 109+r*10
		var txs, blks []hashEntry
		var logs []logEntry
		for n := first; n <= last; n++ {
			blks = append(blks, hashEntry{key: n * 7919 % (1 << 48), block: n})
			txs = append(txs, hashEntry{key: n * 104729 % (1 << 48), block: n, index: uint32(n % 3)})
			logs = append(logs, logEntry{key: n % 5, block: n})
		}
		wantTx, wantBlk, wantLogs = append(wantTx, txs...), append(wantBlk, blks...), append(wantLogs, logs...)
		h, err := writeHashIndexEntries(archive, "1-ab", first, last, append([]hashEntry(nil), txs...), append([]hashEntry(nil), blks...))
		if err != nil {
			t.Fatal(err)
		}
		l, err := writeLogIndexEntries(archive, "1-ab", first, last, logs)
		if err != nil {
			t.Fatal(err)
		}
		hobjs, lobjs = append(hobjs, h), append(lobjs, l)
	}
	src := localSource{archive}
	h, _, err := mergeHashIndexObjects(src, hobjs, archive, "1-ab", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if h.FirstBlock != 100 || h.LastBlock != 139 {
		t.Fatalf("hash index %d-%d", h.FirstBlock, h.LastBlock)
	}
	for _, c := range []struct {
		tx   bool
		want []hashEntry
	}{{true, wantTx}, {false, wantBlk}} {
		got, err := readHashIndexEntries(src, &h, c.tx)
		if err != nil {
			t.Fatal(err)
		}
		want := append([]hashEntry(nil), c.want...)
		sortHash(want)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("tx=%v: %d entries, want %d", c.tx, len(got), len(want))
		}
	}
	l, _, err := mergeLogIndexObjects(src, lobjs, archive, "1-ab", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	got, err := readLogIndexEntries(src, &l)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(wantLogs) {
		t.Fatalf("log entries %d, want %d", len(got), len(wantLogs))
	}
}

func sortHash(e []hashEntry) {
	for i := 1; i < len(e); i++ {
		for j := i; j > 0 && e[j].less(e[j-1]); j-- {
			e[j], e[j-1] = e[j-1], e[j]
		}
	}
}

func TestSegmentAndWitnessConsolidation(t *testing.T) {
	archive := localArchive{t.TempDir()}
	var refs []BundleRef
	var ranges []WitnessRange
	for s := range uint64(2) {
		var blocks []segmentBlock
		var frames []frame
		for n := s * 4; n < s*4+4; n++ {
			blocks = append(blocks, segmentBlock{number: n, hash: fmt.Sprintf("0x%064x", n+1), record: compressFrame([]byte{byte(n), 1, 2})})
			frames = append(frames, compressFrame([]byte{1, byte(n)}))
		}
		ref, err := writeSegment(archive, "1-ab", 0, fmt.Sprintf("0x%064x", s*4), blocks)
		if err != nil {
			t.Fatal(err)
		}
		rng, _, err := writeWitnessRange(archive, "1-ab", s*4, frames)
		if err != nil {
			t.Fatal(err)
		}
		refs, ranges = append(refs, ref), append(ranges, rng)
	}
	src := localSource{archive}
	var all []segmentBlock
	var frames []frame
	for i, r := range refs {
		bs, _, err := readSegmentBlocks(src, SegmentRef{First: r.FirstBlock, Last: r.LastBlock, LastHash: r.LastBlockHash, Meta: r.Metadata})
		if err != nil {
			t.Fatal(err)
		}
		all = append(all, bs...)
		fs, err := readWitnessFrames(src, ranges[i])
		if err != nil {
			t.Fatal(err)
		}
		frames = append(frames, fs...)
	}
	merged, err := writeSegment(archive, "1-ab", 0, refs[0].FirstParentHash, all)
	if err != nil {
		t.Fatal(err)
	}
	back, _, err := readSegmentBlocks(src, SegmentRef{First: merged.FirstBlock, Last: merged.LastBlock, LastHash: merged.LastBlockHash, Meta: merged.Metadata})
	if err != nil || len(back) != 8 || back[5].hash != fmt.Sprintf("0x%064x", 6) {
		t.Fatalf("merged segment: %d blocks, %v", len(back), err)
	}
	rng, _, err := writeWitnessRange(archive, "1-ab", 0, frames)
	if err != nil {
		t.Fatal(err)
	}
	wf, err := readWitnessFrames(src, rng)
	if err != nil || len(wf) != 8 || wf[7].sha256 != frames[7].sha256 {
		t.Fatalf("merged witnesses: %v", err)
	}
}

func TestGroupEncoding(t *testing.T) {
	a := bytes.Repeat([]byte{3}, 20)
	b1 := testBlock(8, diffEntry{Domain: diffAccounts, Key: a, Value: []byte{1, 0}})
	b1.Record, b1.Witness, b1.TxHashes = []byte{0xc0}, []byte{1, 0, 0}, []string{fmt.Sprintf("0x%064x", 7)}
	b2 := testBlock(9)
	b2.Record, b2.Witness = []byte{0xc1}, []byte{1, 0, 0}
	row := encodeGroup([]*liveBlock{b1, b2}, 4)
	if row.First != 8 || row.Last != 9 {
		t.Fatalf("row %d-%d", row.First, row.Last)
	}
	chain, _ := base64.StdEncoding.DecodeString(row.Chain)
	// Section 1: delta 0, hash, payload; section 2: delta 1.
	if chain[0] != 0 || !bytes.Equal(chain[1:33], mustHex(t, b1.Hash)) {
		t.Fatal("first chain section")
	}
	if len(row.Shards) != 1 {
		t.Fatalf("shards %v", row.Shards)
	}
	for _, data := range row.Shards {
		raw, _ := base64.StdEncoding.DecodeString(data)
		// One section (block 8 only): delta 0, hash, len, domain 1, key, len 2, value.
		if raw[0] != 0 {
			t.Fatal("shard section delta")
		}
		n, w := binary.Uvarint(raw[33:])
		payload := raw[33+w:]
		if int(n) != len(payload) || payload[0] != diffAccounts || !bytes.Equal(payload[1:21], a) || payload[21] != 2 {
			t.Fatalf("shard payload %x", payload)
		}
	}
}

func mustHex(t *testing.T, h string) []byte {
	b, err := hex.DecodeString(h[2:])
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestSpool(t *testing.T) {
	s, err := openSpool(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	b := testBlock(5, diffEntry{Domain: diffStorage, Key: bytes.Repeat([]byte{1}, 52), Value: []byte{7}})
	if err := s.write(b); err != nil {
		t.Fatal(err)
	}
	ids, _ := s.list(spoolReady)
	if len(ids) != 1 || ids[0] != b.id() {
		t.Fatalf("ready %v", ids)
	}
	if err := s.move(b.id(), spoolReady, spoolLive); err != nil {
		t.Fatal(err)
	}
	got, err := s.read(spoolLive, b.id())
	if err != nil || !reflect.DeepEqual(got.Diff, b.Diff) {
		t.Fatalf("read back %+v %v", got, err)
	}
	// Moving again is a no-op once the file is there.
	if err := s.move(b.id(), spoolReady, spoolLive); err != nil {
		t.Fatal(err)
	}
}

func TestWitnessJobs(t *testing.T) {
	jobs := witnessJobs([][2]uint64{{0, 8191}, {8192, 9000}}, witnessRun)
	if len(jobs) != 3 || jobs[1].seg != 0 || jobs[1].first != 4096 || jobs[1].last != 8191 ||
		jobs[2].seg != 1 || jobs[2].first != 8192 || jobs[2].last != 9000 {
		t.Fatalf("jobs %+v", jobs)
	}
	batches := batchRanges(8192, 9000)
	if len(batches) != 13 || batches[12] != [2]uint64{8960, 9000} {
		t.Fatalf("batches %v", batches)
	}
}

func TestNotReadyAtTip(t *testing.T) {
	notFound := errors.New("trace block 100: debug_traceBlockByNumber: -32000 block not found: 100")
	for _, c := range []struct {
		n, head uint64
		err     error
		want    bool
	}{
		{100, 100, notFound, true},
		{98, 100, notFound, true},
		{97, 100, notFound, false}, // below the tip: pruned, not late
		{100, 100, errors.New("execution timeout"), false},
	} {
		if got := notReadyAtTip(c.n, c.head, c.err); got != c.want {
			t.Errorf("notReadyAtTip(%d, %d, %q) = %v, want %v", c.n, c.head, c.err, got, c.want)
		}
	}
}
