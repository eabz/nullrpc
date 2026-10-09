package core

// Live block extraction (docs/dags.md, "Block", K3–K8): everything the daemon stores for one
// block, pulled from the node over local RPC and checked.
//
//   - record:  eth_getBlockByNumber, eth_getBlockReceipts, debug_getRawBlock, built and checked
//              by the same code as the backfill (header hash, transaction hashes, receipts root).
//   - witness: prestateTracer (traceWitness, below): the first pre-state of each key the
//              block's transactions touch. The backfill executes blocks in process instead
//              (executor.go); both produce the witness frame of witness.go.
//   - diff:    the value after the block of every account, storage slot and code the block
//              changed. Transactions' changes come from prestateTracer in diffMode. Changes
//              made outside transactions are read at the block: withdrawal recipients'
//              accounts, and the slots the system contracts write (EIP-4788, EIP-2935, EIP-7002,
//              EIP-7251). debug_getModifiedAccountsByNumber lists every account the block
//              modified; any the diff lacks is read at the block too, so no account change is
//              missed.
//
// Selfdestruct only removes an account created in the same transaction (EIP-6780, Cancun),
// so a removed account's storage is exactly the slots the diff holds; an account that existed
// before the block and is removed stops the daemon.

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
)

const (
	diffAccounts = 1
	diffStorage  = 2
	diffCode     = 3
)

// diffEntry is one key's value after the block. An empty value deletes the key (no account,
// zero slot).
type diffEntry struct {
	Domain byte
	Key    []byte
	Value  []byte
}

// liveBlock is everything the daemon keeps for one block (the spool file).
type liveBlock struct {
	Number    uint64
	Hash      string
	Parent    string
	StateRoot string
	Timestamp uint64
	Record    []byte // block record, uncompressed
	Witness   []byte // witness, encoded
	TxHashes  []string
	Diff      []diffEntry
}

func (b *liveBlock) id() BlockID { return BlockID{Number: b.Number, Hash: b.Hash} }

// BlockID names one block.
type BlockID struct {
	Number uint64 `json:"number"`
	Hash   string `json:"hash"`
}

// System contracts whose storage the block writes outside transactions.
var (
	beaconRootsContract  = mustAddress("000f3df6d732807ef1319fb7b8bb8522d0beac02") // EIP-4788
	historyContract      = mustAddress("0000f90827f1c53a10cb7a02335b175320002935") // EIP-2935
	withdrawalsContract  = mustAddress("00000961ef480eb55e80d19ad83579a64c007002") // EIP-7002
	consolidatesContract = mustAddress("0000bbddc7ce488642fb579f8b00f3a590007251") // EIP-7251
)

const (
	beaconRootsRing = 8191
	historyRing     = 8191
)

func mustAddress(h string) [20]byte {
	var a [20]byte
	b, err := hex.DecodeString(h)
	if err != nil || len(b) != 20 {
		panic(h)
	}
	copy(a[:], b)
	return a
}

// blockHeaderJSON holds the block fields the daemon uses beyond the record.
type blockHeaderJSON struct {
	Number                string `json:"number"`
	Hash                  string `json:"hash"`
	ParentHash            string `json:"parentHash"`
	StateRoot             string `json:"stateRoot"`
	Timestamp             string `json:"timestamp"`
	ParentBeaconBlockRoot string `json:"parentBeaconBlockRoot"`
	RequestsHash          string `json:"requestsHash"`
	Withdrawals           []struct {
		Address string `json:"address"`
	} `json:"withdrawals"`
}

// extractBlock pulls and checks block n.
func extractBlock(rpc *rpcClient, n uint64, blobs recordRules) (*liveBlock, error) {
	plain, info, blockJSON, err := fetchBlockPlain(rpc, nil, n, blobs)
	if err != nil {
		return nil, err
	}
	var h blockHeaderJSON
	if err := json.Unmarshal(blockJSON, &h); err != nil {
		return nil, fmt.Errorf("block %d: %w", n, err)
	}
	ts, err := parseQuantity(h.Timestamp)
	if err != nil {
		return nil, fmt.Errorf("block %d timestamp: %w", n, err)
	}
	k := newKeccak()
	// Post-Spurious Dragon an empty account does not exist, so the tracer's empty accounts are
	// absent ones.
	wit, err := traceWitness(rpc, n, k, func([20]byte) (bool, error) { return false, nil })
	if err != nil {
		return nil, err
	}
	diff, err := blockDiff(rpc, n, ts, &h, wit, k)
	if err != nil {
		return nil, fmt.Errorf("block %d diff: %w", n, err)
	}
	return &liveBlock{
		Number: n, Hash: strings.ToLower(info.hash), Parent: strings.ToLower(info.parent),
		StateRoot: strings.ToLower(h.StateRoot), Timestamp: ts,
		Record: plain, Witness: wit.encode(), TxHashes: info.txHashes, Diff: diff,
	}, nil
}

// diffAccount is an account's state while the block's transactions are applied.
type diffAccount struct {
	exists   bool
	nonce    uint64
	balance  []byte
	codeHash [32]byte
	hasCode  bool
	existed  bool // before the block
}

// prestateDiff is one transaction's diffMode result.
type prestateDiff struct {
	Pre  map[string]prestateAccount `json:"pre"`
	Post map[string]prestateAccount `json:"post"`
}

func blockDiff(rpc *rpcClient, n, timestamp uint64, h *blockHeaderJSON, wit *blockWitness, k *keccak) ([]diffEntry, error) {
	accounts := map[[20]byte]*diffAccount{}
	slots := map[[20]byte]map[[32]byte][]byte{}
	codes := map[[32]byte][]byte{}
	changed := map[[20]byte]bool{}
	// An account's state before its first change: the witness holds every account the block's
	// transactions touch.
	base := func(a [20]byte) *diffAccount {
		if acc := accounts[a]; acc != nil {
			return acc
		}
		acc := &diffAccount{}
		if wa := wit.accounts[a]; wa != nil {
			acc = &diffAccount{exists: wa.exists, nonce: wa.nonce, balance: wa.balance, codeHash: wa.codeHash, hasCode: wa.hasCode, existed: wa.exists}
		}
		accounts[a] = acc
		return acc
	}
	setSlot := func(a [20]byte, s [32]byte, v []byte) {
		m := slots[a]
		if m == nil {
			m = map[[32]byte][]byte{}
			slots[a] = m
		}
		m[s] = trimLeadingZeros(v)
	}

	if n > 0 {
		raw, err := rpc.call("debug_traceBlockByNumber", fmt.Sprintf("0x%x", n), map[string]any{
			"tracer": "prestateTracer", "tracerConfig": map[string]any{"diffMode": true}, "timeout": witnessTraceTimout})
		if err != nil {
			return nil, err
		}
		var txs []struct {
			Result prestateDiff `json:"result"`
			Error  string       `json:"error"`
		}
		if err := json.Unmarshal(raw, &txs); err != nil {
			return nil, err
		}
		for i, tx := range txs {
			if tx.Error != "" {
				return nil, fmt.Errorf("transaction %d: %s", i, tx.Error)
			}
			// Accounts in post: changed fields. In pre but not post: removed.
			for addrHex, post := range tx.Result.Post {
				a, err := addressOf(addrHex)
				if err != nil {
					return nil, err
				}
				acc := base(a)
				acc.exists = true
				changed[a] = true
				if post.Balance != "" {
					b, err := quantityBytes(post.Balance)
					if err != nil {
						return nil, err
					}
					acc.balance = trimLeadingZeros(b)
				}
				if post.Nonce != "" {
					v, err := post.Nonce.Int64()
					if err != nil || v < 0 {
						return nil, fmt.Errorf("invalid nonce %q", post.Nonce)
					}
					acc.nonce = uint64(v)
				}
				if code := strings.TrimPrefix(post.Code, "0x"); code != "" {
					c, err := hex.DecodeString(code)
					if err != nil {
						return nil, err
					}
					acc.codeHash, acc.hasCode = k.sum(c), len(c) > 0
					if acc.hasCode {
						codes[acc.codeHash] = c
					}
				}
				for slotHex, valueHex := range post.Storage {
					s, v, err := slotValue(slotHex, valueHex)
					if err != nil {
						return nil, err
					}
					setSlot(a, s, v)
				}
			}
			for addrHex, pre := range tx.Result.Pre {
				a, err := addressOf(addrHex)
				if err != nil {
					return nil, err
				}
				post, inPost := tx.Result.Post[addrHex]
				if !inPost {
					acc := base(a)
					if acc.existed {
						// An account that existed before the block is removed only if it had no
						// nonce and no code: a contract created at its address and selfdestructed in
						// the same transaction (EIP-6780; the address may hold a balance sent ahead
						// of the deployment), or an empty account a transaction touched (EIP-161).
						// The diff cannot list storage it never saw, so that must be empty too.
						if wa := wit.accounts[a]; !undeployed(wa) {
							if wa == nil {
								return nil, fmt.Errorf("account %x that existed before the block was removed; the witness lacks it", a)
							}
							return nil, fmt.Errorf("account %x that existed before the block was removed, deployed before it (nonce %d, balance 0x%x, code %v)", a, wa.nonce, wa.balance, wa.hasCode)
						}
						if err := checkNoStorage(rpc, h.Hash, a); err != nil {
							return nil, fmt.Errorf("account %x removed: %w", a, err)
						}
					}
					*acc = diffAccount{}
					changed[a] = true
				}
				// Slots in pre but not in post were cleared.
				for slotHex := range pre.Storage {
					if _, kept := post.Storage[slotHex]; kept {
						continue
					}
					s, _, err := slotValue(slotHex, "0x0")
					if err != nil {
						return nil, err
					}
					setSlot(a, s, nil)
				}
			}
		}
	}

	// Outside transactions: withdrawals, system contracts, and anything else the node reports.
	readAccount := func(a [20]byte) error {
		acc, code, err := accountAt(rpc, a, n, k)
		if err != nil {
			return err
		}
		prev := base(a)
		acc.existed = prev.existed
		*prev = *acc
		if acc.hasCode {
			codes[acc.codeHash] = code
		}
		changed[a] = true
		return nil
	}
	for _, w := range h.Withdrawals {
		a, err := addressOf(w.Address)
		if err != nil {
			return nil, err
		}
		if err := readAccount(a); err != nil {
			return nil, err
		}
	}
	readSlots := func(contract [20]byte, keys ...uint64) error {
		for _, key := range keys {
			var s [32]byte
			binary.BigEndian.PutUint64(s[24:], key)
			v, err := storageAt(rpc, contract, s, n)
			if err != nil {
				return err
			}
			setSlot(contract, s, v)
		}
		return nil
	}
	if h.ParentBeaconBlockRoot != "" { // Cancun: EIP-4788
		if err := readSlots(beaconRootsContract, timestamp%beaconRootsRing, timestamp%beaconRootsRing+beaconRootsRing); err != nil {
			return nil, err
		}
	}
	if h.RequestsHash != "" && n > 0 { // Prague: EIP-2935, EIP-7002, EIP-7251
		if err := readSlots(historyContract, (n-1)%historyRing); err != nil {
			return nil, err
		}
		for _, c := range [][20]byte{withdrawalsContract, consolidatesContract} {
			if err := readSlots(c, 0, 1, 2, 3); err != nil {
				return nil, err
			}
		}
	}
	modified, err := modifiedAccounts(rpc, n)
	if err != nil {
		return nil, err
	}
	for _, a := range modified {
		if !changed[a] {
			if err := readAccount(a); err != nil {
				return nil, err
			}
		}
	}

	var out []diffEntry
	for a := range changed {
		acc := accounts[a]
		var v []byte
		if acc.exists {
			v = encodeAccount(account{nonce: acc.nonce, balance: acc.balance, codeHash: acc.codeHash, hasCode: acc.hasCode})
		}
		out = append(out, diffEntry{Domain: diffAccounts, Key: bytes.Clone(a[:]), Value: v})
	}
	for a, m := range slots {
		for s, v := range m {
			key := append(bytes.Clone(a[:]), s[:]...)
			out = append(out, diffEntry{Domain: diffStorage, Key: key, Value: v})
		}
	}
	for h, c := range codes {
		out = append(out, diffEntry{Domain: diffCode, Key: bytes.Clone(h[:]), Value: c})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Domain != out[j].Domain {
			return out[i].Domain < out[j].Domain
		}
		return bytes.Compare(out[i].Key, out[j].Key) < 0
	})
	return out, nil
}

// undeployed tells whether an account has no nonce and no code, whatever its balance: a
// contract can still be created at its address.
func undeployed(wa *witnessAccount) bool {
	return wa != nil && wa.nonce == 0 && !wa.hasCode
}

// checkNoStorage fails unless account a holds no storage at the start of the block blockHash.
func checkNoStorage(rpc *rpcClient, blockHash string, a [20]byte) error {
	raw, err := rpc.call("debug_storageRangeAt", blockHash, 0, "0x"+hex.EncodeToString(a[:]), "0x"+strings.Repeat("0", 64), 1)
	if err != nil {
		return err
	}
	var r struct {
		Storage map[string]json.RawMessage `json:"storage"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return err
	}
	if len(r.Storage) > 0 {
		return errors.New("it holds storage, which the diff cannot remove")
	}
	return nil
}

func addressOf(h string) ([20]byte, error) {
	var a [20]byte
	b, err := decodeData(h, 20)
	if err != nil {
		return a, fmt.Errorf("address %q: %w", h, err)
	}
	copy(a[:], b)
	return a, nil
}

func slotValue(slotHex, valueHex string) ([32]byte, []byte, error) {
	var s [32]byte
	sb, err := decodeData(slotHex, 32)
	if err != nil {
		return s, nil, fmt.Errorf("slot %q: %w", slotHex, err)
	}
	copy(s[:], sb)
	v, err := quantityBytes(normalizeQuantity(valueHex))
	if err != nil {
		return s, nil, fmt.Errorf("slot value %q: %w", valueHex, err)
	}
	return s, trimLeadingZeros(v), nil
}

// normalizeQuantity turns a 32-byte data value (0x00…01) into a quantity (0x1).
func normalizeQuantity(v string) string {
	t := strings.TrimLeft(strings.TrimPrefix(v, "0x"), "0")
	if t == "" {
		return "0x0"
	}
	return "0x" + t
}

// accountAt reads an account's state after block n.
func accountAt(rpc *rpcClient, a [20]byte, n uint64, k *keccak) (*diffAccount, []byte, error) {
	addr, tag := "0x"+hex.EncodeToString(a[:]), fmt.Sprintf("0x%x", n)
	results, err := rpc.batch([]rpcCall{
		{"eth_getBalance", []any{addr, tag}},
		{"eth_getTransactionCount", []any{addr, tag}},
		{"eth_getCode", []any{addr, tag}},
	})
	if err != nil {
		return nil, nil, err
	}
	var bal, nonce, code string
	json.Unmarshal(results[0], &bal)
	json.Unmarshal(results[1], &nonce)
	json.Unmarshal(results[2], &code)
	b, err := quantityBytes(bal)
	if err != nil {
		return nil, nil, err
	}
	nn, err := parseQuantity(nonce)
	if err != nil {
		return nil, nil, err
	}
	c, err := hex.DecodeString(strings.TrimPrefix(code, "0x"))
	if err != nil {
		return nil, nil, err
	}
	acc := &diffAccount{nonce: nn, balance: trimLeadingZeros(b)}
	if len(c) > 0 {
		acc.codeHash, acc.hasCode = k.sum(c), true
	}
	acc.exists = acc.nonce > 0 || len(acc.balance) > 0 || acc.hasCode
	return acc, c, nil
}

func storageAt(rpc *rpcClient, a [20]byte, s [32]byte, n uint64) ([]byte, error) {
	raw, err := rpc.call("eth_getStorageAt", "0x"+hex.EncodeToString(a[:]), "0x"+hex.EncodeToString(s[:]), fmt.Sprintf("0x%x", n))
	if err != nil {
		return nil, err
	}
	var v string
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, err
	}
	b, err := quantityBytes(normalizeQuantity(v))
	if err != nil {
		return nil, err
	}
	return trimLeadingZeros(b), nil
}

// modifiedAccounts lists the accounts block n modified (Erigon's debug_getModifiedAccountsByNumber).
func modifiedAccounts(rpc *rpcClient, n uint64) ([][20]byte, error) {
	raw, err := rpc.call("debug_getModifiedAccountsByNumber", n)
	if err != nil {
		if strings.Contains(err.Error(), "empty result") {
			return nil, nil
		}
		return nil, err
	}
	var list []string
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, err
	}
	out := make([][20]byte, 0, len(list))
	for _, h := range list {
		a, err := addressOf(h)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, nil
}

// blockLogKeys returns a block's distinct log index keys.
func blockLogKeys(record []byte, hash string, number uint64, k *keccak) ([]uint64, error) {
	h, err := decodeData(hash, 32)
	if err != nil {
		return nil, err
	}
	var keys []uint64
	if _, err := recordLogs(record, k, h, number, func(address []byte, topics [][]byte) {
		d := logAddressDigest(address)
		keys = append(keys, hashKey(d[:], logIndexKeyBytes))
		for i, t := range topics {
			d := logTopicDigest(i, t)
			keys = append(keys, hashKey(d[:], logIndexKeyBytes))
		}
	}); err != nil {
		return nil, err
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	out := keys[:0]
	for i, kk := range keys {
		if i == 0 || kk != keys[i-1] {
			out = append(out, kk)
		}
	}
	return out, nil
}

// The daemon traces each new block on its own node: a block's witness from the
// prestateTracer, keeping the first pre-state of each key in the block.
const witnessTraceTimout = "600s"

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
