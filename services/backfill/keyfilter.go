package main

// Blocked Bloom filters of state layers (docs/storage.md, "State history"):
//
//	"NRPCBLM1"  u32 block_count  u32 k  (block_count × 4096 bytes)
//
// A key's block is u32_le(keccak256(key)[0..4]) mod block_count. Inside that 4 KiB block
// (32,768 bits) the key sets k = 7 bits at (h1 + i·h2) mod 32768, with h1 and h2 the
// little-endian u64s of keccak256(key)[8..16] and [16..24]. block_count is sized for 10 bits
// per key. A reader checks one key with one 4 KiB range read per layer.
//
// Keys arrive one at a time while the layer is written; their 20 bytes of hash material spill
// to a temp file, and the filter is built once the key count is known.

import (
	"bufio"
	"encoding/binary"
	"io"
	"os"
)

const (
	filterBitsPerKey = 10
	filterHashes     = 7
	filterBlockBytes = 4096
	filterBlockBits  = filterBlockBytes * 8
	filterHeader     = 16
	filterRecord     = 20 // u32 block selector, u64 h1, u64 h2
)

var filterMagic = []byte("NRPCBLM1")

type filterSpill struct {
	f    *os.File
	w    *bufio.Writer
	k    *keccak
	keys uint64
}

func newFilterSpill(dir string) (*filterSpill, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	f, err := os.CreateTemp(dir, "filter-*.spill")
	if err != nil {
		return nil, err
	}
	return &filterSpill{f: f, w: bufio.NewWriterSize(f, 4<<20), k: newKeccak()}, nil
}

func (s *filterSpill) add(key []byte) error {
	h := s.k.sum(key)
	var rec [filterRecord]byte
	copy(rec[0:4], h[0:4])
	copy(rec[4:20], h[8:24])
	s.keys++
	_, err := s.w.Write(rec[:])
	return err
}

func filterBlockCount(keys uint64) uint32 {
	n := (keys*filterBitsPerKey + filterBlockBits - 1) / filterBlockBits
	return uint32(max(n, 1))
}

// build reads the spilled keys back and returns the encoded filter, then removes the spill.
func (s *filterSpill) build() ([]byte, error) {
	defer os.Remove(s.f.Name())
	defer s.f.Close()
	if err := s.w.Flush(); err != nil {
		return nil, err
	}
	if _, err := s.f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	blocks := filterBlockCount(s.keys)
	out := make([]byte, filterHeader+int(blocks)*filterBlockBytes)
	copy(out, filterMagic)
	binary.LittleEndian.PutUint32(out[8:], blocks)
	binary.LittleEndian.PutUint32(out[12:], filterHashes)
	body := out[filterHeader:]
	r := bufio.NewReaderSize(s.f, 4<<20)
	var rec [filterRecord]byte
	for range s.keys {
		if _, err := io.ReadFull(r, rec[:]); err != nil {
			return nil, err
		}
		setFilterBits(body, blocks, rec)
	}
	return out, nil
}

func setFilterBits(body []byte, blocks uint32, rec [filterRecord]byte) {
	block := binary.LittleEndian.Uint32(rec[0:4]) % blocks
	h1 := binary.LittleEndian.Uint64(rec[4:12])
	h2 := binary.LittleEndian.Uint64(rec[12:20])
	base := int(block) * filterBlockBytes
	for i := uint64(0); i < filterHashes; i++ {
		bit := (h1 + i*h2) % filterBlockBits
		body[base+int(bit/8)] |= 1 << (bit % 8)
	}
}
