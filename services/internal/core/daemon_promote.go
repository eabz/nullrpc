package core

// Promotion and compaction (docs/dags.md, "Promotion"; docs/storage.md, "Promotion").
//
// promote moves finalized blocks P+1 … P′ from the spool into a new R2 generation: one
// segment and one witness range per chunk the blocks touch, a hash index object, a log index
// object and a level-0 state layer. compact then runs one merge at a time, each publishing
// its own generation: two adjacent state layers, hash index objects or log index objects into
// one (mergeablePair: small neighbours fold at once, and the closest-sized pair merges while
// more than max-objects objects sit above the base), or a complete chunk's segments and witness
// ranges into one.
// Objects a new generation no longer names are deleted 7 days later.

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// promotion is the daemon's R2 writer: one goroutine, so generations are published one at a
// time.
type promotion struct {
	d     *daemon
	r2    *r2Archive
	gc    *gcList
	local localArchive
}

func (p *promotion) stage() (localArchive, error) {
	if err := os.RemoveAll(p.local.root); err != nil {
		return p.local, err
	}
	return p.local, os.MkdirAll(p.local.root, 0o755)
}

// promote publishes blocks P+1 … to. It returns the new last promoted block.
func (p *promotion) promote(to BlockID, finalized BlockID) error {
	started := time.Now()
	head, etag, m, err := p.r2.current()
	if err != nil {
		return err
	}
	from := m.ArchivedThrough.Number + 1
	if to.Number < from {
		return nil
	}
	// Blocks from the spool, linked to the archive tip.
	ids, err := p.d.spool.list(spoolLive)
	if err != nil {
		return err
	}
	var blocks []*liveBlock
	prev := m.ArchivedThrough.Hash
	for _, id := range ids {
		if id.Number < from || id.Number > to.Number {
			continue
		}
		b, err := p.d.spool.read(spoolLive, id)
		if err != nil {
			return err
		}
		if b.Number != from+uint64(len(blocks)) || b.Parent != prev {
			return fmt.Errorf("spool block %d does not follow %s; promotion needs %d … %d", b.Number, prev, from, to.Number)
		}
		blocks = append(blocks, b)
		prev = b.Hash
	}
	if len(blocks) == 0 || blocks[len(blocks)-1].Number != to.Number || prev != to.Hash {
		return fmt.Errorf("spool does not hold blocks %d … %d", from, to.Number)
	}
	local, err := p.stage()
	if err != nil {
		return err
	}
	ns := p.r2.ns
	next := *m
	next.Segments = append([]SegmentRef(nil), m.Segments...)
	next.Witnesses.Ranges = append([]WitnessRange(nil), m.Witnesses.Ranges...)
	next.StateHistory.Layers = append([]StateHistoryLayerRef(nil), m.StateHistory.Layers...)
	var upload []ObjectRef

	// Segments and witness ranges, split at chunk boundaries.
	k := newKeccak()
	firstParent := m.ArchivedThrough.Hash
	for at := 0; at < len(blocks); {
		chunk := blocks[at].Number / m.ChunkBlocks
		end := at
		for end < len(blocks) && blocks[end].Number/m.ChunkBlocks == chunk {
			end++
		}
		seg := make([]segmentBlock, 0, end-at)
		frames := make([]frame, 0, end-at)
		for _, b := range blocks[at:end] {
			seg = append(seg, segmentBlock{number: b.Number, hash: b.Hash, record: compressFrame(b.Record)})
			frames = append(frames, compressFrame(b.Witness))
		}
		ref, err := writeSegment(local, ns, chunk, firstParent, seg)
		if err != nil {
			return err
		}
		objs, err := chunkObjects(local, ref)
		if err != nil {
			return err
		}
		upload = append(upload, refsOf(objs)...)
		next.Segments = append(next.Segments, SegmentRef{First: ref.FirstBlock, Last: ref.LastBlock, LastHash: ref.LastBlockHash, Meta: ref.Metadata})
		rng, wobjs, err := writeWitnessRange(local, ns, blocks[at].Number, frames)
		if err != nil {
			return err
		}
		upload = append(upload, refsOf(wobjs)...)
		next.Witnesses.Ranges = append(next.Witnesses.Ranges, rng)
		firstParent = blocks[end-1].Hash
		at = end
	}

	// Hash index and log index objects.
	var txs, blks []hashEntry
	var logs []logEntry
	for _, b := range blocks {
		h, err := decodeData(b.Hash, 32)
		if err != nil {
			return err
		}
		blks = append(blks, hashEntry{key: hashKey(h, hashIndexKeyBytes), block: b.Number})
		for i, t := range b.TxHashes {
			th, err := decodeData(t, 32)
			if err != nil {
				return err
			}
			txs = append(txs, hashEntry{key: hashKey(th, hashIndexKeyBytes), block: b.Number, index: uint32(i)})
		}
		keys, err := blockLogKeys(b.Record, b.Hash, b.Number, k)
		if err != nil {
			return err
		}
		for _, kk := range keys {
			logs = append(logs, logEntry{key: kk, block: b.Number})
		}
	}
	hobj, err := writeHashIndexEntries(local, ns, from, to.Number, txs, blks)
	if err != nil {
		return err
	}
	upload = append(upload, refsOf(hobj.objects())...)
	lobj, err := writeLogIndexEntries(local, ns, from, to.Number, logs)
	if err != nil {
		return err
	}
	upload = append(upload, refsOf(lobj.objects())...)
	next.HashIndex = &HashIndex{KeyBytes: hashIndexKeyBytes, Objects: append(append([]HashIndexObject(nil), m.HashIndex.Objects...), hobj)}
	next.LogIndex = &LogIndex{KeyBytes: logIndexKeyBytes, PartitionBlocks: logIndexPartitionBlocks,
		Objects: append(append([]LogIndexObject(nil), m.LogIndex.Objects...), lobj)}

	// The level-0 state layer.
	layerRef, lobjs, err := buildDiffLayer(local, ns, from, to.Number, blocks)
	if err != nil {
		return err
	}
	upload = append(upload, lobjs...)
	next.StateHistory.Layers = append(next.StateHistory.Layers, layerRef)

	last := blocks[len(blocks)-1]
	next.Generation = m.Generation + 1
	next.Previous = &head.Manifest
	next.ArchivedThrough = BlockAnchor{Number: last.Number, Hash: last.Hash, StateRoot: last.StateRoot}
	next.FinalizedObserved = Anchor{Number: finalized.Number, Hash: finalized.Hash}
	next.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	if err := checkHashIndex(ns, &next); err != nil {
		return err
	}
	if err := checkLogIndex(ns, &next); err != nil {
		return err
	}
	if err := p.r2.upload(local, upload); err != nil {
		return err
	}
	if _, _, err := p.r2.publish(&next, etag); err != nil {
		return err
	}
	if err := p.d.afterPromotion(last.id(), next.Generation); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "{\"promoted\":%d,\"from\":%d,\"generation\":%d,\"objects\":%d,\"seconds\":%.1f}\n",
		last.Number, from, next.Generation, len(upload), time.Since(started).Seconds())
	return nil
}

// buildDiffLayer writes the state history layer of blocks from … to from their diffs: each
// key's value at the end of every block that changed it.
func buildDiffLayer(local localArchive, ns string, from, to uint64, blocks []*liveBlock) (StateHistoryLayerRef, []ObjectRef, error) {
	type versions struct {
		key     []byte
		entries []pageEntry
	}
	domains := map[byte]map[string]*versions{diffAccounts: {}, diffStorage: {}, diffCode: {}}
	for _, b := range blocks {
		for _, e := range b.Diff {
			m := domains[e.Domain]
			if m == nil {
				return StateHistoryLayerRef{}, nil, fmt.Errorf("block %d: unknown diff domain %d", b.Number, e.Domain)
			}
			v := m[string(e.Key)]
			if v == nil {
				v = &versions{key: e.Key}
				m[string(e.Key)] = v
			}
			if e.Domain == diffCode {
				if len(v.entries) == 0 {
					v.entries = append(v.entries, pageEntry{0, e.Value}) // content-addressed: block 0
				}
				continue
			}
			if n := len(v.entries); n > 0 && bytes.Equal(v.entries[n-1].value, e.Value) {
				continue
			}
			v.entries = append(v.entries, pageEntry{b.Number, e.Value})
		}
	}
	staging := fmt.Sprintf("%s/state/layers/%020d-%020d-building", ns, from, to)
	layer := &stateLayer{FirstBlock: from, LastBlock: to, Domains: map[string]*stateDomainSummary{}}
	for name, domain := range map[string]byte{"accounts": diffAccounts, "storage": diffStorage, "code": diffCode} {
		list := make([]*versions, 0, len(domains[domain]))
		for _, v := range domains[domain] {
			list = append(list, v)
		}
		sort.Slice(list, func(i, j int) bool { return bytes.Compare(list[i].key, list[j].key) < 0 })
		pw, err := newPageWriter(local, staging, name)
		if err != nil {
			return StateHistoryLayerRef{}, nil, err
		}
		for _, v := range list {
			if err := pw.addKey(v.key, v.entries); err != nil {
				return StateHistoryLayerRef{}, nil, err
			}
		}
		summary, err := pw.finish()
		if err != nil {
			return StateHistoryLayerRef{}, nil, err
		}
		layer.Domains[name] = summary
	}
	return writeLayerDescriptor(local, ns, staging, layer, 0)
}

// compact runs at most one merge and publishes it. It reports whether it merged anything.
func (p *promotion) compact() (bool, error) {
	head, etag, m, err := p.r2.current()
	if err != nil {
		return false, err
	}
	local, err := p.stage()
	if err != nil {
		return false, err
	}
	ns, tmp := p.r2.ns, filepath.Join(p.d.cfg.spool, "merge.tmp")
	defer os.RemoveAll(tmp)
	next := *m
	var upload []ObjectRef
	var removed []string
	what := ""
	layerAt := p.mergeableLayers(m)
	hashAt := p.mergeableIndex(len(m.HashIndex.Objects), func(i int) (uint64, uint64) {
		o := m.HashIndex.Objects[i]
		return o.FirstBlock, o.LastBlock
	})
	logAt := p.mergeableIndex(len(m.LogIndex.Objects), func(i int) (uint64, uint64) {
		o := m.LogIndex.Objects[i]
		return o.FirstBlock, o.LastBlock
	})

	switch {
	case layerAt >= 0:
		group := m.StateHistory.Layers[layerAt : layerAt+mergeWidth]
		layers := make([]*stateLayer, len(group))
		for i, ref := range group {
			if layers[i], err = p.r2.layer(ref); err != nil {
				return false, err
			}
			keys, err := p.r2.layerKeys(ref)
			if err != nil {
				return false, err
			}
			removed = append(removed, keys...)
		}
		merged, objs, err := mergeLayers(p.r2.src, layers, group, local, ns, uint32(indexLevel(group[0].FirstBlock, group[len(group)-1].LastBlock, p.d.cfg.batch)))
		if err != nil {
			return false, err
		}
		upload = objs
		next.StateHistory.Layers = replaceRun(m.StateHistory.Layers, layerAt, merged)
		what = fmt.Sprintf("state layers %d-%d to level %d", merged.FirstBlock, merged.LastBlock, merged.Level)

	case hashAt >= 0:
		group := m.HashIndex.Objects[hashAt : hashAt+mergeWidth]
		for _, o := range group {
			removed = append(removed, hashIndexKeys(o)...)
		}
		merged, objs, err := mergeHashIndexObjects(p.r2.src, group, local, ns, tmp)
		if err != nil {
			return false, err
		}
		upload = objs
		next.HashIndex = &HashIndex{KeyBytes: hashIndexKeyBytes, Objects: replaceRun(m.HashIndex.Objects, hashAt, merged)}
		what = fmt.Sprintf("hash index %d-%d", merged.FirstBlock, merged.LastBlock)

	case logAt >= 0:
		group := m.LogIndex.Objects[logAt : logAt+mergeWidth]
		for _, o := range group {
			removed = append(removed, logIndexKeys(o)...)
		}
		merged, objs, err := mergeLogIndexObjects(p.r2.src, group, local, ns, tmp)
		if err != nil {
			return false, err
		}
		upload = objs
		next.LogIndex = &LogIndex{KeyBytes: logIndexKeyBytes, PartitionBlocks: logIndexPartitionBlocks,
			Objects: replaceRun(m.LogIndex.Objects, logAt, merged)}
		what = fmt.Sprintf("log index %d-%d", merged.FirstBlock, merged.LastBlock)

	default:
		chunk, ok := completeChunk(m)
		if !ok {
			return false, nil
		}
		var segs []SegmentRef
		var keep []SegmentRef
		for _, s := range m.Segments {
			if s.First/m.ChunkBlocks == chunk {
				segs = append(segs, s)
			} else {
				keep = append(keep, s)
			}
		}
		var blocks []segmentBlock
		firstParent := ""
		for i, s := range segs {
			bs, parent, err := readSegmentBlocks(p.r2.src, s)
			if err != nil {
				return false, err
			}
			if i == 0 {
				firstParent = parent
			}
			blocks = append(blocks, bs...)
			keys, err := p.r2.segmentKeys(s)
			if err != nil {
				return false, err
			}
			removed = append(removed, keys...)
		}
		ref, err := writeSegment(local, ns, chunk, firstParent, blocks)
		if err != nil {
			return false, err
		}
		objs, err := chunkObjects(local, ref)
		if err != nil {
			return false, err
		}
		upload = refsOf(objs)
		next.Segments = append(keep, SegmentRef{First: ref.FirstBlock, Last: ref.LastBlock, LastHash: ref.LastBlockHash, Meta: ref.Metadata})
		sortSegments(next.Segments)
		// The chunk's witness ranges become one.
		var frames []frame
		var keepW []WitnessRange
		first := uint64(0)
		for _, w := range m.Witnesses.Ranges {
			if w.First/m.ChunkBlocks != chunk {
				keepW = append(keepW, w)
				continue
			}
			if len(frames) == 0 {
				first = w.First
			}
			fs, err := readWitnessFrames(p.r2.src, w)
			if err != nil {
				return false, err
			}
			frames = append(frames, fs...)
			removed = append(removed, witnessKeys(w)...)
		}
		rng, wobjs, err := writeWitnessRange(local, ns, first, frames)
		if err != nil {
			return false, err
		}
		upload = append(upload, refsOf(wobjs)...)
		next.Witnesses.Ranges = append(keepW, rng)
		sort.Slice(next.Witnesses.Ranges, func(i, j int) bool { return next.Witnesses.Ranges[i].First < next.Witnesses.Ranges[j].First })
		what = fmt.Sprintf("chunk %d: %d segments into one", chunk, len(segs))
	}

	started := time.Now()
	next.Generation = m.Generation + 1
	next.Previous = &head.Manifest
	next.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	if err := checkHashIndex(ns, &next); err != nil {
		return false, err
	}
	if err := checkLogIndex(ns, &next); err != nil {
		return false, err
	}
	if err := p.r2.upload(local, upload); err != nil {
		return false, err
	}
	if _, _, err := p.r2.publish(&next, etag); err != nil {
		return false, err
	}
	if err := p.gc.schedule(removed); err != nil {
		return false, err
	}
	if err := p.d.live.prune(next.ArchivedThrough.anchorID(), next.Generation); err != nil {
		return false, err
	}
	fmt.Fprintf(os.Stderr, "{\"merged\":%q,\"generation\":%d,\"seconds\":%.1f}\n", what, next.Generation, time.Since(started).Seconds())
	return true, nil
}

// mergeWidth is how many adjacent objects a merge folds into one.
const mergeWidth = 2

// mergeableLayers picks the state layers the next merge replaces (mergeablePair), returning
// the older one's position in the manifest, or -1. The base (level 99) never merges.
func (p *promotion) mergeableLayers(m *Manifest) int {
	ls := m.StateHistory.Layers
	return mergeablePair(len(ls), p.d.cfg.maxObjects, p.d.cfg.batch, func(i int) (uint64, uint64, bool) {
		l := ls[i]
		return l.FirstBlock, l.LastBlock, l.Level == baseLevel
	})
}

// mergeableIndex picks the index objects the next merge replaces, likewise; the first object is
// the base (the backfill's).
func (p *promotion) mergeableIndex(n int, span func(int) (uint64, uint64)) int {
	return mergeablePair(n, p.d.cfg.maxObjects, p.d.cfg.batch, func(i int) (uint64, uint64, bool) {
		f, l := span(i)
		return f, l, i == 0
	})
}

// mergeablePair chooses, among n objects ordered by first block, the two adjacent, contiguous
// objects the next merge folds into one, neither the base:
//
//  1. the pair with the smallest combined span, when that span is at most a batch: the small
//     objects that max-age promotions write fold into their neighbour at once, before they
//     count toward the cap;
//  2. otherwise, when more than maxObjects objects sit above the base, the pair whose spans are
//     closest (the lowest larger/smaller ratio; ties go to the smaller pair, so the tail
//     folds first). The spans then stay roughly geometric, so the count holds at the cap and every
//     block is rewritten about log2(blocks/batch) times over its life. The oldest object above
//     the base is rewritten once each time the history above the base doubles.
//
// It returns the older object's position, or -1 when nothing should merge.
func mergeablePair(n int, maxObjects, batch uint64, object func(int) (first, last uint64, base bool)) int {
	small, smallSpan := -1, uint64(0)
	closest, closestRatio, closestSpan := -1, 0.0, uint64(0)
	above := uint64(0)
	for i := 0; i < n; i++ {
		f, l, base := object(i)
		if base {
			continue
		}
		above++
		if i == 0 {
			continue
		}
		pf, pl, pbase := object(i - 1)
		if pbase || f != pl+1 {
			continue
		}
		older, newer := pl-pf+1, l-f+1
		if sum := older + newer; sum <= batch && (small < 0 || sum <= smallSpan) {
			small, smallSpan = i-1, sum
		}
		if ratio := float64(max(older, newer)) / float64(min(older, newer)); closest < 0 || ratio < closestRatio || (ratio == closestRatio && older+newer <= closestSpan) {
			closest, closestRatio, closestSpan = i-1, ratio, older+newer
		}
	}
	switch {
	case small >= 0:
		return small
	case above > maxObjects:
		return closest
	}
	return -1
}

// replaceRun returns list with the mergeWidth objects at start replaced by merged, in place, so
// the manifest's lists stay ordered by first block and contiguous.
func replaceRun[T any](list []T, start int, merged T) []T {
	out := make([]T, 0, len(list)-mergeWidth+1)
	out = append(out, list[:start]...)
	out = append(out, merged)
	return append(out, list[start+mergeWidth:]...)
}

// completeChunk finds a chunk wholly at or below the archive tip that has more than one
// segment.
func completeChunk(m *Manifest) (uint64, bool) {
	count := map[uint64]int{}
	for _, s := range m.Segments {
		count[s.First/m.ChunkBlocks]++
	}
	var chunks []uint64
	for c, n := range count {
		if n > 1 && (c+1)*m.ChunkBlocks-1 <= m.ArchivedThrough.Number {
			chunks = append(chunks, c)
		}
	}
	if len(chunks) == 0 {
		return 0, false
	}
	sort.Slice(chunks, func(i, j int) bool { return chunks[i] < chunks[j] })
	return chunks[0], true
}

func (a BlockAnchor) anchorID() BlockID { return BlockID{Number: a.Number, Hash: a.Hash} }
