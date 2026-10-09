package core

// Merges (docs/storage.md, "Index tiers", "State history" tiers, "Block bundles"): the
// daemon's compaction keeps a chain's history at a few dozen layers and index objects, and one
// segment and one witness range per complete chunk. Every merge reads the objects it replaces
// from R2 and writes new immutable objects; the replaced ones are deleted 7 days later.

import (
	"bytes"
	"container/heap"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"

	"github.com/klauspost/compress/zstd"
)

// ---- reading a state layer in (key, block) order ----

type layerEntry struct {
	key   []byte
	block uint64
	value []byte
}

// layerIter streams one domain of a layer.
type layerIter struct {
	src     objectSource
	dec     *zstd.Decoder
	packs   []ObjectRef
	pages   []dirEntry
	next    int
	entries []layerEntry
	at      int
	window  struct {
		pack     uint64
		lo       uint64
		data     []byte
		hasValue bool
	}
	order int // the layer's position, oldest first
}

const layerReadWindow = 8 << 20

func newLayerIter(src objectSource, dec *zstd.Decoder, d *stateDomainSummary, order int) (*layerIter, error) {
	it := &layerIter{src: src, dec: dec, packs: d.Packs, order: order}
	for _, root := range d.Root {
		raw, err := src.getRange(d.Index.Key, root.Record.Offset, root.Record.Length)
		if err != nil {
			return nil, err
		}
		plain, err := decodeFrame(dec, raw, root.Record)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", d.Index.Key, err)
		}
		pages, err := decodeIndexPage(plain)
		if err != nil {
			return nil, err
		}
		it.pages = append(it.pages, pages...)
	}
	return it, nil
}

func decodeFrame(dec *zstd.Decoder, raw []byte, r RecordOffset) ([]byte, error) {
	if sha256Hex(raw) != r.Sha256 {
		return nil, errors.New("frame digest mismatch")
	}
	plain, err := dec.DecodeAll(raw, make([]byte, 0, r.UncompressedLength))
	if err != nil || uint64(len(plain)) != r.UncompressedLength {
		return nil, errors.New("frame does not decode")
	}
	return plain, nil
}

func decodeIndexPage(plain []byte) ([]dirEntry, error) {
	r := bytes.NewReader(plain)
	n, err := binary.ReadUvarint(r)
	if err != nil {
		return nil, err
	}
	out := make([]dirEntry, 0, n)
	for range n {
		var d dirEntry
		kl, _ := binary.ReadUvarint(r)
		d.key = make([]byte, kl)
		if _, err := io.ReadFull(r, d.key); err != nil {
			return nil, err
		}
		d.block, _ = binary.ReadUvarint(r)
		d.pack, _ = binary.ReadUvarint(r)
		d.record.Offset, _ = binary.ReadUvarint(r)
		d.record.Length, _ = binary.ReadUvarint(r)
		ul, err := binary.ReadUvarint(r)
		if err != nil {
			return nil, err
		}
		d.record.UncompressedLength = ul
		var sum [32]byte
		if _, err := io.ReadFull(r, sum[:]); err != nil {
			return nil, err
		}
		d.record.Sha256 = hex.EncodeToString(sum[:])
		out = append(out, d)
	}
	return out, nil
}

// page reads a data page through an 8 MiB window over its pack.
func (it *layerIter) page(d dirEntry) ([]byte, error) {
	if int(d.pack) >= len(it.packs) {
		return nil, errors.New("data page outside the layer's packs")
	}
	w := &it.window
	end := d.record.Offset + d.record.Length
	if !w.hasValue || w.pack != d.pack || d.record.Offset < w.lo || end > w.lo+uint64(len(w.data)) {
		size := it.packs[d.pack].Bytes
		hi := min(max(d.record.Offset+layerReadWindow, end), size)
		data, err := it.src.getRange(it.packs[d.pack].Key, d.record.Offset, hi-d.record.Offset)
		if err != nil {
			return nil, err
		}
		w.pack, w.lo, w.data, w.hasValue = d.pack, d.record.Offset, data, true
	}
	raw := w.data[d.record.Offset-w.lo : end-w.lo]
	return decodeFrame(it.dec, raw, d.record)
}

// peek returns the next entry, or nil at the end.
func (it *layerIter) peek() (*layerEntry, error) {
	for it.at >= len(it.entries) {
		if it.next >= len(it.pages) {
			return nil, nil
		}
		plain, err := it.page(it.pages[it.next])
		if err != nil {
			return nil, err
		}
		it.next++
		it.entries, it.at = it.entries[:0], 0
		if it.entries, err = decodeDataPage(plain, it.entries); err != nil {
			return nil, err
		}
	}
	return &it.entries[it.at], nil
}

func decodeDataPage(plain []byte, out []layerEntry) ([]layerEntry, error) {
	r := bytes.NewReader(plain)
	for r.Len() > 0 {
		kl, err := binary.ReadUvarint(r)
		if err != nil {
			return nil, err
		}
		key := make([]byte, kl)
		if _, err := io.ReadFull(r, key); err != nil {
			return nil, err
		}
		n, err := binary.ReadUvarint(r)
		if err != nil {
			return nil, err
		}
		block := uint64(0)
		for range n {
			delta, err := binary.ReadUvarint(r)
			if err != nil {
				return nil, err
			}
			block += delta
			vl, err := binary.ReadUvarint(r)
			if err != nil {
				return nil, err
			}
			value := make([]byte, vl)
			if _, err := io.ReadFull(r, value); err != nil {
				return nil, err
			}
			out = append(out, layerEntry{key: key, block: block, value: value})
		}
	}
	return out, nil
}

type iterHeap []*layerIter

func (h iterHeap) Len() int { return len(h) }
func (h iterHeap) Less(i, j int) bool {
	a, b := &h[i].entries[h[i].at], &h[j].entries[h[j].at]
	if c := bytes.Compare(a.key, b.key); c != 0 {
		return c < 0
	}
	return h[i].order < h[j].order
}
func (h iterHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *iterHeap) Push(x any)   { *h = append(*h, x.(*layerIter)) }
func (h *iterHeap) Pop() any {
	old := *h
	x := old[len(old)-1]
	*h = old[:len(old)-1]
	return x
}

// mergeLayers merges contiguous layers (oldest first) into one layer at level.
func mergeLayers(src objectSource, layers []*stateLayer, refs []StateHistoryLayerRef, local localArchive, ns string, level uint32) (StateHistoryLayerRef, []ObjectRef, error) {
	first, last := refs[0].FirstBlock, refs[len(refs)-1].LastBlock
	dec, err := zstd.NewReader(nil)
	if err != nil {
		return StateHistoryLayerRef{}, nil, err
	}
	defer dec.Close()
	staging := fmt.Sprintf("%s/state/layers/%020d-%020d-building", ns, first, last)
	os.RemoveAll(local.path(staging))
	merged := &stateLayer{FirstBlock: first, LastBlock: last, Domains: map[string]*stateDomainSummary{}}
	for _, domain := range []string{"accounts", "storage", "code"} {
		h := &iterHeap{}
		for i, l := range layers {
			d := l.Domains[domain]
			if d == nil {
				return StateHistoryLayerRef{}, nil, fmt.Errorf("layer %d-%d has no %s domain", refs[i].FirstBlock, refs[i].LastBlock, domain)
			}
			it, err := newLayerIter(src, dec, d, i)
			if err != nil {
				return StateHistoryLayerRef{}, nil, err
			}
			if e, err := it.peek(); err != nil {
				return StateHistoryLayerRef{}, nil, err
			} else if e != nil {
				heap.Push(h, it)
			}
		}
		pw, err := newPageWriter(local, staging, domain)
		if err != nil {
			return StateHistoryLayerRef{}, nil, err
		}
		var cur []byte
		open := false
		for h.Len() > 0 {
			it := (*h)[0]
			e := it.entries[it.at]
			if !open || !bytes.Equal(e.key, cur) {
				if open {
					pw.endKey()
				}
				cur, open = e.key, true
				pw.beginKey(e.key)
				pw.addEntry(pageEntry{e.block, e.value})
			} else if domain != "code" {
				// Code is content-addressed: every layer holds the same entry at block 0.
				pw.addEntry(pageEntry{e.block, e.value})
			}
			it.at++
			if next, err := it.peek(); err != nil {
				return StateHistoryLayerRef{}, nil, err
			} else if next == nil {
				heap.Pop(h)
			} else {
				heap.Fix(h, 0)
			}
		}
		if open {
			pw.endKey()
		}
		summary, err := pw.finish()
		if err != nil {
			return StateHistoryLayerRef{}, nil, err
		}
		merged.Domains[domain] = summary
	}
	return writeLayerDescriptor(local, ns, staging, merged, level)
}

// writeLayerDescriptor names a built layer by its content-id and writes layer.json; it returns
// the manifest reference and every object to upload.
func writeLayerDescriptor(local localArchive, ns, staging string, layer *stateLayer, level uint32) (StateHistoryLayerRef, []ObjectRef, error) {
	final, err := finishLayerDir(local, staging, fmt.Sprintf("%s/state/layers/%020d-%020d", ns, layer.FirstBlock, layer.LastBlock), layer)
	if err != nil {
		return StateHistoryLayerRef{}, nil, err
	}
	descriptor, err := local.putJSON(final+"/layer.json", layer)
	if err != nil {
		return StateHistoryLayerRef{}, nil, err
	}
	var objs []ObjectRef
	for _, d := range layer.Domains {
		objs = append(objs, d.Packs...)
		objs = append(objs, d.Index, d.Filter)
	}
	objs = append(objs, descriptor)
	return StateHistoryLayerRef{FirstBlock: layer.FirstBlock, LastBlock: layer.LastBlock, Level: level, Descriptor: descriptor}, objs, nil
}

// ---- index merges ----

// indexLevel is an index object's tier: level ℓ covers batch × 4^ℓ blocks.
func indexLevel(first, last, batch uint64) int {
	span, level := last-first+1, 0
	for s := batch * 4; s <= span; s *= 4 {
		level++
	}
	return level
}

func mergeHashIndexObjects(src objectSource, objs []HashIndexObject, local localArchive, ns, tmp string) (HashIndexObject, []ObjectRef, error) {
	first, last := objs[0].FirstBlock, objs[len(objs)-1].LastBlock
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return HashIndexObject{}, nil, err
	}
	runDir, err := os.MkdirTemp(tmp, "hash-merge-")
	if err != nil {
		return HashIndexObject{}, nil, err
	}
	defer os.RemoveAll(runDir)
	txs, blks := newExtSorterKey(runDir, 1<<30, txSortKey), newExtSorterKey(runDir, 256<<20, blockSortKey)
	var txCount, blockCount uint64
	var key [txSortKey]byte
	for i := range objs {
		o := &objs[i]
		for _, tx := range []bool{true, false} {
			entries, err := readHashIndexEntries(src, o, tx)
			if err != nil {
				return HashIndexObject{}, nil, err
			}
			for _, e := range entries {
				for b := range 6 {
					key[b] = byte(e.key >> (8 * (5 - b)))
				}
				putUint40(key[6:11], e.block)
				if tx {
					key[11], key[12], key[13] = byte(e.index>>16), byte(e.index>>8), byte(e.index)
					if err := txs.add(key[:txSortKey], nil); err != nil {
						return HashIndexObject{}, nil, err
					}
					txCount++
				} else {
					if err := blks.add(key[:blockSortKey], nil); err != nil {
						return HashIndexObject{}, nil, err
					}
					blockCount++
				}
			}
		}
	}
	w := newHashIndexWriter(local, ns, first, last)
	for _, part := range []struct {
		tx    bool
		s     *extSorter
		count uint64
	}{{true, txs, txCount}, {false, blks, blockCount}} {
		w.begin(part.tx, part.count)
		err := mergeSorted([]*extSorter{part.s}, func(k, _ []byte) error {
			e := hashEntry{key: hashKey(k, hashIndexKeyBytes), block: getUint40(k[6:11])}
			if part.tx {
				e.index = uint32(k[11])<<16 | uint32(k[12])<<8 | uint32(k[13])
			}
			return w.push(e)
		})
		if err != nil {
			return HashIndexObject{}, nil, err
		}
		if err := w.end(); err != nil {
			return HashIndexObject{}, nil, err
		}
		part.s.release()
	}
	obj, err := w.finish()
	if err != nil {
		return obj, nil, err
	}
	return obj, refsOf(obj.objects()), nil
}

func mergeLogIndexObjects(src objectSource, objs []LogIndexObject, local localArchive, ns, tmp string) (LogIndexObject, []ObjectRef, error) {
	first, last := objs[0].FirstBlock, objs[len(objs)-1].LastBlock
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return LogIndexObject{}, nil, err
	}
	runDir, err := os.MkdirTemp(tmp, "log-merge-")
	if err != nil {
		return LogIndexObject{}, nil, err
	}
	defer os.RemoveAll(runDir)
	size := logIndexPartitionBlocks
	parts := logPartitionCount(first, last, size)
	counts := make([]uint64, parts)
	s := newExtSorterKey(runDir, 1<<30, logSortKey)
	var key [logSortKey]byte
	for i := range objs {
		entries, err := readLogIndexEntries(src, &objs[i])
		if err != nil {
			return LogIndexObject{}, nil, err
		}
		for _, e := range entries {
			p := e.block/size - first/size
			binary.BigEndian.PutUint32(key[:4], uint32(p))
			for b := range 6 {
				key[4+b] = byte(e.key >> (8 * (5 - b)))
			}
			putUint40(key[10:15], e.block)
			if err := s.add(key[:], nil); err != nil {
				return LogIndexObject{}, nil, err
			}
			counts[p]++
		}
	}
	w := newLogIndexWriter(local, ns, first, last)
	next := 0
	advance := func(to int) error {
		for ; next <= to; next++ {
			if next > 0 {
				if err := w.endPartition(); err != nil {
					return err
				}
			}
			if err := w.beginPartition(counts[next]); err != nil {
				return err
			}
		}
		return nil
	}
	var prev [logSortKey]byte
	started := false
	err = mergeSorted([]*extSorter{s}, func(k, _ []byte) error {
		if started && string(prev[:]) == string(k) {
			return nil
		}
		copy(prev[:], k)
		started = true
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
		return LogIndexObject{}, nil, err
	}
	s.release()
	obj, err := w.finish()
	if err != nil {
		return obj, nil, err
	}
	return obj, refsOf(obj.objects()), nil
}

// ---- chunk consolidation ----

// readSegmentBlocks reads every block frame of a segment, each checked against offsets.bin.
func readSegmentBlocks(src objectSource, s SegmentRef) ([]segmentBlock, string, error) {
	metaRaw, err := src.get(s.Meta.Key)
	if err != nil {
		return nil, "", err
	}
	if sha256Hex(metaRaw) != s.Meta.Sha256 {
		return nil, "", fmt.Errorf("%s does not match its reference", s.Meta.Key)
	}
	var meta BundleMetadata
	if err := json.Unmarshal(metaRaw, &meta); err != nil {
		return nil, "", err
	}
	offRef, packRef := meta.Files["offsets.bin"], meta.Files["blocks.pack"]
	offsets, err := src.get(offRef.Key)
	if err != nil {
		return nil, "", err
	}
	pack, err := src.get(packRef.Key)
	if err != nil {
		return nil, "", err
	}
	if sha256Hex(offsets) != offRef.Sha256 || sha256Hex(pack) != packRef.Sha256 {
		return nil, "", fmt.Errorf("segment %d-%d files do not match their references", s.First, s.Last)
	}
	n := s.Last - s.First + 1
	if uint64(len(offsets)) != n*offsetRecordLen {
		return nil, "", fmt.Errorf("segment %d-%d offsets.bin has the wrong size", s.First, s.Last)
	}
	out := make([]segmentBlock, n)
	for i := range n {
		rec := offsets[i*offsetRecordLen : (i+1)*offsetRecordLen]
		off := binary.LittleEndian.Uint64(rec[32:])
		length := uint64(binary.LittleEndian.Uint32(rec[40:]))
		data := pack[off : off+length]
		if sha256Hex(data) != hex.EncodeToString(rec[48:80]) {
			return nil, "", fmt.Errorf("block %d frame digest mismatch", s.First+i)
		}
		out[i] = segmentBlock{number: s.First + i, hash: "0x" + hex.EncodeToString(rec[:32]),
			record: frame{data: data, uncompressed: uint64(binary.LittleEndian.Uint32(rec[44:])), sha256: hex.EncodeToString(rec[48:80])}}
	}
	return out, meta.FirstParentHash, nil
}

// readWitnessFrames reads every frame of a witness range, each checked against offsets.bin.
func readWitnessFrames(src objectSource, w WitnessRange) ([]frame, error) {
	offsets, err := src.get(w.Offsets.Key)
	if err != nil {
		return nil, err
	}
	if sha256Hex(offsets) != w.Offsets.Sha256 {
		return nil, fmt.Errorf("%s does not match its reference", w.Offsets.Key)
	}
	packs := make([][]byte, len(w.Packs))
	for i, p := range w.Packs {
		if packs[i], err = src.get(p.Key); err != nil {
			return nil, err
		}
		if sha256Hex(packs[i]) != p.Sha256 {
			return nil, fmt.Errorf("%s does not match its reference", p.Key)
		}
	}
	n := w.Last - w.First + 1
	if uint64(len(offsets)) != n*witnessOffsetLen {
		return nil, fmt.Errorf("witness range %d-%d offsets.bin has the wrong size", w.First, w.Last)
	}
	out := make([]frame, n)
	for i := range n {
		rec := offsets[i*witnessOffsetLen : (i+1)*witnessOffsetLen]
		off := binary.LittleEndian.Uint64(rec[0:])
		length := uint64(binary.LittleEndian.Uint32(rec[8:]))
		pack := int(binary.LittleEndian.Uint16(rec[16:]))
		if pack >= len(packs) || off+length > uint64(len(packs[pack])) {
			return nil, fmt.Errorf("block %d witness outside its pack", w.First+i)
		}
		data := packs[pack][off : off+length]
		if sha256Hex(data) != hex.EncodeToString(rec[24:56]) {
			return nil, fmt.Errorf("block %d witness digest mismatch", w.First+i)
		}
		out[i] = frame{data: data, uncompressed: uint64(binary.LittleEndian.Uint32(rec[12:])), sha256: hex.EncodeToString(rec[24:56])}
	}
	return out, nil
}

func sortSegments(s []SegmentRef) {
	sort.Slice(s, func(i, j int) bool { return s[i].First < s[j].First })
}
