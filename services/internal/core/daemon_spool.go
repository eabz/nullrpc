package core

// The spool (docs/pipeline.md, "Spool"): one file per block on local disk, written before the
// block goes anywhere else and kept until it is in an R2 generation.
//
//	tmp/       being written
//	ready/     durable, not yet in the Durable Objects
//	live/      in the live window
//	acked/     in an R2 generation that HEAD.json names (deleted after 7 days)
//	orphaned/  removed by a reorg (deleted after 7 days)
//
// File name: {number:020}-{hash}.blk, the gob encoding of a liveBlock.

import (
	"encoding/gob"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	spoolTmp      = "tmp"
	spoolReady    = "ready"
	spoolLive     = "live"
	spoolAcked    = "acked"
	spoolOrphaned = "orphaned"
	spoolKeep     = 7 * 24 * time.Hour
)

type spool struct{ root string }

func openSpool(root string) (*spool, error) {
	for _, d := range []string{spoolTmp, spoolReady, spoolLive, spoolAcked, spoolOrphaned} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			return nil, err
		}
	}
	s := &spool{root}
	// Partial files from a crash.
	entries, _ := os.ReadDir(filepath.Join(root, spoolTmp))
	for _, e := range entries {
		os.Remove(filepath.Join(root, spoolTmp, e.Name()))
	}
	return s, nil
}

func spoolName(id BlockID) string {
	return fmt.Sprintf("%020d-%s.blk", id.Number, strings.TrimPrefix(id.Hash, "0x"))
}

func parseSpoolName(name string) (BlockID, bool) {
	num, hash, ok := strings.Cut(strings.TrimSuffix(name, ".blk"), "-")
	if !ok || !strings.HasSuffix(name, ".blk") || len(hash) != 64 {
		return BlockID{}, false
	}
	n, err := strconv.ParseUint(num, 10, 64)
	if err != nil {
		return BlockID{}, false
	}
	return BlockID{Number: n, Hash: "0x" + hash}, true
}

// write stores a block in ready/: temp file, fsync, rename.
func (s *spool) write(b *liveBlock) error {
	name := spoolName(b.id())
	tmp := filepath.Join(s.root, spoolTmp, name)
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if err := gob.NewEncoder(f).Encode(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, filepath.Join(s.root, spoolReady, name)); err != nil {
		return err
	}
	return syncDir(filepath.Join(s.root, spoolReady))
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func (s *spool) read(dir string, id BlockID) (*liveBlock, error) {
	f, err := os.Open(filepath.Join(s.root, dir, spoolName(id)))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var b liveBlock
	if err := gob.NewDecoder(f).Decode(&b); err != nil {
		return nil, fmt.Errorf("spool %s/%s: %w", dir, spoolName(id), err)
	}
	if b.Number != id.Number || b.Hash != id.Hash {
		return nil, fmt.Errorf("spool %s/%s holds block %d %s", dir, spoolName(id), b.Number, b.Hash)
	}
	return &b, nil
}

// list returns the blocks in dir, ascending by number.
func (s *spool) list(dir string) ([]BlockID, error) {
	entries, err := os.ReadDir(filepath.Join(s.root, dir))
	if err != nil {
		return nil, err
	}
	var out []BlockID
	for _, e := range entries {
		if id, ok := parseSpoolName(e.Name()); ok {
			out = append(out, id)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Number < out[j].Number })
	return out, nil
}

// move renames a block's file from one directory to another. Files moved to acked/ or
// orphaned/ get the current time, from which their 7 days count.
func (s *spool) move(id BlockID, from, to string) error {
	dst := filepath.Join(s.root, to, spoolName(id))
	err := os.Rename(filepath.Join(s.root, from, spoolName(id)), dst)
	if errors.Is(err, os.ErrNotExist) {
		if _, serr := os.Stat(dst); serr == nil {
			return nil // already moved
		}
	}
	if err == nil && (to == spoolAcked || to == spoolOrphaned) {
		now := time.Now()
		os.Chtimes(dst, now, now)
	}
	return err
}

// expire deletes acked and orphaned files older than spoolKeep.
func (s *spool) expire() {
	cutoff := time.Now().Add(-spoolKeep)
	for _, dir := range []string{spoolAcked, spoolOrphaned} {
		entries, _ := os.ReadDir(filepath.Join(s.root, dir))
		for _, e := range entries {
			if info, err := e.Info(); err == nil && info.ModTime().Before(cutoff) {
				os.Remove(filepath.Join(s.root, dir, e.Name()))
			}
		}
	}
}
