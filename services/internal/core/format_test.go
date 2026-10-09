package core

import (
	"bytes"
	"encoding/binary"
	"os"
	"testing"
)

func TestAccountConversion(t *testing.T) {
	// Erigon V3: nonce 5, balance 0x0100, no code hash, incarnation 0.
	v3 := []byte{1, 5, 2, 0x01, 0x00, 0, 0}
	got, err := convertAccountV3(v3)
	if err != nil {
		t.Fatal(err)
	}
	want := []byte{5, 2, 0x01, 0x00}
	if !bytes.Equal(got, want) {
		t.Fatalf("encoded %x, want %x", got, want)
	}
	a, err := decodeAccount(got)
	if err != nil || a.nonce != 5 || !bytes.Equal(a.balance, []byte{1, 0}) || a.hasCode {
		t.Fatalf("decoded %+v, %v", a, err)
	}
	// With code: the hash is kept; the empty-code hash means no code.
	code := bytes.Repeat([]byte{0xab}, 32)
	withCode := append([]byte{0, 0, 32}, append(code, 0)...)
	got, _ = convertAccountV3(withCode)
	if a, _ := decodeAccount(got); !a.hasCode || !bytes.Equal(a.codeHash[:], code) {
		t.Fatalf("code hash lost: %+v", a)
	}
	empty := append([]byte{0, 0, 32}, append(emptyCodeHash[:], 0)...)
	got, _ = convertAccountV3(empty)
	if a, _ := decodeAccount(got); a.hasCode {
		t.Fatal("empty-code hash kept as code")
	}
	if got, _ := convertAccountV3(nil); len(got) != 0 {
		t.Fatal("absent account must stay empty")
	}
}

func TestWitnessEncoding(t *testing.T) {
	w := newBlockWitness()
	var a1, a2 [20]byte
	a1[19], a2[19] = 2, 1
	w.accounts[a1] = &witnessAccount{exists: true, nonce: 3, balance: []byte{9}}
	w.accounts[a2] = &witnessAccount{exists: true, hasCode: true, codeHash: [32]byte{7}}
	var s [32]byte
	s[31] = 1
	w.storage[a2] = map[[32]byte][]byte{s: {0x42}}
	enc := w.encode()
	if enc[0] != witnessVersion {
		t.Fatal("version")
	}
	r := bytes.NewReader(enc[1:])
	n, _ := binary.ReadUvarint(r)
	if n != 2 {
		t.Fatalf("accounts %d", n)
	}
	var addr [20]byte
	r.Read(addr[:])
	if addr != a2 { // sorted by address
		t.Fatal("accounts are not sorted")
	}
	if flags, _ := r.ReadByte(); flags != witnessFlagExists|witnessFlagCode {
		t.Fatalf("flags %d", flags)
	}
	// Same input, same bytes.
	if !bytes.Equal(enc, w.encode()) {
		t.Fatal("encoding is not deterministic")
	}
}

func TestBlockedFilter(t *testing.T) {
	s, err := newFilterSpill(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	keys := make([][]byte, 5000)
	for i := range keys {
		keys[i] = binary.BigEndian.AppendUint64(nil, uint64(i)*7919)
		if err := s.add(keys[i]); err != nil {
			t.Fatal(err)
		}
	}
	f, err := s.build()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(f[:8], filterMagic) || binary.LittleEndian.Uint32(f[12:]) != filterHashes {
		t.Fatal("header")
	}
	blocks := binary.LittleEndian.Uint32(f[8:])
	if len(f) != filterHeader+int(blocks)*filterBlockBytes {
		t.Fatal("size")
	}
	k := newKeccak()
	contains := func(key []byte) bool {
		h := k.sum(key)
		block := binary.LittleEndian.Uint32(h[0:4]) % blocks
		h1, h2 := binary.LittleEndian.Uint64(h[8:16]), binary.LittleEndian.Uint64(h[16:24])
		body := f[filterHeader+int(block)*filterBlockBytes:]
		for i := uint64(0); i < filterHashes; i++ {
			bit := (h1 + i*h2) % filterBlockBits
			if body[bit/8]&(1<<(bit%8)) == 0 {
				return false
			}
		}
		return true
	}
	for _, key := range keys {
		if !contains(key) {
			t.Fatalf("false negative for %x", key)
		}
	}
	fp := 0
	for i := range 20000 {
		if contains(binary.BigEndian.AppendUint64(nil, uint64(i)*7919+1)) {
			fp++
		}
	}
	if fp > 600 { // about 1 % expected
		t.Fatalf("%d false positives in 20000", fp)
	}
}

func TestWitnessRangeLayout(t *testing.T) {
	archive := localArchive{t.TempDir()}
	frames := []frame{compressFrame([]byte{1, 0, 0}), compressFrame([]byte{1, 0, 0})}
	rng, objs, err := writeWitnessRange(archive, "1-ab", 10, frames)
	if err != nil {
		t.Fatal(err)
	}
	if rng.First != 10 || rng.Last != 11 || rng.Offsets.Bytes != 2*witnessOffsetLen || len(rng.Packs) != 1 || len(objs) != 2 {
		t.Fatalf("range %+v", rng)
	}
	data, err := os.ReadFile(archive.path(rng.Offsets.Key))
	if err != nil || sha256Hex(data) != rng.Offsets.Sha256 {
		t.Fatal("offsets.bin does not match its reference")
	}
	pack, _ := os.ReadFile(archive.path(rng.Packs[0].Key))
	if !bytes.Equal(pack[:8], []byte("NRPCPACK")) || pack[10] != codecWitness {
		t.Fatal("pack header")
	}
	if off := binary.LittleEndian.Uint64(data[witnessOffsetLen:]); off != packHeader+uint64(len(frames[0].data)) {
		t.Fatalf("second frame offset %d", off)
	}
}
