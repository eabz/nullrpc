package core

// Promotion and compaction (docs/dags.md, "Promotion"; docs/storage.md, "Promotion").
//
// promote moves finalized blocks P+1 … P′ from the spool into a new R2 generation: one
// segment and one witness range per chunk the blocks touch, a hash index object, a log index
// object and a level-0 state layer. compact runs in a goroutine per kind of merge, each
// publishing its own generation: a run of adjacent state layers, hash index objects or log
// index objects into one (mergeableRun picks the run: a daemon behind on compaction folds the
// small objects at the tail several at a time, small neighbours fold at once, and at the cap
// the closest-sized pair merges), or a complete chunk's segments and witness ranges into one.
// A merge reads, builds and uploads while the promotion and the other kinds' merges go on;
// commit then publishes it against the manifest of the moment, under the publish lock, as a
// promotion's commit does. Objects a new generation no longer names are deleted 7 days later.

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// promotion is the daemon's R2 writer. The promotion and the merges of each kind build and
// upload their objects concurrently, each in its own staging tree, and publish one at a time
// (commit).
type promotion struct {
	d      *daemon
	r2     *r2Archive
	gc     *gcList
	local  localArchive                 // the promotion's staging tree
	merges [mergeChunk + 1]localArchive // one staging tree per kind of merge
	tmp    [mergeChunk + 1]string       // and one directory for its sort runs
	mu     sync.Mutex                   // serializes commit: HEAD.json's read-modify-publish and what follows it
	merged chan struct{}                // a token per published merge, for a promotion waiting on a full list
}

func newPromotion(d *daemon, r2 *r2Archive, gc *gcList, spool string) *promotion {
	p := &promotion{d: d, r2: r2, gc: gc, local: localArchive{filepath.Join(spool, "stage")}, merged: make(chan struct{}, 1)}
	for kind := mergeStateLayers; kind <= mergeChunk; kind++ {
		p.merges[kind] = localArchive{filepath.Join(spool, "stage-merge-"+kind.dir())}
		p.tmp[kind] = filepath.Join(spool, "merge-"+kind.dir()+".tmp")
	}
	return p
}

// clearStage empties a staging tree.
func clearStage(local localArchive) error {
	if err := os.RemoveAll(local.root); err != nil {
		return err
	}
	return os.MkdirAll(local.root, 0o755)
}

// manifestObjectsLimit is the most objects a manifest's hash index or log index may list
// (checkHashIndex, checkLogIndex). A promotion against a full list waits for a merge.
const manifestObjectsLimit = 1024

var errManifestFull = errors.New("the manifest is full, waiting for a merge")

// maxFullWaits is how many merges (a minute at most each) a promotion waits for room.
const maxFullWaits = 30

func manifestFull(m *Manifest) error {
	if n := len(m.HashIndex.Objects); n >= manifestObjectsLimit {
		return fmt.Errorf("%w: %d hash index objects", errManifestFull, n)
	}
	if n := len(m.LogIndex.Objects); n >= manifestObjectsLimit {
		return fmt.Errorf("%w: %d log index objects", errManifestFull, n)
	}
	return nil
}

// promote publishes blocks P+1 … to.
func (p *promotion) promote(to BlockID, finalized BlockID) error {
	started := time.Now()
	_, _, m, err := p.r2.current()
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
	if err := clearStage(p.local); err != nil {
		return err
	}
	local, ns := p.local, p.r2.ns
	var segments []SegmentRef
	var ranges []WitnessRange
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
			block, receipts, err := splitRecord(b.Record, b.TxHashes, k)
			if err != nil {
				return fmt.Errorf("block %d: %w", b.Number, err)
			}
			seg = append(seg, segmentBlock{number: b.Number, hash: b.Hash, record: compressFrame(block), receipts: compressFrame(receipts)})
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
		segments = append(segments, SegmentRef{First: ref.FirstBlock, Last: ref.LastBlock, LastHash: ref.LastBlockHash, Meta: ref.Metadata})
		rng, wobjs, err := writeWitnessRange(local, ns, blocks[at].Number, frames)
		if err != nil {
			return err
		}
		upload = append(upload, refsOf(wobjs)...)
		ranges = append(ranges, rng)
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

	// The level-0 state layer.
	layerRef, lobjs, err := buildDiffLayer(local, ns, from, to.Number, blocks)
	if err != nil {
		return err
	}
	upload = append(upload, lobjs...)

	last := blocks[len(blocks)-1]
	if err := p.r2.upload(local, upload); err != nil {
		return err
	}
	tip := BlockAnchor{Number: last.Number, Hash: last.Hash, StateRoot: last.StateRoot}
	apply := func(cur *Manifest) (*Manifest, error) {
		if cur.ArchivedThrough != m.ArchivedThrough {
			return nil, fmt.Errorf("the archive moved from %d to %d during the promotion", m.ArchivedThrough.Number, cur.ArchivedThrough.Number)
		}
		if err := manifestFull(cur); err != nil {
			return nil, err
		}
		next := *cur
		next.Segments = append(append([]SegmentRef(nil), cur.Segments...), segments...)
		next.Witnesses.Ranges = append(append([]WitnessRange(nil), cur.Witnesses.Ranges...), ranges...)
		next.HashIndex = &HashIndex{KeyBytes: hashIndexKeyBytes, Objects: append(append([]HashIndexObject(nil), cur.HashIndex.Objects...), hobj)}
		next.LogIndex = &LogIndex{KeyBytes: logIndexKeyBytes, PartitionBlocks: logIndexPartitionBlocks,
			Objects: append(append([]LogIndexObject(nil), cur.LogIndex.Objects...), lobj)}
		next.StateHistory.Layers = append(append([]StateHistoryLayerRef(nil), cur.StateHistory.Layers...), layerRef)
		next.ArchivedThrough = tip
		next.FinalizedObserved = Anchor{Number: finalized.Number, Hash: finalized.Hash}
		return &next, nil
	}
	var next *Manifest
	for waits := 0; ; waits++ {
		next, err = p.commit(apply, func(next *Manifest) error { return p.d.afterPromotion(last.id(), next.Generation) })
		if !errors.Is(err, errManifestFull) || waits == maxFullWaits {
			break
		}
		// An index list is at the manifest's limit: the merge in flight makes room.
		fmt.Fprintf(os.Stderr, "{\"promotion_waits\":%q,\"to\":%d}\n", err.Error(), to.Number)
		select {
		case <-p.merged:
		case <-time.After(time.Minute):
		}
	}
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "{\"promoted\":%d,\"from\":%d,\"generation\":%d,\"objects\":%d,\"seconds\":%.1f}\n",
		last.Number, from, next.Generation, len(upload), time.Since(started).Seconds())
	return nil
}

// commit publishes the next generation. Under the publish lock it reads the current manifest,
// derives the next one from it with apply (a promotion appends its objects, a merge replaces
// the run it read), checks the indexes, publishes with If-Match on HEAD.json, and runs after
// (the live window's prune and the bookkeeping that must precede the next publish). The new
// objects were uploaded before: they are immutable and unreferenced until the publish names
// them, so a commit that fails leaves nothing wrong behind.
func (p *promotion) commit(apply func(cur *Manifest) (*Manifest, error), after func(next *Manifest) error) (*Manifest, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	head, etag, cur, err := p.r2.current()
	if err != nil {
		return nil, err
	}
	next, err := apply(cur)
	if err != nil {
		return nil, err
	}
	next.Generation = cur.Generation + 1
	next.Previous = &head.Manifest
	next.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	if err := checkHashIndex(p.r2.ns, next); err != nil {
		return nil, err
	}
	if err := checkLogIndex(p.r2.ns, next); err != nil {
		return nil, err
	}
	if _, _, err := p.r2.publish(next, etag); err != nil {
		return nil, err
	}
	if after != nil {
		if err := after(next); err != nil {
			return nil, err
		}
	}
	return next, nil
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

// ---- compaction ----

type mergeKind int

const (
	mergeNothing mergeKind = iota
	mergeStateLayers
	mergeHashIndex
	mergeLogIndex
	mergeChunk
)

func (k mergeKind) String() string {
	return [...]string{"nothing", "state layers", "hash index objects", "log index objects", "chunk"}[k]
}

func (k mergeKind) dir() string { return [...]string{"", "layers", "hash", "log", "chunk"}[k] }

// mergePlan is the next merge: a run of width objects at position at of one kind's list, or a
// complete chunk's segments and witness ranges.
type mergePlan struct {
	kind      mergeKind
	at, width int
	chunk     uint64
}

// planMerge chooses the next merge of one kind: the run mergeableRun picks in that kind's list,
// or, for mergeChunk, the oldest complete chunk with more than one segment. Each kind has its
// own compaction goroutine, so a run of one kind's merges cannot starve another's, as the
// fixed order of one loop did on mainnet (every promotion added a hash index object that
// merged first, and the log index reached 307 objects).
func (p *promotion) planMerge(m *Manifest, kind mergeKind) mergePlan {
	cfg := p.d.cfg
	run := func(n int, object func(int) (uint64, uint64, bool)) mergePlan {
		at, width := mergeableRun(n, cfg.maxObjects, cfg.batch, object)
		if at < 0 {
			return mergePlan{}
		}
		return mergePlan{kind: kind, at: at, width: width}
	}
	switch kind {
	case mergeStateLayers:
		ls := m.StateHistory.Layers
		return run(len(ls), func(i int) (uint64, uint64, bool) { return ls[i].FirstBlock, ls[i].LastBlock, ls[i].Level == baseLevel })
	case mergeHashIndex:
		// The first index object is the base (the backfill's).
		hs := m.HashIndex.Objects
		return run(len(hs), func(i int) (uint64, uint64, bool) { return hs[i].FirstBlock, hs[i].LastBlock, i == 0 })
	case mergeLogIndex:
		lo := m.LogIndex.Objects
		return run(len(lo), func(i int) (uint64, uint64, bool) { return lo[i].FirstBlock, lo[i].LastBlock, i == 0 })
	case mergeChunk:
		if chunk, ok := completeChunk(m); ok {
			return mergePlan{kind: mergeChunk, chunk: chunk}
		}
	}
	return mergePlan{}
}

var errRunGone = errors.New("the objects to merge are no longer in the manifest")

// compact runs the next merge of one kind (planMerge), if any, and publishes it. It reports
// whether it merged anything. The merge reads the objects of the manifest it planned on and
// builds the replacement while promotions and the other kinds' merges go on; commit then
// replaces the same objects, found by key, in the manifest of the moment.
func (p *promotion) compact(kind mergeKind) (bool, error) {
	_, _, m, err := p.r2.current()
	if err != nil {
		return false, err
	}
	plan := p.planMerge(m, kind)
	if plan.kind == mergeNothing {
		return false, nil
	}
	if err := clearStage(p.merges[kind]); err != nil {
		return false, err
	}
	local, ns, tmp := p.merges[kind], p.r2.ns, p.tmp[kind]
	defer os.RemoveAll(tmp)
	started := time.Now()
	var upload []ObjectRef
	var removed []string
	var apply func(cur *Manifest) (*Manifest, error)
	what := ""

	switch plan.kind {
	case mergeStateLayers:
		group := m.StateHistory.Layers[plan.at : plan.at+plan.width]
		layers := make([]*stateLayer, len(group))
		keys := make([]string, len(group))
		for i, ref := range group {
			if layers[i], err = p.r2.layer(ref); err != nil {
				return false, err
			}
			objs, err := p.r2.layerKeys(ref)
			if err != nil {
				return false, err
			}
			removed = append(removed, objs...)
			keys[i] = ref.Descriptor.Key
		}
		merged, objs, err := mergeLayers(p.r2.src, layers, group, local, ns, uint32(indexLevel(group[0].FirstBlock, group[len(group)-1].LastBlock, p.d.cfg.batch)))
		if err != nil {
			return false, err
		}
		upload = objs
		apply = func(cur *Manifest) (*Manifest, error) {
			ls := cur.StateHistory.Layers
			at, ok := runAt(len(ls), func(i int) string { return ls[i].Descriptor.Key }, keys)
			if !ok {
				return nil, errRunGone
			}
			next := *cur
			next.StateHistory.Layers = replaceRun(ls, at, plan.width, merged)
			return &next, nil
		}
		what = fmt.Sprintf("%d state layers %d-%d to level %d", len(group), merged.FirstBlock, merged.LastBlock, merged.Level)

	case mergeHashIndex:
		group := m.HashIndex.Objects[plan.at : plan.at+plan.width]
		keys := make([]string, len(group))
		for i, o := range group {
			removed = append(removed, hashIndexKeys(o)...)
			keys[i] = o.Transactions.Directory.Key
		}
		merged, objs, err := mergeHashIndexObjects(p.r2.src, group, local, ns, tmp)
		if err != nil {
			return false, err
		}
		upload = objs
		apply = func(cur *Manifest) (*Manifest, error) {
			hs := cur.HashIndex.Objects
			at, ok := runAt(len(hs), func(i int) string { return hs[i].Transactions.Directory.Key }, keys)
			if !ok {
				return nil, errRunGone
			}
			next := *cur
			next.HashIndex = &HashIndex{KeyBytes: hashIndexKeyBytes, Objects: replaceRun(hs, at, plan.width, merged)}
			return &next, nil
		}
		what = fmt.Sprintf("%d hash index objects %d-%d", len(group), merged.FirstBlock, merged.LastBlock)

	case mergeLogIndex:
		group := m.LogIndex.Objects[plan.at : plan.at+plan.width]
		keys := make([]string, len(group))
		for i, o := range group {
			removed = append(removed, logIndexKeys(o)...)
			keys[i] = o.Directory.Key
		}
		merged, objs, err := mergeLogIndexObjects(p.r2.src, group, local, ns, tmp)
		if err != nil {
			return false, err
		}
		upload = objs
		apply = func(cur *Manifest) (*Manifest, error) {
			lo := cur.LogIndex.Objects
			at, ok := runAt(len(lo), func(i int) string { return lo[i].Directory.Key }, keys)
			if !ok {
				return nil, errRunGone
			}
			next := *cur
			next.LogIndex = &LogIndex{KeyBytes: logIndexKeyBytes, PartitionBlocks: logIndexPartitionBlocks, Objects: replaceRun(lo, at, plan.width, merged)}
			return &next, nil
		}
		what = fmt.Sprintf("%d log index objects %d-%d", len(group), merged.FirstBlock, merged.LastBlock)

	case mergeChunk:
		chunk := plan.chunk
		segKeys, rangeKeys := map[string]bool{}, map[string]bool{}
		var segs []SegmentRef
		for _, s := range m.Segments {
			if s.First/m.ChunkBlocks == chunk {
				segs = append(segs, s)
				segKeys[s.Meta.Key] = true
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
		segment := SegmentRef{First: ref.FirstBlock, Last: ref.LastBlock, LastHash: ref.LastBlockHash, Meta: ref.Metadata}
		// The chunk's witness ranges become one.
		var frames []frame
		first := uint64(0)
		for _, w := range m.Witnesses.Ranges {
			if w.First/m.ChunkBlocks != chunk {
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
			rangeKeys[w.Offsets.Key] = true
		}
		rng, wobjs, err := writeWitnessRange(local, ns, first, frames)
		if err != nil {
			return false, err
		}
		upload = append(upload, refsOf(wobjs)...)
		apply = func(cur *Manifest) (*Manifest, error) {
			// The chunk must still consist of the segments and ranges that were read.
			var keep []SegmentRef
			found := 0
			for _, s := range cur.Segments {
				if s.First/cur.ChunkBlocks != chunk {
					keep = append(keep, s)
				} else if !segKeys[s.Meta.Key] {
					return nil, errRunGone
				} else {
					found++
				}
			}
			var keepW []WitnessRange
			foundW := 0
			for _, w := range cur.Witnesses.Ranges {
				if w.First/cur.ChunkBlocks != chunk {
					keepW = append(keepW, w)
				} else if !rangeKeys[w.Offsets.Key] {
					return nil, errRunGone
				} else {
					foundW++
				}
			}
			if found != len(segKeys) || foundW != len(rangeKeys) {
				return nil, errRunGone
			}
			next := *cur
			next.Segments = append(keep, segment)
			sortSegments(next.Segments)
			next.Witnesses.Ranges = append(keepW, rng)
			sort.Slice(next.Witnesses.Ranges, func(i, j int) bool { return next.Witnesses.Ranges[i].First < next.Witnesses.Ranges[j].First })
			return &next, nil
		}
		what = fmt.Sprintf("chunk %d: %d segments into one", chunk, len(segs))
	}

	if err := p.r2.upload(local, upload); err != nil {
		return false, err
	}
	next, err := p.commit(apply, func(next *Manifest) error {
		if err := p.gc.schedule(removed); err != nil {
			return err
		}
		p.d.generation.Store(next.Generation)
		return p.d.live.prune(next.ArchivedThrough.anchorID(), next.Generation)
	})
	if err != nil {
		if errors.Is(err, errRunGone) {
			// Another writer replaced them: the merged objects reference nothing.
			unreferenced := make([]string, len(upload))
			for i, ref := range upload {
				unreferenced[i] = ref.Key
			}
			p.gc.schedule(unreferenced)
		}
		return false, fmt.Errorf("merge %s: %w", what, err)
	}
	select {
	case p.merged <- struct{}{}:
	default:
	}
	fmt.Fprintf(os.Stderr, "{\"merged\":%q,\"generation\":%d,\"seconds\":%.1f}\n", what, next.Generation, time.Since(started).Seconds())
	return true, nil
}

// runAt finds keys as a run of adjacent objects in a list of n, each object named by key.
func runAt(n int, key func(int) string, keys []string) (int, bool) {
	for i := 0; i+len(keys) <= n; i++ {
		ok := true
		for j, k := range keys {
			if key(i+j) != k {
				ok = false
				break
			}
		}
		if ok {
			return i, true
		}
	}
	return -1, false
}

// mergeMaxWidth is the most objects one merge folds into one.
const mergeMaxWidth = 16

// mergeBudgetBatches bounds a wide merge (three or more objects) at this many batches of
// blocks, about a quarter of a mainnet chunk. A pair is not bounded: holding the cap needs the
// two largest objects above the base to merge whenever the history above it doubles.
const mergeBudgetBatches = 16

// mergeFixedCostBatches is a merge's cost besides the blocks it rewrites, in batches: reading
// and publishing a generation (HEAD.json, two manifests of a few MB on mainnet, the live
// window's prune) takes about as long as rewriting two batches of index entries.
const mergeFixedCostBatches = 2

// mergeableRun chooses, among n objects ordered by first block, the adjacent, contiguous objects
// the next merge folds into one, none of them the base:
//
//  1. when the count above the base exceeds maxObjects by two or more, the daemon is behind:
//     promotions landed faster than merges. Among the runs of 2 to mergeMaxWidth objects within
//     mergeBudgetBatches batches, the one removing the most objects per cost (its span plus
//     mergeFixedCostBatches batches) merges, when it has three or more objects: the small
//     objects at the tail fold together, several per generation, and the large ones are left
//     alone. Among the runs of one width, the smallest span, then the newest. When no run of
//     three is worth it (one or two small objects at the tail), rule 3 merges a pair instead,
//     so the larger objects keep merging while the tail is quiet;
//  2. otherwise, the widest run, up to mergeMaxWidth, whose combined span is at most a batch:
//     the small objects that max-age promotions and a catch-up's slices write (16 to 64 blocks
//     against a batch of 256) fold into one at once, before they count toward the cap;
//  3. otherwise, above the cap, the pair whose spans are closest (the lowest larger/smaller
//     ratio; ties go to the smaller pair, so the tail folds first). The spans then stay roughly
//     geometric, so the count holds at the cap and every block is rewritten about
//     log2(blocks/batch) times over its life. The oldest object above the base is rewritten
//     once each time the history above the base doubles.
//
// It returns the oldest object's position and the run's width, or -1 and 0 when nothing should
// merge.
func mergeableRun(n int, maxObjects, batch uint64, object func(int) (first, last uint64, base bool)) (int, int) {
	first, last, base := make([]uint64, n), make([]uint64, n), make([]bool, n)
	above := uint64(0)
	for i := 0; i < n; i++ {
		first[i], last[i], base[i] = object(i)
		if !base[i] {
			above++
		}
	}
	// span is the combined span of the run of width w at i, or 0 when the run breaks: a base
	// object or a gap.
	span := func(i, w int) uint64 {
		sum := uint64(0)
		for j := i; j < i+w; j++ {
			if base[j] || (j > i && first[j] != last[j-1]+1) {
				return 0
			}
			sum += last[j] - first[j] + 1
		}
		return sum
	}
	// smallest finds the run of width w with the smallest combined span, the newest among equals.
	smallest := func(w int) (int, uint64) {
		at, best := -1, uint64(0)
		for i := 0; i+w <= n; i++ {
			if s := span(i, w); s > 0 && (at < 0 || s <= best) {
				at, best = i, s
			}
		}
		return at, best
	}
	widest := min(n, mergeMaxWidth)
	behind := above > maxObjects
	if behind {
		bestAt, bestWidth, bestValue := -1, 0, 0.0
		for w := 2; w <= widest; w++ {
			at, s := smallest(w)
			if at < 0 || s > batch*mergeBudgetBatches {
				continue
			}
			if value := float64(w-1) / float64(s+batch*mergeFixedCostBatches); value > bestValue {
				bestAt, bestWidth, bestValue = at, w, value
			}
		}
		if bestWidth >= 3 {
			return bestAt, bestWidth
		}
	}
	if !behind {
		for w := widest; w >= 2; w-- {
			if at, s := smallest(w); at >= 0 && s <= batch {
				return at, w
			}
		}
		if above <= maxObjects {
			return -1, 0
		}
	}
	closest, closestRatio, closestSpan := -1, 0.0, uint64(0)
	for i := 1; i < n; i++ {
		if span(i-1, 2) == 0 {
			continue
		}
		older, newer := last[i-1]-first[i-1]+1, last[i]-first[i]+1
		if ratio := float64(max(older, newer)) / float64(min(older, newer)); closest < 0 || ratio < closestRatio || (ratio == closestRatio && older+newer <= closestSpan) {
			closest, closestRatio, closestSpan = i-1, ratio, older+newer
		}
	}
	if closest < 0 {
		return -1, 0
	}
	return closest, 2
}

// replaceRun returns list with the width objects at start replaced by merged, in place, so the
// manifest's lists stay ordered by first block and contiguous.
func replaceRun[T any](list []T, start, width int, merged T) []T {
	out := make([]T, 0, len(list)-width+1)
	out = append(out, list[:start]...)
	out = append(out, merged)
	return append(out, list[start+width:]...)
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
