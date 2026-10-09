//go:build cgo

package core

import (
	"bytes"
	"errors"
	"testing"

	"github.com/holiman/uint256"

	"github.com/erigontech/erigon/common"
	"github.com/erigontech/erigon/execution/chain"
	"github.com/erigontech/erigon/execution/state"
	"github.com/erigontech/erigon/execution/tracing"
	"github.com/erigontech/erigon/execution/types/accounts"
)

type overlayTestHistory struct {
	state.StateReader
	account                    *accounts.Account
	value                      uint256.Int
	present                    bool
	err                        error
	accountReads, storageReads int
}

func newOverlayTestHistory() *overlayTestHistory {
	acc := accounts.NewAccount()
	acc.Nonce = 1
	acc.Balance.SetUint64(100)
	return &overlayTestHistory{StateReader: state.NewNoopReader(), account: &acc, value: *uint256.NewInt(7), present: true}
}

func (h *overlayTestHistory) ReadAccountData(accounts.Address) (*accounts.Account, error) {
	h.accountReads++
	return h.account, h.err
}

func (h *overlayTestHistory) ReadAccountStorage(accounts.Address, accounts.StorageKey) (uint256.Int, bool, error) {
	h.storageReads++
	return h.value, h.present, h.err
}

func overlayTestKeys() (accounts.Address, accounts.StorageKey) {
	return accounts.InternAddress(common.Address{19: 1}), accounts.InternKey(common.Hash{31: 2})
}

func TestOverlayReadOnlyBlocksReuseHistory(t *testing.T) {
	addr, key := overlayTestKeys()
	history := newOverlayTestHistory()
	ov := newStateOverlay()
	var first []byte
	// Each block creates a fresh IBS and recorder, just like the executor. The
	// witness must still include keys supplied entirely from carried state.
	for block := uint64(1); block <= 3; block++ {
		wit := newBlockWitness()
		reader := &recordingReader{StateReader: &overlayReader{StateReader: history, o: ov}, w: wit, record: true}
		ibs := state.New(reader)
		ibs.SetTxContext(block, 0)
		balance, balanceErr := ibs.GetBalance(addr)
		value, storageErr := ibs.GetState(addr, key)
		ibs.Close()
		if balanceErr != nil || storageErr != nil || balance.Uint64() != 100 || value.Uint64() != 7 {
			t.Fatalf("block %d: balance %s, slot %s, errors %v/%v", block, &balance, &value, balanceErr, storageErr)
		}
		if len(wit.accounts) != 1 || len(wit.storage[[20]byte(addr.Value())]) != 1 {
			t.Fatalf("block %d: witness omitted cached reads", block)
		}
		if block == 1 {
			first = wit.encode()
		} else if !bytes.Equal(first, wit.encode()) {
			t.Fatalf("block %d: witness changed for unchanged state", block)
		}
	}
	if history.accountReads != 1 || history.storageReads != 1 {
		t.Fatalf("history reads: accounts=%d slots=%d, want one each across three blocks", history.accountReads, history.storageReads)
	}
}

func TestOverlayAccountCopiesAndAbsence(t *testing.T) {
	addr, _ := overlayTestKeys()
	history := newOverlayTestHistory()
	ov := newStateOverlay()
	reader := &overlayReader{StateReader: history, o: ov}
	acc, err := reader.ReadAccountData(addr)
	if err != nil {
		t.Fatal(err)
	}
	acc.Balance.SetUint64(200) // The miss result aliases history, never the cache.
	acc, err = reader.ReadAccountData(addr)
	if err != nil || acc.Balance.Uint64() != 100 {
		t.Fatalf("cached account changed through miss result: %+v, %v", acc, err)
	}
	acc.Balance.SetUint64(300) // Cache hits must return copies as well.
	acc, err = reader.ReadAccountDataForDebug(addr)
	if err != nil || acc.Balance.Uint64() != 100 || history.accountReads != 1 {
		t.Fatalf("cached account changed through hit result: %+v, %v; reads=%d", acc, err, history.accountReads)
	}

	ov.reset()
	history.account = nil
	for range 2 {
		acc, err = reader.ReadAccountData(addr)
		if err != nil || acc != nil {
			t.Fatalf("absent account: %+v, %v", acc, err)
		}
	}
	if history.accountReads != 2 || ov.entries != 1 {
		t.Fatalf("absence not cached: reads=%d entries=%d", history.accountReads, ov.entries)
	}
}

func TestOverlayStoragePresenceAndErrors(t *testing.T) {
	addr, key := overlayTestKeys()
	for _, tc := range []struct {
		name    string
		value   uint64
		present bool
	}{{"nonzero", 7, true}, {"missing", 0, false}, {"present zero", 0, true}} {
		t.Run(tc.name, func(t *testing.T) {
			history := newOverlayTestHistory()
			history.value.SetUint64(tc.value)
			history.present = tc.present
			ov := newStateOverlay()
			for range 2 {
				reader := &overlayReader{StateReader: history, o: ov}
				value, present, err := reader.ReadAccountStorage(addr, key)
				if err != nil || value.Uint64() != tc.value || present != tc.present {
					t.Fatalf("slot=%s present=%t err=%v", &value, present, err)
				}
			}
			if history.storageReads != 1 || ov.entries != 1 {
				t.Fatalf("slot not cached: reads=%d entries=%d", history.storageReads, ov.entries)
			}
		})
	}

	history := newOverlayTestHistory()
	history.err = errors.New("history unavailable")
	ov := newStateOverlay()
	reader := &overlayReader{StateReader: history, o: ov}
	if _, err := reader.ReadAccountData(addr); !errors.Is(err, history.err) {
		t.Fatalf("account error: %v", err)
	}
	if _, _, err := reader.ReadAccountStorage(addr, key); !errors.Is(err, history.err) {
		t.Fatalf("storage error: %v", err)
	}
	if ov.entries != 0 {
		t.Fatal("failed reads populated the cache")
	}
	history.err = nil
	history.account.Balance.SetUint64(200)
	history.value.SetUint64(9)
	acc, err := reader.ReadAccountData(addr)
	if err != nil || acc.Balance.Uint64() != 200 {
		t.Fatalf("account retry: %+v, %v", acc, err)
	}
	value, present, err := reader.ReadAccountStorage(addr, key)
	if err != nil || !present || value.Uint64() != 9 || history.accountReads != 2 || history.storageReads != 2 {
		t.Fatalf("retry slot=%s present=%t err=%v reads=%d/%d", &value, present, err, history.accountReads, history.storageReads)
	}
}

func TestOverlayIntraBlockWritesReplaceCachedReads(t *testing.T) {
	addr, key := overlayTestKeys()
	history := newOverlayTestHistory()
	ov := newStateOverlay()
	writer := &overlayWriter{o: ov}
	rules := &chain.Rules{IsSpuriousDragon: true}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	// The pre-transaction phase reads parent state, then commits its changes.
	pre := state.New(&overlayReader{StateReader: history, o: ov})
	defer pre.Close()
	pre.SetTxContext(1, -1)
	must(pre.SetBalance(addr, *uint256.NewInt(101), tracing.BalanceChangeUnspecified))
	must(pre.SetState(addr, key, *uint256.NewInt(9)))
	must(pre.FinalizeTx(rules, writer))

	wit := newBlockWitness()
	reader := &recordingReader{StateReader: &overlayReader{StateReader: history, o: ov}, w: wit, record: true}
	ibs := state.New(reader)
	defer ibs.Close()
	ibs.SetTxContext(1, 0)
	balance, err := ibs.GetBalance(addr)
	must(err)
	value, err := ibs.GetState(addr, key)
	must(err)
	if balance.Uint64() != 101 || value.Uint64() != 9 {
		t.Fatalf("pre-transaction writes lost: balance=%s slot=%s", &balance, &value)
	}
	for i, v := range []uint64{10, 9} {
		ibs.SetTxContext(1, i)
		must(ibs.SetState(addr, key, *uint256.NewInt(v)))
		must(ibs.FinalizeTx(rules, writer))
	}
	// Block-end state must carry forward but must not alter the witness.
	reader.record = false
	must(ibs.SetBalance(addr, *uint256.NewInt(111), tracing.BalanceIncreaseWithdrawal))
	must(ibs.CommitBlock(rules, writer))
	wa := wit.accounts[[20]byte(addr.Value())]
	if wa == nil || !bytes.Equal(wa.balance, []byte{101}) || !bytes.Equal(wit.storage[[20]byte(addr.Value())][[32]byte(key.Value())], []byte{9}) {
		t.Fatal("witness did not retain post-initialization, pre-transaction values")
	}
	next := state.New(&overlayReader{StateReader: history, o: ov})
	defer next.Close()
	balance, err = next.GetBalance(addr)
	must(err)
	value, err = next.GetState(addr, key)
	must(err)
	if balance.Uint64() != 111 || value.Uint64() != 9 || history.accountReads != 1 || history.storageReads != 1 {
		t.Fatalf("next block: balance=%s slot=%s history reads=%d/%d", &balance, &value, history.accountReads, history.storageReads)
	}
}

func TestOverlayDeletionCreationAndResetInvalidateReads(t *testing.T) {
	addr, key := overlayTestKeys()
	history := newOverlayTestHistory()
	ov := newStateOverlay()
	reader := &overlayReader{StateReader: history, o: ov}
	writer := &overlayWriter{o: ov}
	if _, err := reader.ReadAccountData(addr); err != nil {
		t.Fatal(err)
	}
	if _, _, err := reader.ReadAccountStorage(addr, key); err != nil {
		t.Fatal(err)
	}
	if err := writer.DeleteAccount(addr, history.account); err != nil {
		t.Fatal(err)
	}
	acc, err := reader.ReadAccountData(addr)
	if err != nil || acc != nil || ov.entries != 1 {
		t.Fatalf("deleted account: %+v, %v; entries=%d", acc, err, ov.entries)
	}
	// The next block's history has no old storage; invalidation must expose it.
	history.value.Clear()
	history.present = false
	value, present, err := reader.ReadAccountStorage(addr, key)
	if err != nil || !value.IsZero() || present || history.storageReads != 2 {
		t.Fatalf("deleted storage survived: %s, %t, %v", &value, present, err)
	}
	if err := writer.CreateContract(addr); err != nil {
		t.Fatal(err)
	}
	if ov.entries != 1 {
		t.Fatalf("creation did not invalidate negative storage cache: entries=%d", ov.entries)
	}
	created := accounts.NewAccount()
	created.Nonce = 1
	created.Balance.SetUint64(200)
	if err := writer.UpdateAccountData(addr, nil, &created); err != nil {
		t.Fatal(err)
	}
	created.Balance.SetUint64(300)
	acc, err = reader.ReadAccountData(addr)
	if err != nil || acc.Balance.Uint64() != 200 {
		t.Fatalf("writer account was not copied: %+v, %v", acc, err)
	}
	for _, n := range []uint64{8, 0, 7} {
		v := *uint256.NewInt(n)
		if err := writer.WriteAccountStorage(addr, 1, key, uint256.Int{}, v); err != nil {
			t.Fatal(err)
		}
		value, present, err = reader.ReadAccountStorage(addr, key)
		if err != nil || value != v || present != (n != 0) || ov.entries != 2 {
			t.Fatalf("write %d: %s, %t, %v; entries=%d", n, &value, present, err, ov.entries)
		}
	}
	ov.reset()
	if ov.entries != 0 {
		t.Fatal("reset did not clear entry count")
	}
	value, present, err = reader.ReadAccountStorage(addr, key)
	if err != nil || !value.IsZero() || present || history.storageReads != 3 {
		t.Fatalf("reset did not reread history: %s, %t, %v; reads=%d", &value, present, err, history.storageReads)
	}
}
