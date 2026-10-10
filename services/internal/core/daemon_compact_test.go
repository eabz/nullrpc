package core

import (
	"math/rand"
	"reflect"
	"testing"
)

// testLayers builds a state history from a sequence of spans (oldest first); a span of 0 is
// the base.
func testLayers(spans ...uint64) []StateHistoryLayerRef {
	var ls []StateHistoryLayerRef
	next := uint64(0)
	for _, n := range spans {
		ref := StateHistoryLayerRef{FirstBlock: next}
		if n == 0 {
			n, ref.Level = 1_000_000, baseLevel
		}
		ref.LastBlock = next + n - 1
		ls = append(ls, ref)
		next += n
	}
	return ls
}

func spansOf(ls []StateHistoryLayerRef) []uint64 {
	out := make([]uint64, len(ls))
	for i, l := range ls {
		out[i] = l.LastBlock - l.FirstBlock + 1
	}
	return out
}

// checkContiguous fails unless the list is ordered by first block without gaps or overlaps,
// which is what the Worker's state reader and checkHashIndex expect.
func checkContiguous(t *testing.T, n int, span func(int) (uint64, uint64)) {
	t.Helper()
	for i := 1; i < n; i++ {
		_, pl := span(i - 1)
		f, _ := span(i)
		if f != pl+1 {
			t.Fatalf("object %d starts at %d, the one before ends at %d", i, f, pl)
		}
	}
}

// mergeStats sums what a simulated compaction rewrote.
type mergeStats struct {
	merges, promoted, merged, largest uint64
}

func (s *mergeStats) note(span uint64) {
	s.merges++
	s.merged += span
	s.largest = max(s.largest, span)
}

func testPromotion() *promotion {
	return &promotion{d: &daemon{cfg: daemonConfig{batch: 256, maxObjects: 6}}}
}

// layerRun and indexRun are the daemon's selection for one kind, as planMerge sees it.
func layerRun(p *promotion, m *Manifest) (int, int) {
	ls := m.StateHistory.Layers
	return mergeableRun(len(ls), p.d.cfg.maxObjects, p.d.cfg.batch, func(i int) (uint64, uint64, bool) {
		return ls[i].FirstBlock, ls[i].LastBlock, ls[i].Level == baseLevel
	})
}

func indexRun(p *promotion, objs []HashIndexObject) (int, int) {
	return mergeableRun(len(objs), p.d.cfg.maxObjects, p.d.cfg.batch, func(i int) (uint64, uint64, bool) {
		return objs[i].FirstBlock, objs[i].LastBlock, i == 0
	})
}

func mergedLayer(group []StateHistoryLayerRef, batch uint64) StateHistoryLayerRef {
	first, last := group[0].FirstBlock, group[len(group)-1].LastBlock
	return StateHistoryLayerRef{FirstBlock: first, LastBlock: last, Level: uint32(indexLevel(first, last, batch))}
}

// drainLayers applies the daemon's layer selection until nothing merges, replacing each run by
// its merged layer as compact does.
func drainLayers(t *testing.T, p *promotion, m *Manifest, st *mergeStats) {
	t.Helper()
	for n := 0; ; n++ {
		at, width := layerRun(p, m)
		if at < 0 {
			return
		}
		if n > 1000 {
			t.Fatal("compaction does not converge")
		}
		merged := mergedLayer(m.StateHistory.Layers[at:at+width], p.d.cfg.batch)
		m.StateHistory.Layers = replaceRun(m.StateHistory.Layers, at, width, merged)
		st.note(merged.LastBlock - merged.FirstBlock + 1)
		ls := m.StateHistory.Layers
		checkContiguous(t, len(ls), func(i int) (uint64, uint64) { return ls[i].FirstBlock, ls[i].LastBlock })
	}
}

// drainIndex does the same for hash index objects.
func drainIndex(t *testing.T, p *promotion, objs []HashIndexObject, st *mergeStats) []HashIndexObject {
	t.Helper()
	for n := 0; ; n++ {
		at, width := indexRun(p, objs)
		if at < 0 {
			return objs
		}
		if n > 1000 {
			t.Fatal("compaction does not converge")
		}
		group := objs[at : at+width]
		merged := HashIndexObject{FirstBlock: group[0].FirstBlock, LastBlock: group[len(group)-1].LastBlock}
		objs = replaceRun(objs, at, width, merged)
		st.note(merged.LastBlock - merged.FirstBlock + 1)
		checkContiguous(t, len(objs), func(i int) (uint64, uint64) { return objs[i].FirstBlock, objs[i].LastBlock })
	}
}

func TestMergeableRun(t *testing.T) {
	p := testPromotion()
	cases := []struct {
		spans     []uint64 // 0 is the base
		at, width int
	}{
		{[]uint64{0}, -1, 0},
		{[]uint64{0, 300}, -1, 0},
		{[]uint64{0, 48, 48}, 1, 2},                                         // two small objects fold at once
		{[]uint64{0, 300, 48, 48, 300}, 2, 2},                               // the small pair, wherever it is
		{[]uint64{0, 300, 16, 16, 16, 16, 300}, 2, 4},                       // a run of small objects folds in one merge
		{[]uint64{0, 190, 16, 16, 16, 16, 300}, 1, 5},                       // the widest run within a batch wins
		{[]uint64{0, 300, 300, 300, 300, 300, 300}, -1, 0},                  // six above the base: at the cap
		{[]uint64{0, 300, 300, 300, 300, 300, 300, 300}, 1, 7},              // seven: all seven fold, since objects removed per cost favours the widest run
		{[]uint64{0, 4000, 1000, 1000, 300, 300, 300, 300}, 4, 4},           // the four 300s fold; 1000/1000 is not worth more
		{[]uint64{0, 4000, 2000, 1000, 500, 400, 300, 260}, 4, 4},           // 500 to 260 fold
		{[]uint64{0, 4000, 2000, 1000, 500, 400, 300, 1000}, 4, 3},          // one over the cap: the three smallest fold
		{[]uint64{4000, 2000, 1000, 500, 400, 300, 260}, 3, 4},              // no base at all: the first object counts; the four smallest fold
		{[]uint64{0, 0, 300, 300, 300, 300, 300, 300, 300}, 2, 7},           // bases never merge; the seven equal objects fold at once
		{[]uint64{0, 300, 300, 300, 300, 300, 300, 300, 300, 300}, 1, 9},    // a backlog of three: the most objects per cost, all nine
		{[]uint64{0, 9000, 9000, 9000, 9000, 9000, 9000, 9000, 9000}, 7, 2}, // over the budget: the closest pair, the newest among equals
		{[]uint64{0, 4000, 4000, 4000, 4000, 4000, 4000, 32}, 5, 2},         // a quiet tail: no run of three within the budget, so the closest pair, the newest among equals
		{[]uint64{0, 4000, 4000, 4000, 4000, 4000, 200, 200, 16, 32}, 6, 4}, // behind: the small tail folds, the large ones stay
	}
	for _, c := range cases {
		m := &Manifest{StateHistory: StateHistory{Layers: testLayers(c.spans...)}}
		if at, width := layerRun(p, m); at != c.at || width != c.width {
			t.Errorf("spans %v: run %d+%d, want %d+%d", c.spans, at, width, c.at, c.width)
		}
	}
	// A gap between objects breaks the pair.
	m := &Manifest{StateHistory: StateHistory{Layers: testLayers(0, 48, 48)}}
	m.StateHistory.Layers[2].FirstBlock++
	if at, _ := layerRun(p, m); at != -1 {
		t.Errorf("gap: run at %d", at)
	}
	// A deep backlog of small objects: sixteen at a time, within a batch.
	spans := []uint64{0}
	for range 300 {
		spans = append(spans, 16)
	}
	m = &Manifest{StateHistory: StateHistory{Layers: testLayers(spans...)}}
	if at, width := layerRun(p, m); width != mergeMaxWidth || at != 301-mergeMaxWidth {
		t.Errorf("300 small layers: run %d+%d", at, width)
	}
}

func TestReplaceRunKeepsOrder(t *testing.T) {
	list := []int{10, 20, 30, 40, 50}
	if got := replaceRun(list, 2, 2, 99); !reflect.DeepEqual(got, []int{10, 20, 99, 50}) {
		t.Fatalf("middle: %v", got)
	}
	if got := replaceRun(list, 0, 2, 99); !reflect.DeepEqual(got, []int{99, 30, 40, 50}) {
		t.Fatalf("start: %v", got)
	}
	if got := replaceRun(list, 3, 2, 99); !reflect.DeepEqual(got, []int{10, 20, 30, 99}) {
		t.Fatalf("end: %v", got)
	}
	if got := replaceRun(list, 1, 3, 99); !reflect.DeepEqual(got, []int{10, 99, 50}) {
		t.Fatalf("wide: %v", got)
	}
	if !reflect.DeepEqual(list, []int{10, 20, 30, 40, 50}) {
		t.Fatal("the input changed")
	}
}

// The pattern the newest-four rule stranded on Hoodi: once a merged layer sat between older
// small layers and the newest promotions, nothing older than the newest four was considered.
func TestCompactionDrainsStrandedLayers(t *testing.T) {
	p := testPromotion()
	spans := []uint64{0}
	for range 49 {
		spans = append(spans, 48)
	}
	spans = append(spans, 256)
	for range 15 {
		spans = append(spans, 48)
	}
	spans = append(spans, 240, 48, 48)
	m := &Manifest{StateHistory: StateHistory{Layers: testLayers(spans...)}}
	if n := len(m.StateHistory.Layers); n != 69 {
		t.Fatalf("%d layers", n)
	}
	var st mergeStats
	drainLayers(t, p, m, &st)
	ls := m.StateHistory.Layers
	if len(ls) > 7 || ls[0].Level != baseLevel {
		t.Fatalf("after %d merges: %d layers, spans %v", st.merges, len(ls), spansOf(ls))
	}
	t.Logf("69 layers drain to %d in %d merges (spans %v), rewriting %d blocks", len(ls), st.merges, spansOf(ls), st.merged)
}

// 200 promotions of the sizes Hoodi's max-age rule produces, compacted after each as the daemon
// does: the count above the base never exceeds max-objects once compaction has run, and
// exceeds it by at most one (the promotion itself) before.
func TestCompactionHoldsTheCap(t *testing.T) {
	p := testPromotion()
	cap := p.d.cfg.maxObjects
	sizes := []uint64{32, 48, 48, 64, 64, 80, 96, 256}
	rnd := rand.New(rand.NewSource(1))
	m := &Manifest{StateHistory: StateHistory{Layers: testLayers(0)}}
	objs := []HashIndexObject{{FirstBlock: 0, LastBlock: 999_999}}
	var lst, ist mergeStats
	for i := 0; i < 200; i++ {
		span := sizes[rnd.Intn(len(sizes))]
		last := m.StateHistory.Layers[len(m.StateHistory.Layers)-1].LastBlock
		m.StateHistory.Layers = append(m.StateHistory.Layers, StateHistoryLayerRef{FirstBlock: last + 1, LastBlock: last + span})
		objs = append(objs, HashIndexObject{FirstBlock: last + 1, LastBlock: last + span})
		lst.promoted += span
		ist.promoted += span
		if n := uint64(len(m.StateHistory.Layers)) - 1; n > cap+1 {
			t.Fatalf("promotion %d: %d layers above the base before compaction", i, n)
		}
		drainLayers(t, p, m, &lst)
		objs = drainIndex(t, p, objs, &ist)
		if n := uint64(len(m.StateHistory.Layers)) - 1; n > cap {
			t.Fatalf("promotion %d: %d layers above the base after compaction", i, n)
		}
		if n := uint64(len(objs)) - 1; n > cap {
			t.Fatalf("promotion %d: %d index objects above the base after compaction", i, n)
		}
		if m.StateHistory.Layers[0].Level != baseLevel || objs[0].FirstBlock != 0 || objs[0].LastBlock != 999_999 {
			t.Fatal("the base changed")
		}
	}
	ls := m.StateHistory.Layers
	t.Logf("layers after 200 promotions (%d blocks): spans %v; %d merges rewrote %d blocks (%.1fx), largest %d",
		lst.promoted, spansOf(ls), lst.merges, lst.merged, float64(lst.merged)/float64(lst.promoted), lst.largest)
	t.Logf("index: %d objects, %d merges rewrote %d blocks (%.1fx), largest %d", len(objs), ist.merges, ist.merged, float64(ist.merged)/float64(ist.promoted), ist.largest)
	// Every merged layer's level follows from its span, like an index object's.
	for _, l := range ls[1:] {
		if want := uint32(indexLevel(l.FirstBlock, l.LastBlock, 256)); l.Level != want && l.LastBlock-l.FirstBlock+1 > 256 {
			t.Fatalf("layer %d-%d has level %d, want %d", l.FirstBlock, l.LastBlock, l.Level, want)
		}
	}
	// The write amplification stays logarithmic: well under 10x for 200 promotions.
	if lst.merged > 10*lst.promoted {
		t.Fatalf("layers rewritten %d times the promoted blocks", lst.merged/lst.promoted)
	}
}

// ---- the three kinds together, against promotions ----

// testManifest builds a manifest whose three capped kinds have the given spans (oldest first,
// the first of each the base), all starting at block 0 and contiguous.
func testManifest(layers, hash, log []uint64) *Manifest {
	m := &Manifest{}
	for i, span := range layers {
		ref := StateHistoryLayerRef{FirstBlock: m.ArchivedThrough.Number, LastBlock: m.ArchivedThrough.Number + span - 1}
		if i == 0 {
			ref.Level = baseLevel
		}
		m.StateHistory.Layers = append(m.StateHistory.Layers, ref)
		m.ArchivedThrough.Number += span
	}
	m.HashIndex, m.LogIndex = &HashIndex{}, &LogIndex{}
	next := uint64(0)
	for _, span := range hash {
		m.HashIndex.Objects = append(m.HashIndex.Objects, HashIndexObject{FirstBlock: next, LastBlock: next + span - 1})
		next += span
	}
	next = 0
	for _, span := range log {
		m.LogIndex.Objects = append(m.LogIndex.Objects, LogIndexObject{FirstBlock: next, LastBlock: next + span - 1})
		next += span
	}
	m.ArchivedThrough.Number--
	return m
}

// mainnetManifest has the shape of Ethereum mainnet's manifest 925 (2026-10-10): 6 layers,
// 16 hash index objects and 306 log index objects above the base, the log index all 16- and
// 32-block slices that catch-ups promoted and compaction never reached.
func mainnetManifest() *Manifest {
	const base = 26_151_043
	layers := []uint64{base, 1878, 112, 3616, 192, 1891, 256}
	hash := []uint64{base, 294, 720, 112, 752, 112, 1136, 144, 656, 112, 704, 112, 752, 192, 1363, 272, 512}
	// The log index: 173 slices of 16 and 122 of 32, interleaved, with manifest 925's larger
	// ones (four of 48, two of 64, 80, 195) among them; 7,945 blocks above the base, like the
	// other two kinds.
	log := []uint64{base, 166}
	larger := map[int]uint64{40: 48, 90: 48, 140: 48, 190: 48, 120: 64, 220: 64, 150: 80, 280: 195}
	sixteens, thirtytwos := 0, 0
	for i := 0; i < 303; i++ {
		if span, ok := larger[i]; ok {
			log = append(log, span)
			continue
		}
		if thirtytwos < 122 && (sixteens >= 173 || (thirtytwos+1)*173 <= (sixteens+1)*122) {
			log = append(log, 32)
			thirtytwos++
		} else {
			log = append(log, 16)
			sixteens++
		}
	}
	log = append(log, 256, 256)
	return testManifest(layers, hash, log)
}

func counts(m *Manifest) [3]int {
	return [3]int{len(m.StateHistory.Layers) - 1, len(m.HashIndex.Objects) - 1, len(m.LogIndex.Objects) - 1}
}

// planSpan is the blocks a planned merge rewrites.
func planSpan(m *Manifest, plan mergePlan) uint64 {
	var first, last uint64
	switch plan.kind {
	case mergeStateLayers:
		first, last = m.StateHistory.Layers[plan.at].FirstBlock, m.StateHistory.Layers[plan.at+plan.width-1].LastBlock
	case mergeHashIndex:
		first, last = m.HashIndex.Objects[plan.at].FirstBlock, m.HashIndex.Objects[plan.at+plan.width-1].LastBlock
	case mergeLogIndex:
		first, last = m.LogIndex.Objects[plan.at].FirstBlock, m.LogIndex.Objects[plan.at+plan.width-1].LastBlock
	}
	return last - first + 1
}

// applyPlan replaces the planned run by its merged object, as a merge's commit does.
func applyPlan(t *testing.T, m *Manifest, plan mergePlan, batch uint64) {
	t.Helper()
	switch plan.kind {
	case mergeStateLayers:
		ls := m.StateHistory.Layers
		m.StateHistory.Layers = replaceRun(ls, plan.at, plan.width, mergedLayer(ls[plan.at:plan.at+plan.width], batch))
		checkContiguous(t, len(m.StateHistory.Layers), func(i int) (uint64, uint64) {
			return m.StateHistory.Layers[i].FirstBlock, m.StateHistory.Layers[i].LastBlock
		})
	case mergeHashIndex:
		hs := m.HashIndex.Objects
		m.HashIndex.Objects = replaceRun(hs, plan.at, plan.width, HashIndexObject{FirstBlock: hs[plan.at].FirstBlock, LastBlock: hs[plan.at+plan.width-1].LastBlock})
		checkContiguous(t, len(m.HashIndex.Objects), func(i int) (uint64, uint64) {
			return m.HashIndex.Objects[i].FirstBlock, m.HashIndex.Objects[i].LastBlock
		})
	case mergeLogIndex:
		lo := m.LogIndex.Objects
		m.LogIndex.Objects = replaceRun(lo, plan.at, plan.width, LogIndexObject{FirstBlock: lo[plan.at].FirstBlock, LastBlock: lo[plan.at+plan.width-1].LastBlock})
		checkContiguous(t, len(m.LogIndex.Objects), func(i int) (uint64, uint64) {
			return m.LogIndex.Objects[i].FirstBlock, m.LogIndex.Objects[i].LastBlock
		})
	default:
		t.Fatalf("plan %v", plan)
	}
}

// appendPromotion adds a promotion of span blocks: one object of each kind.
func appendPromotion(m *Manifest, span uint64) {
	first := m.ArchivedThrough.Number + 1
	last := first + span - 1
	m.StateHistory.Layers = append(m.StateHistory.Layers, StateHistoryLayerRef{FirstBlock: first, LastBlock: last})
	m.HashIndex.Objects = append(m.HashIndex.Objects, HashIndexObject{FirstBlock: first, LastBlock: last})
	m.LogIndex.Objects = append(m.LogIndex.Objects, LogIndexObject{FirstBlock: first, LastBlock: last})
	m.ArchivedThrough.Number = last
}

type simResult struct {
	generations, merges int
	drainedAt           int        // the generation at which every kind first fit under the cap, or -1
	drainedAfter        float64    // seconds
	kindDrainedAfter    [3]float64 // seconds until each kind first fit under the cap, or -1
	peak, peakAfter     [3]int     // the most objects above the base per kind: overall, and after the kind drained
	meanAfter           [3]float64 // the time-averaged count above the base per kind after it drained
	widest              int
	rewritten           uint64  // blocks merges rewrote
	longest             float64 // the longest merge, in seconds
}

// simulate runs the daemon's loops against a clock: a promotion every promoteEvery seconds (its
// blocks cycling through promoteSpans) and, concurrently, one merge per kind at a time, each
// taking mergeTime of its span. The promotion's objects append while merges run, and a merge's
// commit replaces the run it planned, as compact does.
func simulate(t *testing.T, p *promotion, m *Manifest, promoteEvery float64, promoteSpans []uint64, mergeTime func(span uint64) float64, duration float64) simResult {
	t.Helper()
	cap := int(p.d.cfg.maxObjects)
	res := simResult{drainedAt: -1, kindDrainedAfter: [3]float64{-1, -1, -1}}
	clock, nextPromotion, promotions := 0.0, promoteEvery, 0
	kinds := []mergeKind{mergeStateLayers, mergeHashIndex, mergeLogIndex}
	running := map[mergeKind]*mergePlan{}
	ends := map[mergeKind]float64{}
	last, lastCounts := 0.0, counts(m)
	var weighted [3]float64
	note := func() {
		c := counts(m)
		under := true
		for k := range c {
			res.peak[k] = max(res.peak[k], c[k])
			under = under && c[k] <= cap
			if res.kindDrainedAfter[k] < 0 && c[k] <= cap {
				res.kindDrainedAfter[k] = clock
			}
			if res.kindDrainedAfter[k] >= 0 {
				res.peakAfter[k] = max(res.peakAfter[k], c[k])
				weighted[k] += float64(lastCounts[k]) * (clock - last)
				res.meanAfter[k] = weighted[k] / max(clock-res.kindDrainedAfter[k], 1)
			}
		}
		if res.drainedAt < 0 && under {
			res.drainedAt, res.drainedAfter = res.generations, clock
		}
		last, lastCounts = clock, c
	}
	note()
	for clock < duration {
		for _, kind := range kinds {
			if running[kind] != nil {
				continue
			}
			if plan := p.planMerge(m, kind); plan.kind != mergeNothing {
				span := planSpan(m, plan)
				if plan.width > 2 && span > p.d.cfg.batch*mergeBudgetBatches {
					t.Fatalf("a merge of %d objects rewrites %d blocks, over the budget", plan.width, span)
				}
				running[kind], ends[kind] = &plan, clock+mergeTime(span)
				res.widest = max(res.widest, plan.width)
				res.longest = max(res.longest, mergeTime(span))
				res.rewritten += span
			}
		}
		// The next event: the earliest merge to finish, or the promotion.
		var done mergeKind
		at := nextPromotion
		for _, kind := range kinds {
			if running[kind] != nil && ends[kind] < at {
				done, at = kind, ends[kind]
			}
		}
		clock = at
		if done != mergeNothing {
			applyPlan(t, m, *running[done], p.d.cfg.batch)
			running[done] = nil
			res.merges++
		} else {
			nextPromotion += promoteEvery
			appendPromotion(m, promoteSpans[promotions%len(promoteSpans)])
			promotions++
		}
		res.generations++
		note()
	}
	return res
}

// Each kind plans on its own list; mainnet's log index backlog folds many objects at a time.
func TestPlanMergePerKind(t *testing.T) {
	p := testPromotion()
	m := mainnetManifest()
	if c := counts(m); c != [3]int{6, 16, 306} {
		t.Fatalf("mainnet shape: %v", c)
	}
	if plan := p.planMerge(m, mergeLogIndex); plan.kind != mergeLogIndex || plan.width < 8 {
		t.Fatalf("mainnet log index: %s, %d objects", plan.kind, plan.width)
	}
	if plan := p.planMerge(m, mergeHashIndex); plan.kind != mergeHashIndex || plan.width < 3 {
		t.Fatalf("mainnet hash index: %s, %d objects", plan.kind, plan.width)
	}
	if plan := p.planMerge(m, mergeStateLayers); plan.kind != mergeNothing {
		t.Fatalf("mainnet layers, at the cap: %v", plan)
	}
	// A small pair folds even under the cap.
	m = testManifest([]uint64{100, 48, 48}, []uint64{100, 300}, []uint64{100, 300})
	if plan := p.planMerge(m, mergeStateLayers); plan.kind != mergeStateLayers || plan.at != 1 || plan.width != 2 {
		t.Fatalf("small pair: %v", plan)
	}
	// A complete chunk with two segments; nothing once it has one.
	m.ChunkBlocks = 100
	m.Segments = []SegmentRef{{First: 0, Last: 49}, {First: 50, Last: 99}, {First: 100, Last: 195}}
	if plan := p.planMerge(m, mergeChunk); plan.kind != mergeChunk || plan.chunk != 0 {
		t.Fatalf("chunk: %v", plan)
	}
	m.Segments = m.Segments[2:]
	if plan := p.planMerge(m, mergeChunk); plan.kind != mergeNothing {
		t.Fatalf("nothing: %v", plan)
	}
}

// Mainnet's cadence, exaggerated: a promotion every minute writes a 16- to 48-block slice of
// each kind while every merge takes longer than a minute, starting from mainnet's backlog. The
// three kinds must drain to the cap and stay near it: a merge that folds a run of slices
// removes several objects, and each kind has its own merge loop, so the merges keep up with
// one object a minute per kind.
func TestCompactionKeepsUpWithPromotion(t *testing.T) {
	p := testPromotion()
	cap := int(p.d.cfg.maxObjects)
	m := mainnetManifest()
	mergeTime := func(span uint64) float64 { return 75 + 0.02*float64(span) }
	res := simulate(t, p, m, 60, []uint64{16, 32, 16, 32, 48}, mergeTime, 12*3600)
	t.Logf("kinds drained after %.0f, %.0f and %.0f min; %d generations, %d merges (widest %d, longest %.0f s, %d blocks rewritten); peak %v, after draining %v, mean after %.1f %.1f %.1f; final %v",
		res.kindDrainedAfter[0]/60, res.kindDrainedAfter[1]/60, res.kindDrainedAfter[2]/60, res.generations, res.merges, res.widest, res.longest, res.rewritten,
		res.peak, res.peakAfter, res.meanAfter[0], res.meanAfter[1], res.meanAfter[2], counts(m))
	// A promotion lands during every merge, so a kind is over the cap by the promotions that
	// landed during its current merge: one or two, and up to seven during the merge that
	// doubles its oldest objects. The mean stays within two of the cap; the backlog never
	// returns.
	during := int(res.longest/60) + 1
	for k := range res.kindDrainedAfter {
		if res.kindDrainedAfter[k] < 0 || res.kindDrainedAfter[k] > 90*60 {
			t.Fatalf("kind %d did not drain within 90 minutes", k)
		}
		if res.peakAfter[k] > cap+during+1 {
			t.Fatalf("kind %d reached %d objects above the base after draining, %d promotions in its longest merge", k, res.peakAfter[k], during)
		}
		if res.meanAfter[k] > float64(cap)+2 {
			t.Fatalf("kind %d averaged %.1f objects above the base after draining", k, res.meanAfter[k])
		}
	}
}

// Mainnet as it runs: a 256-block promotion every 51 minutes, merges of 15 s plus 10 ms per
// block (gen. 892 to 925 took 12 to 62 s each). From manifest 925's backlog the log index
// drains within the first promotion interval, and the counts then hold at the cap.
func TestCompactionDrainsMainnetBacklog(t *testing.T) {
	p := testPromotion()
	cap := int(p.d.cfg.maxObjects)
	m := mainnetManifest()
	mergeTime := func(span uint64) float64 { return 15 + 0.01*float64(span) }
	res := simulate(t, p, m, 51*60, []uint64{256}, mergeTime, 24*3600)
	t.Logf("drained at generation %d after %.1f min (%d merges, widest %d, %d blocks rewritten); %d generations in 24 h; peak after draining %v; final %v, layer spans %v",
		res.drainedAt, res.drainedAfter/60, res.drainedAt, res.widest, res.rewritten, res.generations, res.peakAfter, counts(m), spansOf(m.StateHistory.Layers))
	if res.drainedAt < 0 || res.drainedAt > 60 || res.drainedAfter > 51*60 {
		t.Fatalf("the backlog did not drain before the next promotion")
	}
	for k, n := range res.peakAfter {
		if n > cap+1 {
			t.Fatalf("kind %d reached %d objects above the base after draining", k, n)
		}
	}
}

// A catch-up as mainnet's on 2026-10-10 00:22 to 00:57: 140 slices of 16 or 32 blocks promoted
// 10 to 15 s apart (the follower's extraction window), then the usual cadence. Compaction
// keeps the counts to a few dozen during the burst and drains them within the hour after.
func TestCompactionAbsorbsACatchUp(t *testing.T) {
	p := testPromotion()
	cap := int(p.d.cfg.maxObjects)
	m := testManifest([]uint64{26_151_043, 256}, []uint64{26_151_043, 256}, []uint64{26_151_043, 256})
	mergeTime := func(span uint64) float64 { return 15 + 0.01*float64(span) }
	burst := simulate(t, p, m, 12, []uint64{16, 32, 16, 32, 16}, mergeTime, 140*12)
	t.Logf("after the burst: %d generations, %d merges, peak %v, counts %v", burst.generations, burst.merges, burst.peak, counts(m))
	after := simulate(t, p, m, 51*60, []uint64{256}, mergeTime, 3*3600)
	t.Logf("after it: drained at generation %d after %.1f min; final %v", after.drainedAt, after.drainedAfter/60, counts(m))
	for k, n := range burst.peak {
		if n > 40 {
			t.Fatalf("kind %d reached %d objects above the base during the burst", k, n)
		}
	}
	if after.drainedAt < 0 || after.drainedAfter > 3600 {
		t.Fatalf("the burst did not drain within the hour")
	}
	if c := counts(m); c[0] > cap+1 || c[1] > cap+1 || c[2] > cap+1 {
		t.Fatalf("final counts %v", c)
	}
}
