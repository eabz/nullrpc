package core

// Witnesses (docs/storage.md, "Witnesses"; docs/pipeline.md, "Witnesses").
//
// A block's witness is the value, before the block, of every account and storage slot its
// transactions touch, including keys they only read. It comes from the archive node's
// prestateTracer: each transaction's pre-state, keeping the first time a key appears in the
// block. A key a transaction touches for the first time was not changed by an earlier
// transaction of the block, so its first pre-state is its value at the start of the block
// (after the block's pre-transaction system calls, whose writes a replay therefore takes
// from the witness instead of re-running them).
//
// One witness range per segment: witnesses/{first}-{last}-{content-id}/ with offsets.bin
// (56 bytes per block) and witness.{n}.pack (one frame per block, codec 5). Blocks trace in
// parallel; each range is written in block order. A sample of blocks is cross-checked
// against the state history layer, an independent extraction of the same state.

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	witnessVersion     = 1
	witnessOffsetLen   = 56
	witnessPackLimit   = 1 << 30
	witnessFlagExists  = 1
	witnessFlagCode    = 2
	witnessCheckEvery  = 997 // cross-check one block in this many against the state layer
	witnessStateFile   = "witnesses.json"
	witnessTraceTimout = "600s"
)

// Pre-transaction system call contracts: their slots in a witness hold the value after the
// system call, so the cross-check skips them.
var witnessCheckSkip = map[string]bool{
	"000f3df6d732807ef1319fb7b8bb8522d0beac02": true, // EIP-4788 beacon roots
	"0000f90827f1c53a10cb7a02335b175320002935": true, // EIP-2935 block hashes
}

// witnessState is WORK/witnesses.json.
type witnessState struct {
	FirstBlock uint64         `json:"first_block"`
	Ranges     []WitnessRange `json:"ranges"`
	// Uploaded: streaming mode only; ranges whose objects are in the bucket and removed locally.
	Uploaded map[uint64]bool `json:"uploaded,omitempty"`
	Checked  uint64          `json:"checked_blocks"`
}

type witnessAccount struct {
	exists   bool
	nonce    uint64
	balance  []byte
	codeHash [32]byte
	hasCode  bool
}

type blockWitness struct {
	accounts map[[20]byte]*witnessAccount
	storage  map[[20]byte]map[[32]byte][]byte
}

func newBlockWitness() *blockWitness {
	return &blockWitness{accounts: map[[20]byte]*witnessAccount{}, storage: map[[20]byte]map[[32]byte][]byte{}}
}

// encode is the witness frame:
//
//	witness  := u8(version) accounts storage
//	accounts := uvarint(n) (address[20] u8(flags) uvarint(nonce) uvarint(len) balance code_hash[32]?){n}
//	storage  := uvarint(n) (address[20] uvarint(m) (slot[32] uvarint(len) value){m}){n}
//
// Accounts and storage are sorted by address, slots by slot.
func (w *blockWitness) encode() []byte {
	out := []byte{witnessVersion}
	addrs := make([][20]byte, 0, len(w.accounts))
	for a := range w.accounts {
		addrs = append(addrs, a)
	}
	sort.Slice(addrs, func(i, j int) bool { return bytes.Compare(addrs[i][:], addrs[j][:]) < 0 })
	out = binary.AppendUvarint(out, uint64(len(addrs)))
	for _, a := range addrs {
		acc := w.accounts[a]
		var flags byte
		if acc.exists {
			flags |= witnessFlagExists
		}
		if acc.hasCode {
			flags |= witnessFlagCode
		}
		out = append(out, a[:]...)
		out = append(out, flags)
		out = binary.AppendUvarint(out, acc.nonce)
		out = binary.AppendUvarint(out, uint64(len(acc.balance)))
		out = append(out, acc.balance...)
		if acc.hasCode {
			out = append(out, acc.codeHash[:]...)
		}
	}
	saddrs := make([][20]byte, 0, len(w.storage))
	for a := range w.storage {
		saddrs = append(saddrs, a)
	}
	sort.Slice(saddrs, func(i, j int) bool { return bytes.Compare(saddrs[i][:], saddrs[j][:]) < 0 })
	out = binary.AppendUvarint(out, uint64(len(saddrs)))
	for _, a := range saddrs {
		slots := w.storage[a]
		keys := make([][32]byte, 0, len(slots))
		for k := range slots {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return bytes.Compare(keys[i][:], keys[j][:]) < 0 })
		out = append(out, a[:]...)
		out = binary.AppendUvarint(out, uint64(len(keys)))
		for _, k := range keys {
			out = append(out, k[:]...)
			out = binary.AppendUvarint(out, uint64(len(slots[k])))
			out = append(out, slots[k]...)
		}
	}
	return out
}

// prestateAccount is one account of a prestateTracer result.
type prestateAccount struct {
	Balance string            `json:"balance"`
	Nonce   json.Number       `json:"nonce"`
	Code    string            `json:"code"`
	Storage map[string]string `json:"storage"`
}

// traceWitness builds block n's witness from the archive node. existence resolves whether an
// account that looks empty (no balance, nonce or code) exists before the block.
func traceWitness(rpc *rpcClient, n uint64, k *keccak, existence func(addr [20]byte) (bool, error)) (*blockWitness, error) {
	w := newBlockWitness()
	if n == 0 {
		return w, nil // genesis has no transactions
	}
	raw, err := rpc.call("debug_traceBlockByNumber", fmt.Sprintf("0x%x", n),
		map[string]any{"tracer": "prestateTracer", "timeout": witnessTraceTimout})
	if err != nil {
		return nil, fmt.Errorf("trace block %d: %w", n, err)
	}
	var txs []struct {
		TxHash string                     `json:"txHash"`
		Result map[string]prestateAccount `json:"result"`
		Error  string                     `json:"error"`
	}
	if err := json.Unmarshal(raw, &txs); err != nil {
		return nil, fmt.Errorf("trace block %d: %w", n, err)
	}
	for i, tx := range txs {
		if tx.Error != "" {
			return nil, fmt.Errorf("trace block %d transaction %d: %s", n, i, tx.Error)
		}
		for addrHex, acc := range tx.Result {
			addr, err := decodeData(addrHex, 20)
			if err != nil {
				return nil, fmt.Errorf("block %d: address %q: %w", n, addrHex, err)
			}
			var a [20]byte
			copy(a[:], addr)
			if _, seen := w.accounts[a]; !seen {
				wa, err := witnessAccountOf(acc, k)
				if err != nil {
					return nil, fmt.Errorf("block %d account %s: %w", n, addrHex, err)
				}
				if !wa.exists {
					if wa.exists, err = existence(a); err != nil {
						return nil, err
					}
				}
				w.accounts[a] = wa
			}
			if len(acc.Storage) == 0 {
				continue
			}
			slots := w.storage[a]
			if slots == nil {
				slots = map[[32]byte][]byte{}
				w.storage[a] = slots
			}
			for slotHex, valueHex := range acc.Storage {
				slot, err := decodeData(slotHex, 32)
				if err != nil {
					return nil, fmt.Errorf("block %d slot %q: %w", n, slotHex, err)
				}
				var s [32]byte
				copy(s[:], slot)
				if _, seen := slots[s]; seen {
					continue
				}
				value, err := decodeData(valueHex, 32)
				if err != nil {
					return nil, fmt.Errorf("block %d slot value %q: %w", n, valueHex, err)
				}
				slots[s] = trimLeadingZeros(value)
			}
		}
	}
	return w, nil
}

func witnessAccountOf(acc prestateAccount, k *keccak) (*witnessAccount, error) {
	wa := &witnessAccount{}
	if acc.Balance != "" {
		b, err := quantityBytes(acc.Balance)
		if err != nil {
			return nil, err
		}
		wa.balance = trimLeadingZeros(b)
	}
	if acc.Nonce != "" {
		n, err := acc.Nonce.Int64()
		if err != nil || n < 0 {
			return nil, fmt.Errorf("invalid nonce %q", acc.Nonce)
		}
		wa.nonce = uint64(n)
	}
	if code := strings.TrimPrefix(acc.Code, "0x"); code != "" {
		raw, err := hex.DecodeString(code)
		if err != nil {
			return nil, fmt.Errorf("invalid code: %w", err)
		}
		if len(raw) > 0 {
			wa.codeHash, wa.hasCode = k.sum(raw), true
		}
	}
	wa.exists = wa.nonce > 0 || len(wa.balance) > 0 || wa.hasCode
	return wa, nil
}

// checkWitness compares a witness with the state layer at block n-1, skipping the
// pre-transaction system call contracts. It returns the number of values compared.
func checkWitness(l *layerReader, n uint64, w *blockWitness) (int, error) {
	if n == 0 {
		return 0, nil
	}
	checked := 0
	for a, acc := range w.accounts {
		if witnessCheckSkip[hex.EncodeToString(a[:])] {
			continue
		}
		value, _, err := l.get("accounts", a[:], n-1)
		if err != nil {
			return checked, err
		}
		want := witnessAccount{}
		if len(value) > 0 {
			st, err := decodeAccount(value)
			if err != nil {
				return checked, err
			}
			want = witnessAccount{exists: true, nonce: st.nonce, balance: st.balance, codeHash: st.codeHash, hasCode: st.hasCode}
		}
		if acc.exists != want.exists || acc.nonce != want.nonce || !bytes.Equal(acc.balance, want.balance) ||
			acc.hasCode != want.hasCode || acc.codeHash != want.codeHash {
			return checked, fmt.Errorf("block %d: witness account %x differs from the state history at block %d", n, a, n-1)
		}
		checked++
	}
	for a, slots := range w.storage {
		if witnessCheckSkip[hex.EncodeToString(a[:])] {
			continue
		}
		for s, v := range slots {
			key := append(append(make([]byte, 0, 52), a[:]...), s[:]...)
			value, _, err := l.get("storage", key, n-1)
			if err != nil {
				return checked, err
			}
			if !bytes.Equal(trimLeadingZeros(value), v) {
				return checked, fmt.Errorf("block %d: witness slot %x/%x differs from the state history at block %d", n, a, s, n-1)
			}
			checked++
		}
	}
	return checked, nil
}

// writeWitnessRange writes one range's frames (index i is block first+i) as
// witnesses/{first}-{last}-{content-id}/.
func writeWitnessRange(archive localArchive, namespace string, first uint64, frames []frame) (WitnessRange, []streamObject, error) {
	last := first + uint64(len(frames)) - 1
	staging := fmt.Sprintf("%s/witnesses/%020d-%020d-building", namespace, first, last)
	os.RemoveAll(archive.path(staging))
	var packs []ObjectRef
	var pack *packWriter
	offsets := make([]byte, 0, len(frames)*witnessOffsetLen)
	closePack := func() error {
		size, sum, err := pack.close()
		if err != nil {
			return err
		}
		packs = append(packs, ObjectRef{Key: fmt.Sprintf("%s/witness.%04d.pack", staging, len(packs)), Bytes: size, Sha256: sum})
		pack = nil
		return nil
	}
	for i, fr := range frames {
		if pack != nil && pack.size+uint64(len(fr.data)) > witnessPackLimit {
			if err := closePack(); err != nil {
				return WitnessRange{}, nil, err
			}
		}
		if pack == nil {
			var err error
			if pack, err = newPackWriter(archive.path(fmt.Sprintf("%s/witness.%04d.pack", staging, len(packs))), codecWitness); err != nil {
				return WitnessRange{}, nil, err
			}
		}
		r, err := pack.push(first+uint64(i), fr)
		if err != nil {
			return WitnessRange{}, nil, err
		}
		if r.Length > math.MaxUint32 || r.UncompressedLength > math.MaxUint32 {
			return WitnessRange{}, nil, fmt.Errorf("block %d witness exceeds 4 GiB", first+uint64(i))
		}
		sum, _ := hex.DecodeString(r.Sha256)
		var rec [witnessOffsetLen]byte
		binary.LittleEndian.PutUint64(rec[0:], r.Offset)
		binary.LittleEndian.PutUint32(rec[8:], uint32(r.Length))
		binary.LittleEndian.PutUint32(rec[12:], uint32(r.UncompressedLength))
		binary.LittleEndian.PutUint16(rec[16:], uint16(len(packs)))
		copy(rec[24:], sum)
		offsets = append(offsets, rec[:]...)
	}
	if err := closePack(); err != nil {
		return WitnessRange{}, nil, err
	}
	offsetsRef, err := archive.putBytes(staging+"/offsets.bin", offsets)
	if err != nil {
		return WitnessRange{}, nil, err
	}
	fingerprints := map[string]string{"offsets.bin": offsetsRef.Sha256}
	for _, p := range packs {
		fingerprints[filepath.Base(p.Key)] = p.Sha256
	}
	fp, _ := json.Marshal(fingerprints)
	final := fmt.Sprintf("%s/witnesses/%020d-%020d-%s", namespace, first, last, sha256Hex(fp))
	os.RemoveAll(archive.path(final))
	if err := os.Rename(archive.path(staging), archive.path(final)); err != nil {
		return WitnessRange{}, nil, err
	}
	rename := func(r ObjectRef) ObjectRef { r.Key = final + strings.TrimPrefix(r.Key, staging); return r }
	rng := WitnessRange{First: first, Last: last, Offsets: rename(offsetsRef)}
	objs := []streamObject{{ref: rng.Offsets}}
	for _, p := range packs {
		p = rename(p)
		rng.Packs = append(rng.Packs, p)
		objs = append(objs, streamObject{ref: p})
	}
	return rng, objs, nil
}

// checkWitnessRanges: one range per segment, same boundaries, in order.
func checkWitnessRanges(st witnessState, bundles []BundleRef) error {
	if st.FirstBlock != 0 {
		return fmt.Errorf("witnesses start at block %d", st.FirstBlock)
	}
	if len(st.Ranges) != len(bundles) {
		return fmt.Errorf("%d witness ranges for %d segments", len(st.Ranges), len(bundles))
	}
	for i, r := range st.Ranges {
		if r.First != bundles[i].FirstBlock || r.Last != bundles[i].LastBlock || len(r.Packs) == 0 ||
			r.Offsets.Bytes != (r.Last-r.First+1)*witnessOffsetLen {
			return fmt.Errorf("witness range %d-%d does not match segment %d-%d", r.First, r.Last, bundles[i].FirstBlock, bundles[i].LastBlock)
		}
	}
	return nil
}

// witnessStage traces every block of every segment, one range at a time, resuming after the
// ranges WORK/witnesses.json already lists.
func witnessStage(w *workDir) error {
	layerRef, bundles := w.layerAndBundles()
	if layerRef == nil || len(bundles) == 0 {
		return errors.New("block bundles missing")
	}
	var st witnessState
	if err := readJSONFile(w.at(witnessStateFile), &st); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	src := layeredSource{local: localSource{w.archive()}}
	var target *streamTarget
	if w.opts.stream {
		var err error
		if target, err = w.streamTarget(); err != nil {
			return err
		}
		src.remote = s3Source{target.client, target.bucket}
	}
	layer, err := openLayerFrom(src, layerRef.Descriptor, newFrameCache(1<<30))
	if err != nil {
		return fmt.Errorf("open state layer: %w", err)
	}
	save := func() error {
		data, _ := json.MarshalIndent(st, "", "  ")
		if err := os.WriteFile(w.at(witnessStateFile+".tmp"), data, 0o644); err != nil {
			return err
		}
		return os.Rename(w.at(witnessStateFile+".tmp"), w.at(witnessStateFile))
	}
	workers := max(1, w.opts.concurrency)
	started := time.Now()
	var traced atomic.Uint64
	for _, b := range bundles[len(st.Ranges):] {
		frames := make([]frame, b.LastBlock-b.FirstBlock+1)
		blocks := make(chan uint64)
		var wg sync.WaitGroup
		var mu sync.Mutex
		var firstErr error
		var checked uint64
		for range workers {
			wg.Add(1)
			go func() {
				defer wg.Done()
				k := newKeccak()
				for n := range blocks {
					mu.Lock()
					stop := firstErr != nil
					mu.Unlock()
					if stop {
						continue
					}
					existence := func(a [20]byte) (bool, error) {
						if n == 0 {
							return false, nil
						}
						v, _, err := layer.get("accounts", a[:], n-1)
						return len(v) > 0, err
					}
					wit, err := traceWitness(w.rpc, n, k, existence)
					if err == nil && n%witnessCheckEvery == 0 {
						var c int
						c, err = checkWitness(layer, n, wit)
						mu.Lock()
						checked += uint64(c)
						mu.Unlock()
					}
					if err != nil {
						mu.Lock()
						if firstErr == nil {
							firstErr = err
						}
						mu.Unlock()
						continue
					}
					frames[n-b.FirstBlock] = compressFrame(wit.encode())
					traced.Add(1)
				}
			}()
		}
		for n := b.FirstBlock; n <= b.LastBlock; n++ {
			blocks <- n
		}
		close(blocks)
		wg.Wait()
		if firstErr != nil {
			return firstErr
		}
		rng, objs, err := writeWitnessRange(w.archive(), w.namespace, b.FirstBlock, frames)
		if err != nil {
			return err
		}
		st.Ranges = append(st.Ranges, rng)
		st.Checked += checked
		if target != nil {
			sst, err := target.put(context.Background(), w.archive(), objs)
			if err != nil {
				return err
			}
			if st.Uploaded == nil {
				st.Uploaded = map[uint64]bool{}
			}
			st.Uploaded[rng.First] = true
			_ = sst
		}
		if err := save(); err != nil {
			return err
		}
		done := float64(traced.Load())
		rate := done / time.Since(started).Seconds()
		fmt.Fprintf(os.Stderr, "{\"witnesses\":\"%d-%d\",\"blocks_per_s\":%.0f,\"eta_s\":%.0f,\"cross_checked_values\":%d}\n",
			rng.First, rng.Last, rate, float64(layerRef.LastBlock-rng.Last)/max(rate, 1e-9), st.Checked)
	}
	return nil
}
