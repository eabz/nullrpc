package main

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"

	"github.com/erigontech/erigon/db/seg"
)

var bodiesName = regexp.MustCompile(`^v[0-9.]+-([0-9]+)-([0-9]+)-bodies\.seg$`)

// extractBlocks writes blocks.bin from the frozen bodies files.
func extractBlocks(datadir, out string) (uint64, uint64, error) {
	snap := filepath.Join(datadir, "snapshots")
	entries, err := os.ReadDir(snap)
	if err != nil {
		return 0, 0, err
	}
	type file struct {
		from, to uint64
		path     string
	}
	var files []file
	for _, e := range entries {
		if m := bodiesName.FindStringSubmatch(e.Name()); m != nil {
			from, _ := strconv.ParseUint(m[1], 10, 64)
			to, _ := strconv.ParseUint(m[2], 10, 64)
			files = append(files, file{from * 1000, to * 1000, filepath.Join(snap, e.Name())})
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].from < files[j].from })
	f, err := os.Create(out)
	if err != nil {
		return 0, 0, err
	}
	w := bufio.NewWriterSize(f, 1<<20)
	var next, nextTx uint64
	var rec [12]byte
	for _, file := range files {
		if file.from != next {
			return 0, 0, fmt.Errorf("bodies gap: expected block %d, file starts at %d", next, file.from)
		}
		d, err := seg.NewDecompressor(file.path)
		if err != nil {
			return 0, 0, err
		}
		g := d.MakeGetter()
		var word []byte
		for g.HasNext() {
			word, _ = g.Next(word[:0])
			base, count, err := decodeBodyHead(word)
			if err != nil {
				return 0, 0, fmt.Errorf("block %d: %w", next, err)
			}
			if base != nextTx {
				return 0, 0, fmt.Errorf("block %d: BaseTxnID %d, expected %d", next, base, nextTx)
			}
			binary.LittleEndian.PutUint64(rec[:8], base)
			binary.LittleEndian.PutUint32(rec[8:], count)
			w.Write(rec[:])
			next++
			nextTx = base + uint64(count)
		}
		d.Close()
		if next != file.to {
			return 0, 0, fmt.Errorf("%s holds blocks up to %d, expected %d", file.path, next, file.to)
		}
	}
	if err := w.Flush(); err != nil {
		return 0, 0, err
	}
	return next, nextTx, f.Close()
}

// decodeBodyHead reads the first two fields of RLP(BodyForStorage).
func decodeBodyHead(b []byte) (uint64, uint32, error) {
	payload, err := rlpListPayload(b)
	if err != nil {
		return 0, 0, err
	}
	base, rest, err := rlpUint(payload)
	if err != nil {
		return 0, 0, err
	}
	count, _, err := rlpUint(rest)
	if err != nil || count > 1<<32-1 {
		return 0, 0, errors.New("invalid TxCount")
	}
	return base, uint32(count), nil
}

func rlpListPayload(b []byte) ([]byte, error) {
	if len(b) == 0 || b[0] < 0xc0 {
		return nil, errors.New("body is not an RLP list")
	}
	if b[0] <= 0xf7 {
		n := int(b[0] - 0xc0)
		if 1+n > len(b) {
			return nil, errors.New("truncated RLP list")
		}
		return b[1 : 1+n], nil
	}
	ll := int(b[0] - 0xf7)
	if 1+ll > len(b) || ll > 8 {
		return nil, errors.New("truncated RLP list length")
	}
	var n uint64
	for _, c := range b[1 : 1+ll] {
		n = n<<8 | uint64(c)
	}
	if uint64(1+ll)+n > uint64(len(b)) {
		return nil, errors.New("truncated RLP list")
	}
	return b[1+ll : 1+ll+int(n)], nil
}

func rlpUint(b []byte) (uint64, []byte, error) {
	if len(b) == 0 {
		return 0, nil, errors.New("missing RLP integer")
	}
	if b[0] < 0x80 {
		return uint64(b[0]), b[1:], nil
	}
	n := int(b[0] - 0x80)
	if n > 8 || 1+n > len(b) {
		return 0, nil, errors.New("invalid RLP integer")
	}
	var v uint64
	for _, c := range b[1 : 1+n] {
		v = v<<8 | uint64(c)
	}
	return v, b[1+n:], nil
}
