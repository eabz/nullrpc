package core

import (
	"reflect"
	"testing"
)

// testLayers builds a state history from a level sequence (oldest first): a level-99 entry is
// the base; every other entry spans `span` blocks, or 4^level × span for a merged layer.
func testLayers(span uint64, levels ...uint32) []StateHistoryLayerRef {
	var ls []StateHistoryLayerRef
	next := uint64(0)
	for _, lv := range levels {
		n := span
		if lv == baseLevel {
			n = 1_000_000
		} else {
			n = span << (2 * lv)
		}
		ls = append(ls, StateHistoryLayerRef{FirstBlock: next, LastBlock: next + n - 1, Level: lv})
		next += n
	}
	return ls
}

func levelsOf(ls []StateHistoryLayerRef) []uint32 {
	out := make([]uint32, len(ls))
	for i, l := range ls {
		out[i] = l.Level
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

// drainLayers applies the daemon's layer selection until nothing merges, replacing each run by
// its merged layer as compact does. It returns the number of merges.
func drainLayers(t *testing.T, p *promotion, m *Manifest) int {
	t.Helper()
	merges := 0
	for {
		at := p.mergeableLayers(m)
		if at < 0 {
			return merges
		}
		group := m.StateHistory.Layers[at : at+mergeWidth]
		merged := StateHistoryLayerRef{FirstBlock: group[0].FirstBlock, LastBlock: group[len(group)-1].LastBlock, Level: group[0].Level + 1}
		m.StateHistory.Layers = replaceRun(m.StateHistory.Layers, at, merged)
		merges++
		ls := m.StateHistory.Layers
		checkContiguous(t, len(ls), func(i int) (uint64, uint64) { return ls[i].FirstBlock, ls[i].LastBlock })
		if merges > 1000 {
			t.Fatal("compaction does not converge")
		}
	}
}

// drainIndex does the same for hash index objects, whose level follows from their span.
func drainIndex(t *testing.T, p *promotion, objs []HashIndexObject) ([]HashIndexObject, int) {
	t.Helper()
	merges := 0
	for {
		at := p.mergeableIndex(len(objs), func(i int) (uint64, uint64) { return objs[i].FirstBlock, objs[i].LastBlock })
		if at < 0 {
			return objs, merges
		}
		group := objs[at : at+mergeWidth]
		objs = replaceRun(objs, at, HashIndexObject{FirstBlock: group[0].FirstBlock, LastBlock: group[len(group)-1].LastBlock})
		merges++
		checkContiguous(t, len(objs), func(i int) (uint64, uint64) { return objs[i].FirstBlock, objs[i].LastBlock })
		if merges > 1000 {
			t.Fatal("compaction does not converge")
		}
	}
}

func testPromotion() *promotion {
	return &promotion{d: &daemon{cfg: daemonConfig{batch: 256}}}
}

func TestMergeableRunPrefersLowestLevelThenOldest(t *testing.T) {
	p := testPromotion()
	cases := []struct {
		levels []uint32
		want   int
	}{
		{[]uint32{baseLevel, 0, 0, 0}, -1},                  // three is not a run
		{[]uint32{baseLevel, 0, 0, 0, 0}, 1},                // the old rule's case
		{[]uint32{baseLevel, 0, 0, 0, 0, 0}, 1},             // the oldest run, not the newest
		{[]uint32{baseLevel, 1, 1, 1, 1, 0, 0, 0, 0}, 5},    // the lowest level first
		{[]uint32{baseLevel, 0, 0, 0, 1, 0, 0, 0, 0, 1}, 5}, // a merged layer in the middle strands nothing
		{[]uint32{baseLevel, 0, 0, 0, 1, 0, 0, 0}, -1},      // no run of four of one level
		{[]uint32{baseLevel, 1, 1, 1, 1, 0, 0, 0}, 1},       // only the level-1 run qualifies
		{[]uint32{baseLevel, baseLevel, baseLevel, baseLevel, baseLevel}, -1},
		{[]uint32{0, 0, 0, 0}, 0}, // no base at all
	}
	for _, c := range cases {
		m := &Manifest{StateHistory: StateHistory{Layers: testLayers(32, c.levels...)}}
		if got := p.mergeableLayers(m); got != c.want {
			t.Errorf("levels %v: run at %d, want %d", c.levels, got, c.want)
		}
	}
	// A gap between layers of one level breaks the run.
	m := &Manifest{StateHistory: StateHistory{Layers: testLayers(32, baseLevel, 0, 0, 0, 0)}}
	m.StateHistory.Layers[3].FirstBlock++
	if got := p.mergeableLayers(m); got != -1 {
		t.Errorf("gap: run at %d", got)
	}
}

func TestReplaceRunKeepsOrder(t *testing.T) {
	list := []int{10, 20, 30, 40, 50, 60, 70}
	if got := replaceRun(list, 2, 99); !reflect.DeepEqual(got, []int{10, 20, 99, 70}) {
		t.Fatalf("middle: %v", got)
	}
	if got := replaceRun(list, 0, 99); !reflect.DeepEqual(got, []int{99, 50, 60, 70}) {
		t.Fatalf("start: %v", got)
	}
	if got := replaceRun(list, 3, 99); !reflect.DeepEqual(got, []int{10, 20, 30, 99}) {
		t.Fatalf("end: %v", got)
	}
	if !reflect.DeepEqual(list, []int{10, 20, 30, 40, 50, 60, 70}) {
		t.Fatal("the input changed")
	}
}

// The pattern the old rule (the newest four only) stranded on Hoodi: once a merged level-1
// layer sat between older level-0 layers and the newest promotions, nothing older than the
// newest four was ever considered again.
func TestCompactionDrainsStrandedLayers(t *testing.T) {
	p := testPromotion()
	levels := []uint32{baseLevel}
	for range 49 {
		levels = append(levels, 0)
	}
	levels = append(levels, 1)
	for range 15 {
		levels = append(levels, 0)
	}
	levels = append(levels, 1, 0, 0)
	m := &Manifest{StateHistory: StateHistory{Layers: testLayers(32, levels...)}}
	if n := len(m.StateHistory.Layers); n != 69 {
		t.Fatalf("%d layers", n)
	}
	// The old rule finds nothing: the newest four are 0, 1, 0, 0.
	ls := m.StateHistory.Layers
	if tail := levelsOf(ls[len(ls)-4:]); !reflect.DeepEqual(tail, []uint32{0, 1, 0, 0}) {
		t.Fatalf("tail %v", tail)
	}
	merges := drainLayers(t, p, m)
	// 49 level-0 layers: twelve merges into level 1 leave one level 0; those twelve merge into
	// three level 2. The 15 level-0 layers: three merges leave three level 0; with the level 1
	// after them they make a run of four level 1, one more level 2. Every merge removes three.
	want := []uint32{baseLevel, 2, 2, 2, 0, 2, 0, 0, 0, 1, 0, 0}
	if got := levelsOf(m.StateHistory.Layers); !reflect.DeepEqual(got, want) {
		t.Fatalf("after %d merges: %v\nwant %v", merges, got, want)
	}
	if merges != (69-len(want))/3 || merges != 19 {
		t.Fatalf("%d merges", merges)
	}
	// Four more promotions make the newest run merge first (lowest level), then its level-1
	// neighbours: the tail keeps folding as the chain grows.
	for range 4 {
		last := m.StateHistory.Layers[len(m.StateHistory.Layers)-1].LastBlock
		m.StateHistory.Layers = append(m.StateHistory.Layers, StateHistoryLayerRef{FirstBlock: last + 1, LastBlock: last + 32})
	}
	drainLayers(t, p, m)
	want = []uint32{baseLevel, 2, 2, 2, 0, 2, 0, 0, 0, 1, 1, 0, 0}
	if got := levelsOf(m.StateHistory.Layers); !reflect.DeepEqual(got, want) {
		t.Fatalf("after four promotions: %v\nwant %v", got, want)
	}
}

// Index objects have no stored level: it follows from the span, so four small level-0 objects
// merge into a level-0 object that keeps folding its neighbours in until it spans a level-1
// tier (1024 blocks at a batch of 256).
func TestCompactionDrainsStrandedIndex(t *testing.T) {
	p := testPromotion()
	objs := []HashIndexObject{{FirstBlock: 0, LastBlock: 999_999}}
	add := func(span uint64) {
		last := objs[len(objs)-1].LastBlock
		objs = append(objs, HashIndexObject{FirstBlock: last + 1, LastBlock: last + span})
	}
	for range 57 {
		add(48)
	}
	add(1056)
	add(1068)
	add(48)
	add(48)
	if len(objs) != 62 {
		t.Fatalf("%d objects", len(objs))
	}
	// The old rule finds nothing: the newest four are at levels 1, 1, 0, 0.
	objs, merges := drainIndex(t, p, objs)
	var levels, spans []int
	for i, o := range objs {
		if i == 0 {
			continue
		}
		levels = append(levels, indexLevel(o.FirstBlock, o.LastBlock, 256))
		spans = append(spans, int(o.LastBlock-o.FirstBlock+1))
	}
	// 22 objects of 48 blocks fold into one of 1056 (level 1), twice; the 13 left fold into one
	// of 624 blocks, still level 0, with no fourth level-0 neighbour; then the backlog's two
	// level-1 objects and the two newest promotions.
	wantLevels := []int{1, 1, 0, 1, 1, 0, 0}
	wantSpans := []int{1056, 1056, 624, 1056, 1068, 48, 48}
	if !reflect.DeepEqual(levels, wantLevels) || !reflect.DeepEqual(spans, wantSpans) {
		t.Fatalf("after %d merges: levels %v spans %v", merges, levels, spans)
	}
	if merges != (62-len(objs))/3 {
		t.Fatalf("%d merges for %d objects", merges, len(objs))
	}
}
