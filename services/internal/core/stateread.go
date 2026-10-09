package core

// Reference reader for state history layers: checks a built layer against the node before
// upload, and serves the witness stage's existence checks and cross-checks.

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/rand/v2"
	"os"
	"sort"

	"github.com/klauspost/compress/zstd"
	"golang.org/x/crypto/sha3"
)

// layerReader looks up keys in one state history layer, read from a
// local tree or the bucket. Safe for concurrent use.
type layerReader struct {
	src   objectSource
	layer stateLayer
	dec   *zstd.Decoder
	cache *frameCache // nil: no caching
}

func openLayer(archive localArchive, descriptorKey string) (*layerReader, error) {
	return openLayerFrom(localSource{archive}, ObjectRef{Key: descriptorKey}, nil)
}

// openLayerFrom opens a layer by its descriptor (checked against ref's
// digest when it has one).
func openLayerFrom(src objectSource, ref ObjectRef, cache *frameCache) (*layerReader, error) {
	raw, err := src.get(ref.Key)
	if err != nil {
		return nil, err
	}
	if ref.Sha256 != "" && (sha256Hex(raw) != ref.Sha256 || uint64(len(raw)) != ref.Bytes) {
		return nil, fmt.Errorf("layer descriptor %s does not match its reference", ref.Key)
	}
	var layer stateLayer
	if err := json.Unmarshal(raw, &layer); err != nil {
		return nil, err
	}
	dec, err := zstd.NewReader(nil)
	if err != nil {
		return nil, err
	}
	return &layerReader{src: src, layer: layer, dec: dec, cache: cache}, nil
}

func (l *layerReader) frame(key string, r RecordOffset) ([]byte, error) {
	id := fmt.Sprintf("%s@%d", key, r.Offset)
	if v, ok := l.cache.get(id); ok {
		return v, nil
	}
	buf, err := l.src.getRange(key, r.Offset, r.Length)
	if err != nil {
		return nil, err
	}
	if sha256Hex(buf) != r.Sha256 {
		return nil, fmt.Errorf("%s@%d: frame digest mismatch", key, r.Offset)
	}
	plain, err := l.dec.DecodeAll(buf, make([]byte, 0, r.UncompressedLength))
	if err != nil || uint64(len(plain)) != r.UncompressedLength {
		return nil, fmt.Errorf("%s@%d: bad frame", key, r.Offset)
	}
	l.cache.put(id, plain)
	return plain, nil
}

func cmpKeyBlock(k1 []byte, b1 uint64, k2 []byte, b2 uint64) int {
	if c := bytes.Compare(k1, k2); c != 0 {
		return c
	}
	switch {
	case b1 < b2:
		return -1
	case b1 > b2:
		return 1
	}
	return 0
}

// get returns the key's value at the end of `block` and whether any entry
// at or before that block exists (absent = never set or deleted to empty).
func (l *layerReader) get(domain string, key []byte, block uint64) ([]byte, bool, error) {
	d := l.layer.Domains[domain]
	if d == nil {
		return nil, false, fmt.Errorf("layer has no %s domain", domain)
	}
	// Root: last index page whose first (key, block) <= (key, block).
	i := sort.Search(len(d.Root), func(n int) bool {
		k, _ := hex.DecodeString(d.Root[n].FirstKey)
		return cmpKeyBlock(k, d.Root[n].FirstBlock, key, block) > 0
	}) - 1
	if i < 0 {
		return nil, false, nil
	}
	index, err := l.frame(d.Index.Key, d.Root[i].Record)
	if err != nil {
		return nil, false, err
	}
	r := bytes.NewReader(index)
	n, _ := binary.ReadUvarint(r)
	type entry struct {
		key    []byte
		block  uint64
		pack   uint64
		record RecordOffset
	}
	var chosen *entry
	for range n {
		var e entry
		kl, _ := binary.ReadUvarint(r)
		e.key = make([]byte, kl)
		io.ReadFull(r, e.key)
		e.block, _ = binary.ReadUvarint(r)
		e.pack, _ = binary.ReadUvarint(r)
		e.record.Offset, _ = binary.ReadUvarint(r)
		e.record.Length, _ = binary.ReadUvarint(r)
		e.record.UncompressedLength, _ = binary.ReadUvarint(r)
		sum := make([]byte, 32)
		if _, err := io.ReadFull(r, sum); err != nil {
			return nil, false, errors.New("truncated index page")
		}
		e.record.Sha256 = hex.EncodeToString(sum)
		if cmpKeyBlock(e.key, e.block, key, block) > 0 {
			break
		}
		chosen = &e
	}
	if chosen == nil {
		return nil, false, nil
	}
	page, err := l.frame(d.Packs[chosen.pack].Key, chosen.record)
	if err != nil {
		return nil, false, err
	}
	pr := bytes.NewReader(page)
	var value []byte
	found := false
	for pr.Len() > 0 {
		kl, _ := binary.ReadUvarint(pr)
		k := make([]byte, kl)
		io.ReadFull(pr, k)
		count, _ := binary.ReadUvarint(pr)
		match := bytes.Equal(k, key)
		var b uint64
		for range count {
			delta, _ := binary.ReadUvarint(pr)
			vl, _ := binary.ReadUvarint(pr)
			v := make([]byte, vl)
			if _, err := io.ReadFull(pr, v); err != nil {
				return nil, false, errors.New("truncated data page")
			}
			b += delta
			if match && b <= block {
				value, found = v, true
			}
		}
		if bytes.Compare(k, key) > 0 {
			break
		}
	}
	return value, found && len(value) > 0, nil
}

// runStateVerify compares layer lookups at random blocks with the node.
func runStateVerify(args []string) {
	fs := flag.NewFlagSet("state-verify", flag.ExitOnError)
	archiveRoot := fs.String("archive", "archive", "local archive staging tree")
	layerPath := fs.String("state-layer", "state-layer.json", "state layer reference")
	rpcURL := fs.String("rpc", "http://127.0.0.1:8545", "Erigon JSON-RPC")
	samples := fs.Int("samples", 200, "keys sampled per change file")
	seed := fs.Uint64("seed", 1, "sampling seed")
	fs.Parse(args)
	var ref StateHistoryLayerRef
	if err := readJSONFile(*layerPath, &ref); err != nil {
		fail(err)
	}
	l, err := openLayer(localArchive{*archiveRoot}, ref.Descriptor.Key)
	if err != nil {
		fail(err)
	}
	rng := rand.New(rand.NewPCG(*seed, *seed^0x9e3779b9))
	checked, mismatches, codes := 0, 0, 0
	for _, path := range fs.Args() {
		picked, err := sampleKeys(path, *samples, rng)
		if err != nil {
			fail(err)
		}
		for _, kc := range picked {
			block := rng.Uint64N(ref.LastBlock + 1)
			n, c, bad, err := checkKey(l, *rpcURL, kc.key, block)
			if err != nil {
				fail(err)
			}
			checked, codes, mismatches = checked+n, codes+c, mismatches+bad
		}
	}
	fmt.Printf("{\"checked\":%d,\"code_checked\":%d,\"mismatches\":%d}\n", checked, codes, mismatches)
	if mismatches > 0 {
		os.Exit(2)
	}
}

// checkKey compares one account or storage key's layer value at block with
// the node, and an account's code by hash with eth_getCode. It returns the
// values and codes checked and the mismatches (each printed).
func checkKey(l *layerReader, rpcURL string, key []byte, block uint64) (int, int, int, error) {
	domain := "accounts"
	if len(key) == 52 {
		domain = "storage"
	}
	value, _, err := l.get(domain, key, block)
	if err != nil {
		return 0, 0, 0, err
	}
	ok, detail, err := compare(rpcURL, key, value, block)
	if err != nil {
		return 0, 0, 0, err
	}
	checked, codes, mismatches := 1, 0, 0
	if !ok {
		mismatches++
		fmt.Printf("MISMATCH %s key=%x block=%d: %s\n", domain, key, block, detail)
	}
	// Contract code by hash, checked against eth_getCode.
	if domain == "accounts" && len(value) > 0 {
		if codeHash := accountCodeHash(value); codeHash != nil {
			code, found, err := l.get("code", codeHash, 0)
			if err != nil {
				return 0, 0, 0, err
			}
			k := sha3.NewLegacyKeccak256()
			k.Write(code)
			got, err := rpcBytes(rpcURL, "eth_getCode", fmt.Sprintf("0x%x", key), fmt.Sprintf("0x%x", block))
			if err != nil {
				return 0, 0, 0, err
			}
			codes++
			if !found || !bytes.Equal(k.Sum(nil), codeHash) || !bytes.Equal(got, code) {
				mismatches++
				fmt.Printf("MISMATCH code key=%x block=%d found=%v\n", key, block, found)
			}
		}
	}
	return checked, codes, mismatches, nil
}

// accountCodeHash returns the code hash of a non-empty Erigon V3 account.
func accountCodeHash(b []byte) []byte {
	a, err := decodeAccount(b)
	if err != nil || !a.hasCode {
		return nil
	}
	return a.codeHash[:]
}

func rpcBytes(url, method string, params ...any) ([]byte, error) {
	raw, err := newRPCClient(url, 2).call(method, params...)
	if err != nil {
		return nil, err
	}
	s := string(bytes.Trim(raw, `"`))
	if len(s) < 2 {
		return nil, fmt.Errorf("%s: invalid bytes", method)
	}
	return hex.DecodeString(s[2:])
}
