package core

// Archive primitives: packs, frames, object references and the local staging tree.
// The format is docs/storage.md; every reader decodes what is written here.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/klauspost/compress/zstd"
)

// Pack codecs (docs/storage.md, "Packs").
const (
	codecBlocks    = 1 // block records
	codecState     = 2 // state history pages
	codecHashIndex = 3 // hash index buckets
	codecLogIndex  = 4 // log index buckets
	codecWitness   = 5 // witnesses
	// codecReceipts = 6 // receipts frames (segment_split.go)
	packHeader = 16
)

func packHeaderBytes(codec uint16) []byte {
	h := []byte("NRPCPACK\x01\x00\x00\x00\x00\x00\x00\x00")
	h[10] = byte(codec)
	h[11] = byte(codec >> 8)
	return h
}

// Single-segment frames declare a window equal to the content size, so a reader can
// bound its decoding window by the record length.
var zstdEncoders = sync.Pool{New: func() any {
	e, err := zstd.NewWriter(nil, zstd.WithEncoderLevel(zstd.SpeedDefault),
		zstd.WithSingleSegment(true), zstd.WithEncoderConcurrency(1), zstd.WithEncoderCRC(false))
	if err != nil {
		panic(err)
	}
	return e
}}

type frame struct {
	data         []byte
	uncompressed uint64
	sha256       string
}

func compressFrame(plain []byte) frame {
	e := zstdEncoders.Get().(*zstd.Encoder)
	data := e.EncodeAll(plain, make([]byte, 0, len(plain)/3+64))
	zstdEncoders.Put(e)
	sum := sha256.Sum256(data)
	return frame{data: data, uncompressed: uint64(len(plain)), sha256: hex.EncodeToString(sum[:])}
}

type RecordOffset struct {
	BlockNumber        uint64 `json:"block_number"`
	Offset             uint64 `json:"offset"`
	Length             uint64 `json:"length"`
	UncompressedLength uint64 `json:"uncompressed_length"`
	Sha256             string `json:"sha256"`
}

// packWriter appends frames to a pack file on disk and hashes the whole object.
type packWriter struct {
	path string
	f    *os.File
	size uint64
	sum  hashWriter
}

func newPackWriter(path string, codec uint16) (*packWriter, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	w := &packWriter{path: path, f: f, sum: newHashWriter()}
	if err := w.write(packHeaderBytes(codec)); err != nil {
		return nil, err
	}
	return w, nil
}

func (w *packWriter) write(b []byte) error {
	if _, err := w.f.Write(b); err != nil {
		return err
	}
	w.sum.Write(b)
	w.size += uint64(len(b))
	return nil
}

func (w *packWriter) push(number uint64, fr frame) (RecordOffset, error) {
	r := RecordOffset{BlockNumber: number, Offset: w.size, Length: uint64(len(fr.data)),
		UncompressedLength: fr.uncompressed, Sha256: fr.sha256}
	return r, w.write(fr.data)
}

// close returns the object's size and SHA-256.
func (w *packWriter) close() (uint64, string, error) {
	if err := w.f.Close(); err != nil {
		return 0, "", err
	}
	return w.size, w.sum.hex(), nil
}

type ObjectRef struct {
	Key    string `json:"key"`
	Bytes  uint64 `json:"bytes"`
	Sha256 string `json:"sha256"`
}

// localArchive is the staging tree: every archive key is a file at root/key.
type localArchive struct{ root string }

func (a localArchive) path(key string) string { return filepath.Join(a.root, filepath.FromSlash(key)) }

func (a localArchive) putBytes(key string, data []byte) (ObjectRef, error) {
	if err := validateKey(key); err != nil {
		return ObjectRef{}, err
	}
	p := a.path(key)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return ObjectRef{}, err
	}
	sum := sha256.Sum256(data)
	ref := ObjectRef{Key: key, Bytes: uint64(len(data)), Sha256: hex.EncodeToString(sum[:])}
	if existing, err := os.ReadFile(p); err == nil {
		if sha256.Sum256(existing) != sum {
			return ref, fmt.Errorf("immutable object collision at %s", key)
		}
		return ref, nil
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return ref, err
	}
	return ref, os.Rename(tmp, p)
}

func (a localArchive) putJSON(key string, v any) (ObjectRef, error) {
	data, err := json.Marshal(v)
	if err != nil {
		return ObjectRef{}, err
	}
	return a.putBytes(key, data)
}

// adoptFile moves a finished pack into the tree under key.
func (a localArchive) adoptFile(key, src string, size uint64, sum string) (ObjectRef, error) {
	if err := validateKey(key); err != nil {
		return ObjectRef{}, err
	}
	p := a.path(key)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return ObjectRef{}, err
	}
	if src != p {
		if err := os.Rename(src, p); err != nil {
			return ObjectRef{}, err
		}
	}
	return ObjectRef{Key: key, Bytes: size, Sha256: sum}, nil
}

func validateKey(key string) error {
	if key == "" || strings.ContainsAny(key, "\\\x00") {
		return errors.New("invalid archive key")
	}
	for _, part := range strings.Split(key, "/") {
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("invalid archive key %q", key)
		}
	}
	return nil
}

func sha256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// ---- manifest (docs/storage.md, "HEAD.json and the manifest") ----

type BlockAnchor struct {
	Number    uint64 `json:"number"`
	Hash      string `json:"hash"`
	StateRoot string `json:"state_root"`
}

type Anchor struct {
	Number uint64 `json:"number"`
	Hash   string `json:"hash"`
}

// BundleMetadata is a segment's meta.json. Layout 2 (segment_split.go) stores receipts in
// their own pack; absent or 1, the whole record is one frame in blocks.pack.
type BundleMetadata struct {
	First           uint64               `json:"first"`
	Last            uint64               `json:"last"`
	FirstParentHash string               `json:"first_parent_hash"`
	LastHash        string               `json:"last_hash"`
	Layout          uint32               `json:"layout,omitempty"`
	Files           map[string]ObjectRef `json:"files"`
}

// BundleRef is one segment: bookkeeping in WORK/bundles.json, and (through segmentRef) the
// manifest's segment entry.
type BundleRef struct {
	FirstBlock      uint64    `json:"first_block"`
	LastBlock       uint64    `json:"last_block"`
	FirstParentHash string    `json:"first_parent_hash"`
	LastBlockHash   string    `json:"last_block_hash"`
	ChunkID         uint64    `json:"chunk_id"`
	Metadata        ObjectRef `json:"metadata"`
	// Uploaded: streaming mode only; the chunk is in the bucket and its local files are removed.
	Uploaded bool `json:"uploaded,omitempty"`
}

type SegmentRef struct {
	First    uint64    `json:"first"`
	Last     uint64    `json:"last"`
	LastHash string    `json:"last_hash"`
	Meta     ObjectRef `json:"meta"`
}

func segmentRefs(bundles []BundleRef) []SegmentRef {
	out := make([]SegmentRef, len(bundles))
	for i, b := range bundles {
		out[i] = SegmentRef{First: b.FirstBlock, Last: b.LastBlock, LastHash: b.LastBlockHash, Meta: b.Metadata}
	}
	return out
}

type StateHistoryLayerRef struct {
	FirstBlock uint64    `json:"first"`
	LastBlock  uint64    `json:"last"`
	Level      uint32    `json:"level"`
	Descriptor ObjectRef `json:"descriptor"`
}

// baseLevel is the level of the backfill's layer: a base below every promotion level.
const baseLevel = 99

type StateHistory struct {
	Layers []StateHistoryLayerRef `json:"layers"`
}

type WitnessRange struct {
	First   uint64      `json:"first"`
	Last    uint64      `json:"last"`
	Offsets ObjectRef   `json:"offsets"`
	Packs   []ObjectRef `json:"packs"`
}

type Witnesses struct {
	FirstBlock uint64         `json:"first_block"`
	Ranges     []WitnessRange `json:"ranges"`
}

type ChainInfo struct {
	ID          uint64 `json:"id"`
	NetworkID   string `json:"network_id"`
	GenesisHash string `json:"genesis_hash"`
}

type Manifest struct {
	Format            string       `json:"format"`
	Version           uint32       `json:"version"`
	Generation        uint64       `json:"generation"`
	Previous          *ObjectRef   `json:"previous"`
	Chain             ChainInfo    `json:"chain"`
	Config            ObjectRef    `json:"config"`
	FirstBlock        uint64       `json:"first_block"`
	ArchivedThrough   BlockAnchor  `json:"archived_through"`
	FinalizedObserved Anchor       `json:"finalized_observed"`
	ChunkBlocks       uint64       `json:"chunk_blocks"`
	Segments          []SegmentRef `json:"segments"`
	HashIndex         *HashIndex   `json:"hash_index"`
	LogIndex          *LogIndex    `json:"log_index"`
	StateHistory      StateHistory `json:"state_history"`
	Witnesses         Witnesses    `json:"witnesses"`
	CreatedAt         string       `json:"created_at"`
}

const manifestFormat = "nullrpc-archive"

type Head struct {
	Version    uint32    `json:"version"`
	Generation uint64    `json:"generation"`
	Manifest   ObjectRef `json:"manifest"`
}

type hashWriter struct{ h hash.Hash }

func newHashWriter() hashWriter     { return hashWriter{sha256.New()} }
func (w hashWriter) Write(b []byte) { w.h.Write(b) }
func (w hashWriter) hex() string    { return hex.EncodeToString(w.h.Sum(nil)) }
