package core

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"math/rand/v2"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/klauspost/compress/zstd"
)

type keyChanges struct {
	key    []byte
	txNums []uint64
	values [][]byte
}

// runVerify samples keys from change streams and compares the value implied by
// the dump at a block boundary with the node's own JSON-RPC answer there.
func runVerify(args []string) {
	fs := flag.NewFlagSet("verify", flag.ExitOnError)
	blocksPath := fs.String("blocks", "blocks.bin", "block boundaries (WORK/blocks.bin)")
	rpcURL := fs.String("rpc", "http://127.0.0.1:8545", "Erigon JSON-RPC")
	samples := fs.Int("samples", 200, "keys sampled per change file")
	seed := fs.Uint64("seed", 1, "sampling seed")
	stepSize := fs.Uint64("step-size", 390625, "txNums per Erigon step")
	fs.Parse(args)
	blocks, err := loadBlocks(*blocksPath)
	if err != nil {
		fail(err)
	}
	rng := rand.New(rand.NewPCG(*seed, *seed))
	checked, mismatches := 0, 0
	for _, path := range fs.Args() {
		m := regexp.MustCompile(`\.([0-9]+)-([0-9]+)\.changes\.zst$`).FindStringSubmatch(path)
		if m == nil {
			fail(fmt.Errorf("cannot read step range from %s", path))
		}
		fromStep, _ := strconv.ParseUint(m[1], 10, 64)
		toStep, _ := strconv.ParseUint(m[2], 10, 64)
		picked, err := sampleKeys(path, *samples, rng)
		if err != nil {
			fail(err)
		}
		for _, kc := range picked {
			i := rng.IntN(len(kc.txNums))
			block := blockOf(blocks, kc.txNums[i])
			if block < 0 {
				continue // beyond frozen blocks
			}
			// Post-state of `block`: last change inside or before it. Blocks
			// straddling the file's step range have changes in another file.
			end := blocks[block].base + uint64(blocks[block].count)
			if blocks[block].base < fromStep**stepSize || end > toStep**stepSize {
				continue
			}
			j := sort.Search(len(kc.txNums), func(n int) bool { return kc.txNums[n] >= end }) - 1
			want := kc.values[j]
			if len(kc.key) == 20 {
				if want, err = convertAccountV3(want); err != nil {
					fail(err)
				}
			}
			ok, detail, err := compare(*rpcURL, kc.key, want, uint64(block))
			if err != nil {
				fail(err)
			}
			checked++
			if !ok {
				mismatches++
				fmt.Printf("MISMATCH %s key=%x block=%d txNum=%d: %s\n", path, kc.key, block, kc.txNums[j], detail)
			}
		}
	}
	fmt.Printf("{\"checked\":%d,\"mismatches\":%d}\n", checked, mismatches)
	if mismatches > 0 {
		os.Exit(2)
	}
}

type blockTx struct {
	base  uint64
	count uint32
}

func loadBlocks(path string) ([]blockTx, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(data)%12 != 0 {
		return nil, errors.New("blocks.bin size is not a multiple of 12")
	}
	out := make([]blockTx, len(data)/12)
	for i := range out {
		out[i] = blockTx{binary.LittleEndian.Uint64(data[i*12:]), binary.LittleEndian.Uint32(data[i*12+8:])}
	}
	return out, nil
}

func blockOf(blocks []blockTx, txNum uint64) int {
	i := sort.Search(len(blocks), func(n int) bool {
		return blocks[n].base+uint64(blocks[n].count) > txNum
	})
	if i == len(blocks) || blocks[i].base > txNum {
		return -1
	}
	return i
}

// sampleKeys reservoir-samples keys (without their changes) from one change stream.
func sampleKeys(path string, k int, rng *rand.Rand) ([]keyChanges, error) {
	it, err := openChangeIter(path)
	if err != nil {
		return nil, err
	}
	defer it.close()
	var picked []keyChanges
	for seen := 1; ; seen++ {
		key, ok, err := it.nextKey()
		if err != nil || !ok {
			return picked, err
		}
		if len(picked) < k {
			picked = append(picked, keyChanges{key: key})
		} else if n := rng.IntN(seen); n < k {
			picked[n] = keyChanges{key: key}
		}
	}
}

// changeIter reads one change stream written by changeWriter, key by key and
// change by change, so a key with millions of changes never sits in memory.
type changeIter struct {
	f       *os.File
	z       *zstd.Decoder
	r       *bufio.Reader
	pending []byte // the next key, read ahead
	eof     bool   // no key after pending
	inKey   bool   // changes of the current key remain
	last    uint64 // txNum of the current key's last change
	changes int    // changes read of the current key
	value   []byte // reused by nextChange
}

func openChangeIter(path string) (*changeIter, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	z, err := zstd.NewReader(f, zstd.WithDecoderConcurrency(2))
	if err != nil {
		f.Close()
		return nil, err
	}
	it := &changeIter{f: f, z: z, r: bufio.NewReaderSize(z, 1<<20)}
	it.pending, it.eof, err = it.readKey()
	return it, err
}

func (it *changeIter) close() {
	it.z.Close()
	it.f.Close()
}

func (it *changeIter) readKey() ([]byte, bool, error) {
	tag, err := it.r.ReadByte()
	if err == io.EOF {
		return nil, true, nil
	}
	if err != nil {
		return nil, false, err
	}
	if tag != 1 {
		return nil, false, fmt.Errorf("expected key record, found tag %d", tag)
	}
	n, err := it.r.ReadByte()
	if err != nil {
		return nil, false, err
	}
	key := make([]byte, n)
	_, err = io.ReadFull(it.r, key)
	return key, false, err
}

// nextKey skips what is left of the current key and starts the next one.
func (it *changeIter) nextKey() ([]byte, bool, error) {
	for it.inKey {
		if _, _, _, err := it.nextChange(); err != nil {
			return nil, false, err
		}
	}
	if it.eof || it.pending == nil {
		return nil, false, nil
	}
	key := it.pending
	it.pending, it.inKey, it.last, it.changes = nil, true, 0, 0
	return key, true, nil
}

// nextChange returns the current key's next change; the value is only valid
// until the next call. ok is false once the key has no more changes.
func (it *changeIter) nextChange() (uint64, []byte, bool, error) {
	if !it.inKey {
		return 0, nil, false, nil
	}
	tag, err := it.r.ReadByte()
	if err == io.EOF || tag == 1 {
		if err == nil {
			if err := it.r.UnreadByte(); err != nil {
				return 0, nil, false, err
			}
			if it.pending, it.eof, err = it.readKey(); err != nil {
				return 0, nil, false, err
			}
		} else {
			it.eof = true
		}
		it.inKey = false
		if it.changes == 0 {
			return 0, nil, false, errors.New("change stream key without changes")
		}
		return 0, nil, false, nil
	}
	if err != nil {
		return 0, nil, false, err
	}
	if tag != 2 {
		return 0, nil, false, fmt.Errorf("unknown record tag %d", tag)
	}
	delta, err := binary.ReadUvarint(it.r)
	if err != nil {
		return 0, nil, false, err
	}
	size, err := binary.ReadUvarint(it.r)
	if err != nil {
		return 0, nil, false, err
	}
	if uint64(cap(it.value)) < size {
		it.value = make([]byte, size)
	}
	it.value = it.value[:size]
	if _, err := io.ReadFull(it.r, it.value); err != nil {
		return 0, nil, false, err
	}
	it.last += delta
	it.changes++
	return it.last, it.value, true, nil
}

func compare(url string, key, value []byte, block uint64) (bool, string, error) {
	tag := fmt.Sprintf("0x%x", block)
	switch len(key) {
	case 20:
		nonce, balance := uint64(0), new(big.Int)
		if len(value) > 0 {
			var err error
			a, err := decodeAccount(value)
			if err != nil {
				return false, "", err
			}
			nonce, balance = a.nonce, new(big.Int).SetBytes(a.balance)
		}
		addr := fmt.Sprintf("0x%x", key)
		gotBal, err := rpcQuantity(url, "eth_getBalance", addr, tag)
		if err != nil {
			return false, "", err
		}
		gotNonce, err := rpcQuantity(url, "eth_getTransactionCount", addr, tag)
		if err != nil {
			return false, "", err
		}
		if gotBal.Cmp(balance) != 0 || gotNonce.Uint64() != nonce {
			return false, fmt.Sprintf("dump nonce=%d balance=%s, rpc nonce=%s balance=%s", nonce, balance, gotNonce, gotBal), nil
		}
		return true, "", nil
	case 52:
		want := new(big.Int).SetBytes(value)
		got, err := rpcQuantity(url, "eth_getStorageAt", fmt.Sprintf("0x%x", key[:20]), fmt.Sprintf("0x%x", key[20:]), tag)
		if err != nil {
			return false, "", err
		}
		if got.Cmp(want) != 0 {
			return false, fmt.Sprintf("dump=%s rpc=%s", want, got), nil
		}
		return true, "", nil
	}
	return false, "", fmt.Errorf("cannot verify key length %d", len(key))
}

func rpcQuantity(url, method string, params ...any) (*big.Int, error) {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	resp, err := http.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out struct {
		Result string `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	if out.Error != nil {
		return nil, fmt.Errorf("%s: %s", method, out.Error.Message)
	}
	v, ok := new(big.Int).SetString(strings.TrimPrefix(out.Result, "0x"), 16)
	if !ok {
		if out.Result == "0x" {
			return new(big.Int), nil
		}
		return nil, fmt.Errorf("%s: invalid quantity %q", method, out.Result)
	}
	return v, nil
}
