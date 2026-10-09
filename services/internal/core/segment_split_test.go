package core

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/klauspost/compress/zstd"
)

// testBloom is the header logs bloom testRecord writes (field 6): the top and bottom bits set.
var testBloom = append(append([]byte{0x80}, bytes.Repeat([]byte{0}, 254)...), 0x01)

// testRecord builds a small but well-formed block record: a 15-field header with the given
// number and timestamp (and testBloom), a legacy and a typed transaction, and receipts with logs.
func testRecord(number, timestamp uint64) (record []byte, txs [][]byte) {
	var header []byte
	for i := range 15 {
		switch i {
		case 8:
			header = rlpAppendUint(header, number)
		case 11:
			header = rlpAppendUint(header, timestamp)
		case 7, 9, 10:
			header = rlpAppendUint(header, uint64(i))
		case 6:
			header = rlpAppendString(header, testBloom)
		default:
			header = rlpAppendString(header, bytes.Repeat([]byte{byte(i)}, 32))
		}
	}
	var legacy []byte
	for _, v := range []uint64{1, 2, 21000} {
		legacy = rlpAppendUint(legacy, v)
	}
	legacy = rlpList(rlpAppendString(legacy, bytes.Repeat([]byte{0xaa}, 20)))
	typed := rlpAppendString(nil, append([]byte{2}, rlpList(rlpAppendUint(nil, 7))...))
	txs = [][]byte{legacy, typed}
	rawBlock := rlpList(append(append(rlpList(header), rlpList(append(append([]byte{}, legacy...), typed...))...), rlpList(nil)...))
	log := func(addr byte, topics ...byte) []byte {
		var ts []byte
		for _, t := range topics {
			ts = rlpAppendString(ts, bytes.Repeat([]byte{t}, 32))
		}
		l := rlpAppendString(nil, bytes.Repeat([]byte{addr}, 20))
		l = append(l, rlpList(ts)...)
		l = rlpAppendString(l, []byte{1, 2, 3})
		return rlpList(l)
	}
	receipt := func(cumulative uint64, logs ...[]byte) []byte {
		var ls []byte
		for _, l := range logs {
			ls = append(ls, l...)
		}
		r := rlpAppendUint(nil, 0)
		r = rlpAppendString(r, []byte{1})
		r = rlpAppendUint(r, cumulative)
		return rlpList(append(r, rlpList(ls)...))
	}
	receipts := rlpList(append(receipt(21000, log(1, 0x11, 0x22)), receipt(42000, log(2, 0x33), log(3))...))
	rec := rlpAppendString(nil, rawBlock)
	rec = rlpAppendString(rec, bytes.Repeat([]byte{0xee}, 40))
	rec = append(rec, receipts...)
	rec = rlpAppendUint(rec, 0)
	rec = append(rec, rlpList(nil)...)
	return rlpList(rec), txs
}

func logKeysOf(t *testing.T, walk func(fn func(address []byte, topics [][]byte)) (uint64, error)) (uint64, []string) {
	t.Helper()
	var keys []string
	n, err := walk(func(address []byte, topics [][]byte) {
		keys = append(keys, fmt.Sprintf("%x:%x", address, topics))
	})
	if err != nil {
		t.Fatal(err)
	}
	return n, keys
}

func TestSplitRecord(t *testing.T) {
	record, txs := testRecord(1234, 1_700_000_000)
	k := newKeccak()
	block, receipts, err := splitRecord(record, nil, k)
	if err != nil {
		t.Fatal(err)
	}
	// The block frame keeps the raw block, senders and blob gas price; the receipts frame has
	// the number, timestamp, hashes (legacy: the whole list; typed: the payload), receipts and extras.
	bi, err := rlpListItems(block)
	if err != nil || len(bi) != 3 {
		t.Fatalf("block frame: %d items, %v", len(bi), err)
	}
	ri, err := rlpListItems(receipts)
	if err != nil || len(ri) != 5 {
		t.Fatalf("receipts frame: %d items, %v", len(ri), err)
	}
	if n, _ := rlpUint64(ri[0]); n != 1234 {
		t.Fatalf("number %d", n)
	}
	if ts, _ := rlpUint64(ri[1]); ts != 1_700_000_000 {
		t.Fatalf("timestamp %d", ts)
	}
	hashes, _, _, _, _ := rlpItem(ri[2])
	h0, h1 := k.sum(txs[0]), k.sum(txs[1][1:]) // the typed transaction's payload
	if !bytes.Equal(hashes, append(h0[:], h1[:]...)) {
		t.Fatalf("hashes %x", hashes)
	}
	// Given hashes are used as they are.
	withGiven, _, err := splitRecord(record, []string{"0x" + fmt.Sprintf("%x", h0), "0x" + fmt.Sprintf("%x", h1)}, k)
	if err != nil || !bytes.Equal(withGiven, block) {
		t.Fatalf("with given hashes: %v", err)
	}
	if _, _, err := splitRecord(record, []string{"0x" + fmt.Sprintf("%x", h0)}, k); err == nil {
		t.Fatal("one hash for two transactions accepted")
	}
	// Joining gives the record back, byte for byte.
	joined, err := joinRecord(block, receipts)
	if err != nil || !bytes.Equal(joined, record) {
		t.Fatalf("join: %v", err)
	}
	// The receipts frame yields the record's logs.
	raw, _, _, _, _ := rlpItem(bi[0])
	fields, _ := rlpListItems(raw)
	hash := k.sum(fields[0]) // recordLogs checks the header's hash
	n1, k1 := logKeysOf(t, func(fn func([]byte, [][]byte)) (uint64, error) { return recordLogs(record, k, hash[:], 1234, fn) })
	n2, k2 := logKeysOf(t, func(fn func([]byte, [][]byte)) (uint64, error) { return receiptsFrameLogs(receipts, 1234, fn) })
	if n1 != 3 || n2 != 3 || fmt.Sprint(k1) != fmt.Sprint(k2) {
		t.Fatalf("logs %d %v / %d %v", n1, k1, n2, k2)
	}
	if _, err := receiptsFrameLogs(receipts, 1235, func([]byte, [][]byte) {}); err == nil {
		t.Fatal("a receipts frame for another block accepted")
	}
}

// writeSegmentV1 writes a segment as the daemon did before layout 2: one record frame per block.
func writeSegmentV1(t *testing.T, archive localArchive, ns string, blocks []segmentBlock, records [][]byte) BundleRef {
	t.Helper()
	first, last := blocks[0], blocks[len(blocks)-1]
	tmp := archive.path(fmt.Sprintf("%s/.tmp/v1-%d", ns, first.number))
	pack, err := newPackWriter(filepath.Join(tmp, "blocks.pack"), codecBlocks)
	if err != nil {
		t.Fatal(err)
	}
	var offsets []byte
	for i, b := range blocks {
		r, err := pack.push(b.number, compressFrame(records[i]))
		if err != nil {
			t.Fatal(err)
		}
		rec, err := offsetRecord(b.hash, r)
		if err != nil {
			t.Fatal(err)
		}
		offsets = append(offsets, rec...)
	}
	size, sum, err := pack.close()
	if err != nil {
		t.Fatal(err)
	}
	base := fmt.Sprintf("%s/segments/v1-%d", ns, first.number)
	packRef, err := archive.adoptFile(base+"/blocks.pack", pack.path, size, sum)
	if err != nil {
		t.Fatal(err)
	}
	offRef, err := archive.putBytes(base+"/offsets.bin", offsets)
	if err != nil {
		t.Fatal(err)
	}
	meta := BundleMetadata{First: first.number, Last: last.number, FirstParentHash: "0x" + fmt.Sprintf("%064x", 0), LastHash: last.hash,
		Files: map[string]ObjectRef{"blocks.pack": packRef, "offsets.bin": offRef}}
	metaRef, err := archive.putJSON(base+"/meta.json", meta)
	if err != nil {
		t.Fatal(err)
	}
	return BundleRef{FirstBlock: first.number, LastBlock: last.number, LastBlockHash: last.hash, Metadata: metaRef}
}

func TestSegmentLayouts(t *testing.T) {
	archive := localArchive{t.TempDir()}
	src := localSource{archive}
	k := newKeccak()
	var records [][]byte
	var blocks []segmentBlock
	for n := uint64(10); n < 14; n++ {
		rec, _ := testRecord(n, 1_700_000_000+12*n)
		records = append(records, rec)
		blocks = append(blocks, segmentBlock{number: n, hash: fmt.Sprintf("0x%064x", n+1)})
	}
	dec, _ := zstd.NewReader(nil)
	defer dec.Close()
	plain := func(f frame) []byte {
		out, err := dec.DecodeAll(f.data, nil)
		if err != nil || uint64(len(out)) != f.uncompressed {
			t.Fatalf("frame does not decode: %v", err)
		}
		return out
	}
	checkJoined := func(got []segmentBlock) {
		t.Helper()
		if len(got) != len(records) {
			t.Fatalf("%d blocks", len(got))
		}
		for i, b := range got {
			joined, err := joinRecord(plain(b.record), plain(b.receipts))
			if err != nil || !bytes.Equal(joined, records[i]) {
				t.Fatalf("block %d: joined record differs (%v)", b.number, err)
			}
		}
	}

	// A layout-1 segment reads back as layout-2 frames.
	v1 := writeSegmentV1(t, archive, "1-ab", blocks, records)
	got, _, err := readSegmentBlocks(src, SegmentRef{First: v1.FirstBlock, Last: v1.LastBlock, LastHash: v1.LastBlockHash, Meta: v1.Metadata})
	if err != nil {
		t.Fatal(err)
	}
	checkJoined(got)

	// Written again (as a merge does), the segment is layout 2: three files, 128-byte records.
	v2, err := writeSegment(archive, "1-ab", 0, "0x"+fmt.Sprintf("%064x", 0), got)
	if err != nil {
		t.Fatal(err)
	}
	var meta BundleMetadata
	if err := readJSONFile(archive.path(v2.Metadata.Key), &meta); err != nil {
		t.Fatal(err)
	}
	if meta.Layout != segmentLayoutV2 || len(meta.Files) != 3 || meta.Files["offsets.bin"].Bytes != 4*offsetRecordLenV2 {
		raw, _ := json.Marshal(meta)
		t.Fatalf("layout-2 meta: %s", raw)
	}
	head, err := os.ReadFile(archive.path(meta.Files["receipts.pack"].Key))
	if err != nil || string(head[:8]) != "NRPCPACK" || head[10] != codecReceipts {
		t.Fatalf("receipts.pack header %x %v", head[:16], err)
	}
	back, _, err := readSegmentBlocks(src, SegmentRef{First: v2.FirstBlock, Last: v2.LastBlock, LastHash: v2.LastBlockHash, Meta: v2.Metadata})
	if err != nil {
		t.Fatal(err)
	}
	checkJoined(back)
	for i := range back {
		if back[i].record.sha256 != got[i].record.sha256 || back[i].receipts.sha256 != got[i].receipts.sha256 {
			t.Fatalf("block %d: frames rewritten", back[i].number)
		}
	}

	// splitRecord from the daemon's path (hashes known) gives the same frames as the merge path.
	block, receipts, err := splitRecord(records[0], nil, k)
	if err != nil || !bytes.Equal(block, plain(back[0].record)) || !bytes.Equal(receipts, plain(back[0].receipts)) {
		t.Fatalf("split differs from the merge path: %v", err)
	}
}
