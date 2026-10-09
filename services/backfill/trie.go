package main

// Ethereum secure Merkle-Patricia trie construction from sorted (hashed key,
// leaf value) streams. The builder keeps only the path of the most recent key
// on a stack, so memory is O(depth); every node referenced by hash (RLP of 32
// bytes or more) and every root is passed to an emit callback as it is built.

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"math/big"
	"sort"
	"strings"

	fastkeccak "github.com/erigontech/fastkeccak"
)

var (
	emptyRootHash = mustHash("56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421")
	emptyCodeHash = mustHash("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
	emptyTrieRLP  = []byte{0x80}
)

func mustHash(s string) (h [32]byte) {
	b, err := hex.DecodeString(s)
	if err != nil || len(b) != 32 {
		panic(s)
	}
	copy(h[:], b)
	return h
}

// keccak is a reusable Keccak-256 hasher (not safe for concurrent use).
type keccak struct{ h hash.Hash }

func newKeccak() *keccak { return &keccak{fastkeccak.NewFastKeccak()} }

func (k *keccak) sum(parts ...[]byte) (out [32]byte) {
	k.h.Reset()
	for _, p := range parts {
		k.h.Write(p)
	}
	k.h.Sum(out[:0])
	return out
}

// ---- RLP ----

func rlpHeader(dst []byte, offset byte, n int) []byte {
	if n < 56 {
		return append(dst, offset+byte(n))
	}
	var be [8]byte
	l := 0
	for v := n; v > 0; v >>= 8 {
		l++
	}
	for i := 0; i < l; i++ {
		be[i] = byte(n >> (8 * (l - 1 - i)))
	}
	dst = append(dst, offset+55+byte(l))
	return append(dst, be[:l]...)
}

func rlpAppendString(dst, b []byte) []byte {
	if len(b) == 1 && b[0] < 0x80 {
		return append(dst, b[0])
	}
	return append(rlpHeader(dst, 0x80, len(b)), b...)
}

func rlpList(payload []byte) []byte {
	out := rlpHeader(make([]byte, 0, len(payload)+9), 0xc0, len(payload))
	return append(out, payload...)
}

func trimLeadingZeros(b []byte) []byte {
	for len(b) > 0 && b[0] == 0 {
		b = b[1:]
	}
	return b
}

// accountLeaf is RLP([nonce, balance, storageRoot, codeHash]); nonce and
// balance are big-endian byte strings (leading zeros are trimmed here).
func accountLeaf(nonce, balance []byte, storageRoot, codeHash [32]byte) []byte {
	var p []byte
	p = rlpAppendString(p, trimLeadingZeros(nonce))
	p = rlpAppendString(p, trimLeadingZeros(balance))
	p = rlpAppendString(p, storageRoot[:])
	p = rlpAppendString(p, codeHash[:])
	return rlpList(p)
}

// slotLeaf is the trie value of a storage slot: RLP of the minimal big-endian
// value. Zero slots are not in the trie (nil).
func slotLeaf(value []byte) []byte {
	v := trimLeadingZeros(value)
	if len(v) == 0 {
		return nil
	}
	return rlpAppendString(make([]byte, 0, len(v)+1), v)
}

// ---- hash builder ----

type nodeRef struct {
	b [33]byte
	n uint8 // 0 = empty child
}

type hbFrame struct {
	depth    int // nibble index that selects the child
	children [16]nodeRef
}

// hashBuilder computes the root of a trie whose 32-byte keys are added in
// strictly increasing order. emit receives (hash, rlp) for every node that is
// referenced by hash and for the root; rlp is only valid during the call.
type hashBuilder struct {
	emit    func(h [32]byte, rlp []byte) error
	k       *keccak
	prev    [64]byte
	prevKey [32]byte
	prevVal []byte
	prevL   int
	has     bool
	stack   []hbFrame
	root    []byte
	err     error
	scratch []byte
	leaves  uint64
}

func newHashBuilder(emit func(h [32]byte, rlp []byte) error) *hashBuilder {
	return &hashBuilder{emit: emit, k: newKeccak(), stack: make([]hbFrame, 0, 65)}
}

func (b *hashBuilder) reset() {
	b.has, b.stack, b.root, b.err, b.prevVal, b.leaves = false, b.stack[:0], nil, nil, b.prevVal[:0], 0
}

func (b *hashBuilder) add(key []byte, val []byte) error {
	if len(key) != 32 || len(val) == 0 {
		return errors.New("trie: keys must be 32 bytes and values non-empty")
	}
	if b.err != nil {
		return b.err
	}
	b.leaves++
	if !b.has {
		b.has, b.prevL = true, -1
		b.setPrev(key, val)
		return nil
	}
	if bytes.Compare(key, b.prevKey[:]) <= 0 {
		return fmt.Errorf("trie: key %x not after %x", key, b.prevKey)
	}
	var nk [64]byte
	toNibbles(&nk, key)
	l := 0
	for nk[l] == b.prev[l] {
		l++
	}
	b.flush(l)
	b.prevL = l
	b.setPrev(key, val)
	return b.err
}

func (b *hashBuilder) setPrev(key, val []byte) {
	copy(b.prevKey[:], key)
	toNibbles(&b.prev, key)
	b.prevVal = append(b.prevVal[:0], val...)
}

func toNibbles(dst *[64]byte, key []byte) {
	for i, c := range key {
		dst[2*i], dst[2*i+1] = c>>4, c&15
	}
}

// finish returns the root hash; the builder can then be reset and reused.
func (b *hashBuilder) finish() ([32]byte, error) {
	if b.err != nil {
		return [32]byte{}, b.err
	}
	if !b.has {
		if err := b.emit(emptyRootHash, emptyTrieRLP); err != nil {
			return [32]byte{}, err
		}
		return emptyRootHash, nil
	}
	b.flush(-1)
	if b.err != nil {
		return [32]byte{}, b.err
	}
	h := b.k.sum(b.root)
	if err := b.emit(h, b.root); err != nil {
		return [32]byte{}, err
	}
	return h, nil
}

// flush attaches the previous leaf, then closes every branch deeper than l
// (the common prefix length with the next key; -1 at the end).
func (b *hashBuilder) flush(l int) {
	a := max(b.prevL, l) // the previous leaf's branch depth
	if a < 0 {
		b.root = b.leafNode(b.prev[:])
		return
	}
	if n := len(b.stack); n == 0 || b.stack[n-1].depth < a {
		b.push(a)
	}
	b.stack[len(b.stack)-1].children[b.prev[a]] = b.ref(b.leafNode(b.prev[a+1:]))
	for len(b.stack) > 0 && b.stack[len(b.stack)-1].depth > l {
		f := &b.stack[len(b.stack)-1]
		depth := f.depth
		node := b.branchNode(f)
		b.stack = b.stack[:len(b.stack)-1]
		parent := -1
		if n := len(b.stack); n > 0 && b.stack[n-1].depth >= l {
			parent = b.stack[n-1].depth
		} else if l >= 0 {
			b.push(l)
			parent = l
		}
		if depth > parent+1 {
			ref := b.ref(node)
			node = b.extNode(b.prev[parent+1:depth], ref.b[:ref.n])
		}
		if parent < 0 {
			b.root = node
			return
		}
		b.stack[len(b.stack)-1].children[b.prev[parent]] = b.ref(node)
	}
}

func (b *hashBuilder) push(depth int) {
	b.stack = append(b.stack, hbFrame{depth: depth})
}

// ref embeds a node shorter than 32 bytes, otherwise emits it and references
// it by hash.
func (b *hashBuilder) ref(node []byte) nodeRef {
	var r nodeRef
	if len(node) < 32 {
		r.n = uint8(copy(r.b[:], node))
		return r
	}
	h := b.k.sum(node)
	if b.err == nil {
		b.err = b.emit(h, node)
	}
	r.b[0] = 0xa0
	copy(r.b[1:], h[:])
	r.n = 33
	return r
}

func hexPrefix(dst []byte, nibbles []byte, leaf bool) []byte {
	flag := byte(0)
	if leaf {
		flag = 2
	}
	if len(nibbles)%2 == 1 {
		dst = append(dst, (flag+1)<<4|nibbles[0])
		nibbles = nibbles[1:]
	} else {
		dst = append(dst, flag<<4)
	}
	for i := 0; i < len(nibbles); i += 2 {
		dst = append(dst, nibbles[i]<<4|nibbles[i+1])
	}
	return dst
}

func (b *hashBuilder) leafNode(path []byte) []byte {
	var hp [33]byte
	p := rlpAppendString(b.scratch[:0], hexPrefix(hp[:0], path, true))
	p = rlpAppendString(p, b.prevVal)
	b.scratch = p
	return rlpList(p)
}

func (b *hashBuilder) extNode(path []byte, child []byte) []byte {
	var hp [33]byte
	p := rlpAppendString(b.scratch[:0], hexPrefix(hp[:0], path, false))
	p = append(p, child...)
	b.scratch = p
	return rlpList(p)
}

func (b *hashBuilder) branchNode(f *hbFrame) []byte {
	p := b.scratch[:0]
	for i := range f.children {
		if c := &f.children[i]; c.n == 0 {
			p = append(p, 0x80)
		} else {
			p = append(p, c.b[:c.n]...)
		}
	}
	p = append(p, 0x80)
	b.scratch = p
	return rlpList(p)
}

// ---- genesis allocation ----

type genesisAccount struct {
	Balance string            `json:"balance"`
	Nonce   any               `json:"nonce"`
	Code    string            `json:"code"`
	Storage map[string]string `json:"storage"`
}

func parseBig(v any) (*big.Int, error) {
	switch x := v.(type) {
	case nil:
		return new(big.Int), nil
	case float64:
		return new(big.Int).SetUint64(uint64(x)), nil
	case string:
		if x == "" {
			return new(big.Int), nil
		}
		n, ok := new(big.Int).SetString(x, 0)
		if !ok {
			return nil, fmt.Errorf("invalid number %q", x)
		}
		return n, nil
	}
	return nil, fmt.Errorf("invalid number %v", v)
}

func decodeHex(s string) ([]byte, error) {
	s = strings.TrimPrefix(strings.TrimPrefix(s, "0x"), "0X")
	if len(s)%2 == 1 {
		s = "0" + s
	}
	return hex.DecodeString(s)
}

func leftPad32(b []byte) ([]byte, error) {
	b = trimLeadingZeros(b)
	if len(b) > 32 {
		return nil, errors.New("value longer than 32 bytes")
	}
	out := make([]byte, 32)
	copy(out[32-len(b):], b)
	return out, nil
}

// genesisTrie builds the state trie of a genesis allocation and returns its
// root; emit receives every node as in hashBuilder.
func genesisTrie(genesisJSON []byte, emit func(h [32]byte, rlp []byte) error) ([32]byte, error) {
	var g struct {
		Alloc map[string]genesisAccount `json:"alloc"`
	}
	if err := json.Unmarshal(genesisJSON, &g); err != nil {
		return [32]byte{}, err
	}
	k := newKeccak()
	type leaf struct {
		key [32]byte
		val []byte
	}
	var accounts []leaf
	hb := newHashBuilder(emit)
	for addrHex, a := range g.Alloc {
		addr, err := decodeHex(addrHex)
		if err != nil || len(addr) != 20 {
			return [32]byte{}, fmt.Errorf("invalid genesis address %q", addrHex)
		}
		var slots []leaf
		for slotHex, valueHex := range a.Storage {
			slot, err := decodeHex(slotHex)
			if err == nil {
				slot, err = leftPad32(slot)
			}
			value, verr := decodeHex(valueHex)
			if err != nil || verr != nil || len(trimLeadingZeros(value)) > 32 {
				return [32]byte{}, fmt.Errorf("invalid storage %s of %s", slotHex, addrHex)
			}
			if v := slotLeaf(value); v != nil {
				slots = append(slots, leaf{k.sum(slot), v})
			}
		}
		sort.Slice(slots, func(i, j int) bool { return bytes.Compare(slots[i].key[:], slots[j].key[:]) < 0 })
		hb.reset()
		for _, s := range slots {
			if err := hb.add(s.key[:], s.val); err != nil {
				return [32]byte{}, err
			}
		}
		storageRoot, err := hb.finish()
		if err != nil {
			return [32]byte{}, err
		}
		balance, err := parseBig(a.Balance)
		if err != nil {
			return [32]byte{}, err
		}
		nonce, err := parseBig(a.Nonce)
		if err != nil {
			return [32]byte{}, err
		}
		code, err := decodeHex(a.Code)
		if err != nil {
			return [32]byte{}, err
		}
		codeHash := emptyCodeHash
		if len(code) > 0 {
			codeHash = k.sum(code)
		}
		accounts = append(accounts, leaf{k.sum(addr), accountLeaf(nonce.Bytes(), balance.Bytes(), storageRoot, codeHash)})
	}
	sort.Slice(accounts, func(i, j int) bool { return bytes.Compare(accounts[i].key[:], accounts[j].key[:]) < 0 })
	hb.reset()
	for _, a := range accounts {
		if err := hb.add(a.key[:], a.val); err != nil {
			return [32]byte{}, err
		}
	}
	return hb.finish()
}
