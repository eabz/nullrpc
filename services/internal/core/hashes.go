package core

// Hash index entries spilled per chunk while the block bundles are written, so the hash
// index stage never reads the bundles back. One file per chunk and part in WORK/hashes:
//
//	{chunk}.tx   14 bytes per transaction: hash[0..6] ‖ block (u40 BE) ‖ index in block (u24 BE)
//	{chunk}.blk  11 bytes per block:       hash[0..6] ‖ block (u40 BE)
//
// These are exactly the sort keys of the hash index (txSortKey, blockSortKey).

import (
	"fmt"
	"os"
	"path/filepath"
)

type hashSpill struct{ txs, blks []byte }

func newHashSpill() *hashSpill { return &hashSpill{} }

func (s *hashSpill) block(hash string, number uint64) error {
	h, err := decodeData(hash, 32)
	if err != nil {
		return err
	}
	var k [blockSortKey]byte
	copy(k[:6], h[:6])
	putUint40(k[6:11], number)
	s.blks = append(s.blks, k[:]...)
	return nil
}

func (s *hashSpill) tx(hash string, number, index uint64) error {
	h, err := decodeData(hash, 32)
	if err != nil {
		return err
	}
	if index >= 1<<24 {
		return fmt.Errorf("transaction index %d out of range", index)
	}
	var k [txSortKey]byte
	copy(k[:6], h[:6])
	putUint40(k[6:11], number)
	k[11], k[12], k[13] = byte(index>>16), byte(index>>8), byte(index)
	s.txs = append(s.txs, k[:]...)
	return nil
}

func spillPath(dir string, chunk uint64, part string) string {
	return filepath.Join(dir, fmt.Sprintf("%020d.%s", chunk, part))
}

func (s *hashSpill) write(dir string, chunk uint64) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for part, data := range map[string][]byte{"tx": s.txs, "blk": s.blks} {
		p := spillPath(dir, chunk, part)
		if err := os.WriteFile(p+".tmp", data, 0o644); err != nil {
			return err
		}
		if err := os.Rename(p+".tmp", p); err != nil {
			return err
		}
	}
	return nil
}
