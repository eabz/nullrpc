package core

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func windowBlocks(from, to uint64, txsPerBlock int) []*liveBlock {
	var out []*liveBlock
	for n := from; n <= to; n++ {
		b := testBlock(n)
		for i := range txsPerBlock {
			b.TxHashes = append(b.TxHashes, fmt.Sprintf("0x%02x%02x%060x", n%256, i, n))
		}
		out = append(out, b)
	}
	return out
}

func TestLiveRecordKeys(t *testing.T) {
	id := BlockID{Number: 1500000, Hash: "0xABCDEF" + fmt.Sprintf("%058x", 1)}
	if got, want := liveRecordKey("1-ab", id), "1-ab/live/records/00000000000001500000-abcdef"+fmt.Sprintf("%058x", 1)+".bin"; got != want {
		t.Fatalf("record key %s, want %s", got, want)
	}
	if got, want := liveIndexKey("1-ab", 1499905, id), "1-ab/live/index/00000000000001499905-00000000000001500000-abcdef"+fmt.Sprintf("%058x", 1)+".bin"; got != want {
		t.Fatalf("index key %s, want %s", got, want)
	}
}

func TestLiveWindowSnapshot(t *testing.T) {
	var w liveWindow
	w.add(windowBlocks(101, 110, 2))
	head := BlockID{Number: 110, Hash: testBlock(110).Hash}

	// The whole window above P, in order, with every transaction.
	blocks, entries := w.snapshot(head, 100)
	if blocks.First != 101 || len(blocks.Hashes) != 10 || blocks.Hashes[0] != testBlock(101).Hash || blocks.Hashes[9] != head.Hash {
		t.Fatalf("snapshot %+v", blocks)
	}
	if len(entries) != 20 {
		t.Fatalf("%d entries", len(entries))
	}
	for i := 1; i < len(entries); i++ {
		if bytes.Compare(entries[i-1].prefix[:], entries[i].prefix[:]) > 0 {
			t.Fatal("entries are not sorted by prefix")
		}
	}
	for _, e := range entries {
		if e.offset > 9 || int(e.prefix[0]) != int(101+e.offset)%256 {
			t.Fatalf("entry %+v", e)
		}
	}

	// A promotion moves the lower bound; a head the window lacks lists nothing.
	blocks, _ = w.snapshot(head, 105)
	if blocks.First != 106 || len(blocks.Hashes) != 5 {
		t.Fatalf("after promotion %+v", blocks)
	}
	blocks, entries = w.snapshot(BlockID{Number: 110, Hash: "0x" + fmt.Sprintf("%064x", 7)}, 100)
	if blocks.First != 111 || len(blocks.Hashes) != 0 || entries != nil {
		t.Fatalf("unknown head %+v %v", blocks, entries)
	}
	// A gap shortens the list to the contiguous blocks ending at the head.
	w.mu.Lock()
	delete(w.blocks, 104)
	w.mu.Unlock()
	blocks, _ = w.snapshot(head, 100)
	if blocks.First != 105 || len(blocks.Hashes) != 6 {
		t.Fatalf("gap %+v", blocks)
	}
	// An empty window (head = P).
	blocks, entries = w.snapshot(BlockID{Number: 100, Hash: testBlock(100).Hash}, 100)
	if blocks.First != 101 || len(blocks.Hashes) != 0 || entries != nil {
		t.Fatalf("empty %+v", blocks)
	}
	// Reorgs and promotions report what they removed.
	if removed := w.truncateAbove(108); len(removed) != 2 || removed[0].Number != 109 || removed[1] != head {
		t.Fatalf("truncate %+v", removed)
	}
	if removed := w.pruneAtOrBelow(102); len(removed) != 2 || removed[0].Number != 101 || removed[1].Number != 102 {
		t.Fatalf("prune %+v", removed)
	}
}

func TestLiveWindowSnapshotCap(t *testing.T) {
	var w liveWindow
	w.add(windowBlocks(1, 2000, 0))
	blocks, _ := w.snapshot(BlockID{Number: 2000, Hash: testBlock(2000).Hash}, 0)
	if blocks.First != 2000-liveIndexBlocks+1 || len(blocks.Hashes) != liveIndexBlocks {
		t.Fatalf("capped %d %d", blocks.First, len(blocks.Hashes))
	}
}

func TestEncodeLiveIndex(t *testing.T) {
	var w liveWindow
	w.add(windowBlocks(101, 103, 3))
	blocks, entries := w.snapshot(BlockID{Number: 103, Hash: testBlock(103).Hash}, 100)
	data := encodeLiveIndex(blocks.First, 103, entries)
	if len(data) != liveIndexHeader+9*liveIndexEntry {
		t.Fatalf("%d bytes", len(data))
	}
	if string(data[:8]) != liveIndexMagic || binary.LittleEndian.Uint16(data[8:]) != 1 || binary.LittleEndian.Uint16(data[10:]) != 0 {
		t.Fatalf("header %x", data[:12])
	}
	if binary.LittleEndian.Uint64(data[12:]) != 101 || binary.LittleEndian.Uint64(data[20:]) != 103 || binary.LittleEndian.Uint32(data[28:]) != 9 {
		t.Fatalf("header %x", data[:32])
	}
	for i := range 9 {
		e := data[liveIndexHeader+i*liveIndexEntry:]
		if !bytes.Equal(e[:8], entries[i].prefix[:]) || binary.LittleEndian.Uint32(e[8:]) != entries[i].offset {
			t.Fatalf("entry %d: %x", i, e[:liveIndexEntry])
		}
	}
	// Same input, same bytes: the key fixes the content.
	if !bytes.Equal(data, encodeLiveIndex(blocks.First, 103, entries)) {
		t.Fatal("encoding is not deterministic")
	}
}

func TestLivePointersListBlocks(t *testing.T) {
	// publishPointers adds the window to the document; without a bucket nothing is written,
	// but the document it would write carries the hashes.
	d := &daemon{}
	d.window.add(windowBlocks(65, 66, 1))
	head := BlockID{Number: 66, Hash: testBlock(66).Hash}
	p := BlockID{Number: 64, Hash: testBlock(64).Hash}
	d.liveHead.Store(&head)
	d.promoted.Store(&p)
	doc := d.pointers(time.Now())
	blocks, entries := d.window.snapshot(*doc.Head, doc.Promoted.Number)
	doc.Blocks = &blocks
	data, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	b := got["blocks"].(map[string]any)
	if b["first"] != float64(65) || len(b["hashes"].([]any)) != 2 || b["hashes"].([]any)[1] != head.Hash {
		t.Fatalf("blocks %v", b)
	}
	if _, ok := got["tx_index"]; ok {
		t.Fatal("tx_index must be left out when no index object was written")
	}
	if len(entries) != 2 {
		t.Fatalf("%d entries", len(entries))
	}
	// A daemon without a window (older documents) leaves the member out.
	if data, _ := json.Marshal((&daemon{}).pointers(time.Now())); bytes.Contains(data, []byte("blocks")) {
		t.Fatalf("blocks in %s", data)
	}
	d.publishPointers() // no bucket: a no-op, not a panic
}
