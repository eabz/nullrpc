package main

// Bounded-memory external sort of (fixed-length key, value) records; keys
// are 32 bytes unless the sorter is made with newExtSorterKey. Records are
// buffered in one arena; a full arena is sorted and spilled to a run file;
// mergeSorted streams the union of any number of sorters in key order.

import (
	"bufio"
	"bytes"
	"container/heap"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sync/atomic"
)

var runSeq atomic.Uint64

type extSorter struct {
	dir      string
	keyLen   int
	limit    int
	arena    []byte
	offs     []uint32
	runs     []string
	records  uint64
	runBytes uint64
}

func newExtSorter(dir string, limit int) *extSorter {
	return newExtSorterKey(dir, limit, 32)
}

// newExtSorterKey sorts records with keyLen-byte keys.
func newExtSorterKey(dir string, limit, keyLen int) *extSorter {
	limit = min(max(limit, 4096), 1<<32-1)
	return &extSorter{dir: dir, keyLen: keyLen, limit: limit}
}

func (s *extSorter) add(key []byte, val []byte) error {
	need := s.keyLen + binary.MaxVarintLen64 + len(val)
	if s.arena == nil {
		s.arena = make([]byte, 0, s.limit)
	}
	if len(s.arena)+need > cap(s.arena) {
		if err := s.spill(); err != nil {
			return err
		}
		if need > cap(s.arena) {
			s.arena = make([]byte, 0, need)
		}
	}
	s.offs = append(s.offs, uint32(len(s.arena)))
	s.arena = append(s.arena, key[:s.keyLen]...)
	s.arena = binary.AppendUvarint(s.arena, uint64(len(val)))
	s.arena = append(s.arena, val...)
	s.records++
	return nil
}

func (s *extSorter) sortMem() {
	a, n := s.arena, uint32(s.keyLen)
	slices.SortFunc(s.offs, func(x, y uint32) int {
		return bytes.Compare(a[x:x+n], a[y:y+n])
	})
}

// arenaRecord returns the key and value at arena offset o.
func arenaRecord(a []byte, o uint32, keyLen int) ([]byte, []byte) {
	k := o + uint32(keyLen)
	n, l := binary.Uvarint(a[k:])
	start := int(k) + l
	return a[o:k], a[start : start+int(n)]
}

func (s *extSorter) spill() error {
	if len(s.offs) == 0 {
		return nil
	}
	s.sortMem()
	path := filepath.Join(s.dir, fmt.Sprintf("run-%08d", runSeq.Add(1)))
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	w := bufio.NewWriterSize(f, 4<<20)
	for _, o := range s.offs {
		k, v := arenaRecord(s.arena, o, s.keyLen)
		w.Write(k)
		var tmp [binary.MaxVarintLen64]byte
		w.Write(tmp[:binary.PutUvarint(tmp[:], uint64(len(v)))])
		if _, err := w.Write(v); err != nil {
			f.Close()
			return err
		}
	}
	if err := w.Flush(); err != nil {
		f.Close()
		return err
	}
	if info, err := f.Stat(); err == nil {
		s.runBytes += uint64(info.Size())
	}
	if err := f.Close(); err != nil {
		return err
	}
	s.runs = append(s.runs, path)
	s.arena, s.offs = s.arena[:0], s.offs[:0]
	return nil
}

// reset drops all records (memory is kept for reuse) and removes run files.
func (s *extSorter) reset() {
	for _, r := range s.runs {
		os.Remove(r)
	}
	s.runs, s.arena, s.offs, s.records, s.runBytes = nil, s.arena[:0], s.offs[:0], 0, 0
}

// release frees the arena and removes run files.
func (s *extSorter) release() {
	s.reset()
	s.arena, s.offs = nil, nil
}

type sortSource interface {
	next() bool
	key() []byte
	val() []byte
}

type memSource struct {
	a      []byte
	offs   []uint32
	keyLen int
	i      int
	k, v   []byte
}

func (m *memSource) next() bool {
	if m.i >= len(m.offs) {
		return false
	}
	m.k, m.v = arenaRecord(m.a, m.offs[m.i], m.keyLen)
	m.i++
	return true
}
func (m *memSource) key() []byte { return m.k }
func (m *memSource) val() []byte { return m.v }

type runSource struct {
	f   *os.File
	r   *bufio.Reader
	k   []byte
	v   []byte
	err error
}

func (r *runSource) next() bool {
	if _, err := io.ReadFull(r.r, r.k); err != nil {
		if err != io.EOF {
			r.err = err
		}
		return false
	}
	n, err := binary.ReadUvarint(r.r)
	if err == nil {
		if cap(r.v) < int(n) {
			r.v = make([]byte, n)
		}
		r.v = r.v[:n]
		_, err = io.ReadFull(r.r, r.v)
	}
	if err != nil {
		r.err = fmt.Errorf("%s: truncated run: %w", r.f.Name(), err)
		return false
	}
	return true
}
func (r *runSource) key() []byte { return r.k }
func (r *runSource) val() []byte { return r.v }

type sourceHeap []sortSource

func (h sourceHeap) Len() int           { return len(h) }
func (h sourceHeap) Less(i, j int) bool { return bytes.Compare(h[i].key(), h[j].key()) < 0 }
func (h sourceHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *sourceHeap) Push(x any)        { *h = append(*h, x.(sortSource)) }
func (h *sourceHeap) Pop() any {
	old := *h
	x := old[len(old)-1]
	*h = old[:len(old)-1]
	return x
}

// mergeSorted calls fn with every record of the sorters in key order (equal
// keys in arbitrary order). key and val are valid only during the call.
func mergeSorted(sorters []*extSorter, fn func(key, val []byte) error) error {
	h := &sourceHeap{}
	var runs []*runSource
	defer func() {
		for _, r := range runs {
			r.f.Close()
		}
	}()
	for _, s := range sorters {
		s.sortMem()
		if m := (&memSource{a: s.arena, offs: s.offs, keyLen: s.keyLen}); m.next() {
			*h = append(*h, m)
		}
		for _, path := range s.runs {
			f, err := os.Open(path)
			if err != nil {
				return err
			}
			r := &runSource{f: f, r: bufio.NewReaderSize(f, 1<<20), k: make([]byte, s.keyLen)}
			runs = append(runs, r)
			if r.next() {
				*h = append(*h, r)
			} else if r.err != nil {
				return r.err
			}
		}
	}
	heap.Init(h)
	for h.Len() > 0 {
		top := (*h)[0]
		if err := fn(top.key(), top.val()); err != nil {
			return err
		}
		if top.next() {
			heap.Fix(h, 0)
		} else {
			if r, ok := top.(*runSource); ok && r.err != nil {
				return r.err
			}
			heap.Pop(h)
		}
	}
	return nil
}
