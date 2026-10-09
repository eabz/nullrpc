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

// drainLayers applies the daemon's layer selection until nothing merges, replacing each pair by
// its merged layer as compact does.
func drainLayers(t *testing.T, p *promotion, m *Manifest, st *mergeStats) {
	t.Helper()
	for n := 0; ; n++ {
		at := p.mergeableLayers(m)
		if at < 0 {
			return
		}
		if n > 1000 {
			t.Fatal("compaction does not converge")
		}
		group := m.StateHistory.Layers[at : at+mergeWidth]
		merged := StateHistoryLayerRef{FirstBlock: group[0].FirstBlock, LastBlock: group[len(group)-1].LastBlock,
			Level: uint32(indexLevel(group[0].FirstBlock, group[len(group)-1].LastBlock, p.d.cfg.batch))}
		m.StateHistory.Layers = replaceRun(m.StateHistory.Layers, at, merged)
		st.note(merged.LastBlock - merged.FirstBlock + 1)
		ls := m.StateHistory.Layers
		checkContiguous(t, len(ls), func(i int) (uint64, uint64) { return ls[i].FirstBlock, ls[i].LastBlock })
	}
}

// drainIndex does the same for hash index objects.
func drainIndex(t *testing.T, p *promotion, objs []HashIndexObject, st *mergeStats) []HashIndexObject {
	t.Helper()
	for n := 0; ; n++ {
		at := p.mergeableIndex(len(objs), func(i int) (uint64, uint64) { return objs[i].FirstBlock, objs[i].LastBlock })
		if at < 0 {
			return objs
		}
		if n > 1000 {
			t.Fatal("compaction does not converge")
		}
		group := objs[at : at+mergeWidth]
		merged := HashIndexObject{FirstBlock: group[0].FirstBlock, LastBlock: group[len(group)-1].LastBlock}
		objs = replaceRun(objs, at, merged)
		st.note(merged.LastBlock - merged.FirstBlock + 1)
		checkContiguous(t, len(objs), func(i int) (uint64, uint64) { return objs[i].FirstBlock, objs[i].LastBlock })
	}
}

func (s *mergeStats) note(span uint64) {
	s.merges++
	s.merged += span
	s.largest = max(s.largest, span)
}

func testPromotion() *promotion {
	return &promotion{d: &daemon{cfg: daemonConfig{batch: 256, maxObjects: 6}}}
}

func TestMergeablePair(t *testing.T) {
	p := testPromotion()
	cases := []struct {
		spans []uint64 // 0 is the base
		want  int
	}{
		{[]uint64{0}, -1},
		{[]uint64{0, 300}, -1},
		{[]uint64{0, 48, 48}, 1},                                // two small objects fold at once
		{[]uint64{0, 300, 48, 48, 300}, 2},                      // the smallest pair at most a batch, wherever it is
		{[]uint64{0, 300, 300, 300, 300, 300, 300}, -1},         // six above the base: at the cap
		{[]uint64{0, 300, 300, 300, 300, 300, 300, 300}, 6},     // seven: the closest pair; equal ratios, the smallest pair
		{[]uint64{0, 4000, 1000, 1000, 300, 300, 300, 300}, 6},  // 1000/1000 and 300/300 tie at 1; the smaller pair
		{[]uint64{0, 4000, 2000, 1000, 500, 400, 300, 260}, 6},  // 300/260 is the lowest ratio
		{[]uint64{0, 4000, 2000, 1000, 500, 400, 300, 1000}, 4}, // 500/400 = 1.25 is the lowest ratio either way round
		{[]uint64{4000, 2000, 1000, 500, 400, 300, 260}, 5},     // no base at all: the first object counts
		{[]uint64{0, 0, 300, 300, 300, 300, 300, 300, 300}, 7},  // bases never merge
	}
	for _, c := range cases {
		m := &Manifest{StateHistory: StateHistory{Layers: testLayers(c.spans...)}}
		if got := p.mergeableLayers(m); got != c.want {
			t.Errorf("spans %v: pair at %d, want %d", c.spans, got, c.want)
		}
	}
	// A gap between objects breaks the pair.
	m := &Manifest{StateHistory: StateHistory{Layers: testLayers(0, 48, 48)}}
	m.StateHistory.Layers[2].FirstBlock++
	if got := p.mergeableLayers(m); got != -1 {
		t.Errorf("gap: pair at %d", got)
	}
}

func TestReplaceRunKeepsOrder(t *testing.T) {
	list := []int{10, 20, 30, 40, 50}
	if got := replaceRun(list, 2, 99); !reflect.DeepEqual(got, []int{10, 20, 99, 50}) {
		t.Fatalf("middle: %v", got)
	}
	if got := replaceRun(list, 0, 99); !reflect.DeepEqual(got, []int{99, 30, 40, 50}) {
		t.Fatalf("start: %v", got)
	}
	if got := replaceRun(list, 3, 99); !reflect.DeepEqual(got, []int{10, 20, 30, 99}) {
		t.Fatalf("end: %v", got)
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
