//go:build cgo

package core

// In-process witness executor (docs/pipeline.md, "Witnesses").
//
// Each block is re-executed with Erigon's own EVM against the node's history, read-only, the
// way debug_traceBlockByNumber does (rpc/jsonrpc/tracing.go traceBlock), without a tracer,
// JSON or HTTP. The transactions read state through a HistoryReaderV3 at txNum
// minTxNum(n)+1: the state at the start of block n after its pre-transaction system calls
// (Erigon executes those in the block's first system transaction, minTxNum). Every read the
// IntraBlockState sends to that reader is recorded; the IntraBlockState caches what it reads
// and what transactions write, so a key reaches the reader at most once per block, the first
// time a transaction touches it, and the reader always answers with the value at the start
// of the block.
//
// Carried state: a worker executes a run of consecutive blocks and keeps, in a stateOverlay,
// the value after each block of every key the block touched. The next block reads those keys
// from the overlay and only the others from the history files, which are the slow reads. The
// overlay is kept exact by running each block the way the node does, with Erigon's engine:
// the pre-transaction system calls (from the state at the end of the parent block, history
// txNum minTxNum), the transactions, and the block's end (rewards, withdrawals, request
// system calls), with every write applied to the overlay. Nothing about which keys change
// outside transactions is assumed. The witness records only the transactions' reads. The
// overlay is a cache of the history, never a source: anything not in it is read from the
// history, and one block in witnessOverlayCheckEvery is executed again from the history
// alone and must give the same witness, byte for byte.
//
// Every block is verified: the gas the execution used must equal the header's gas used (and
// blob gas used), and from Byzantium on the receipts it produced must hash to the header's
// receipts root. A block whose replay diverges stops the run.

import (
	"bufio"
	"cmp"
	"context"
	"fmt"
	"os"
	"runtime/debug"
	"strconv"
	"strings"

	lru "github.com/hashicorp/golang-lru/v2"
	"github.com/holiman/uint256"

	"github.com/erigontech/erigon/common"
	"github.com/erigontech/erigon/common/log/v3"
	ekv "github.com/erigontech/erigon/db/kv"
	"github.com/erigontech/erigon/execution/exec"
	"github.com/erigontech/erigon/execution/protocol"
	"github.com/erigontech/erigon/execution/protocol/rules"
	"github.com/erigontech/erigon/execution/state"
	"github.com/erigontech/erigon/execution/types"
	"github.com/erigontech/erigon/execution/types/accounts"
	"github.com/erigontech/erigon/execution/vm"
	"github.com/erigontech/erigon/execution/vm/evmtypes"
	"github.com/erigontech/erigon/node/rulesconfig"
)

const (
	// witnessCodeCache is how many bytecodes the executor keeps, by code hash, across blocks
	// and workers. A code hash names one immutable bytecode, so a cached code is never stale.
	witnessCodeCache = 200_000
)

type witnessExecutor struct {
	db     *erigonDB
	engine rules.Engine
	codes  *lru.Cache[[32]byte, []byte]
	logger log.Logger
	// overlayEntries bounds each worker's carried state (0: witnessOverlayEntries).
	overlayEntries int
}

func newWitnessExecutor(ctx context.Context, datadir string) (*witnessExecutor, func(), error) {
	db, release, err := sharedErigonDB(ctx, datadir)
	if err != nil {
		return nil, nil, err
	}
	logger := log.New()
	logger.SetHandler(log.LvlFilterHandler(log.LvlWarn, log.StderrHandler))
	codes, _ := lru.New[[32]byte, []byte](witnessCodeCache)
	x := &witnessExecutor{db: db, engine: rulesconfig.CreateRulesEngineBareBones(ctx, db.chain, logger), codes: codes, logger: logger}
	// Execution allocates heavily and keeps little: collect less often, but never past 80%
	// of physical memory, since the state dump may be running in the same process.
	debug.SetGCPercent(400)
	if limit := physicalMemory() / 10 * 8; limit > 0 && os.Getenv("GOMEMLIMIT") == "" {
		debug.SetMemoryLimit(int64(limit))
	}
	return x, func() { x.engine.Close(); release() }, nil
}

// physicalMemory is the machine's RAM in bytes from /proc/meminfo, or 0 where that is
// unavailable.
func physicalMemory() uint64 {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if fields := strings.Fields(sc.Text()); len(fields) >= 2 && fields[0] == "MemTotal:" {
			kb, _ := strconv.ParseUint(fields[1], 10, 64)
			return kb * 1024
		}
	}
	return 0
}

// refresh rescans the node's files (erigonDB.refresh).
func (x *witnessExecutor) refresh(ctx context.Context) error { return x.db.refresh(ctx) }

// readTx opens a read transaction for a batch of blocks. Batches stay short so the node's
// database is never pinned to an old snapshot for long.
func (x *witnessExecutor) readTx(ctx context.Context) (ekv.TemporalTx, error) {
	return x.db.db.BeginTemporalRo(ctx)
}

// stateOverlay is one worker's carried state: the value after the last executed block of
// every key that block, or an earlier block of the run, touched.
type stateOverlay struct {
	accounts map[[20]byte]*accounts.Account // nil: the account does not exist
	storage  map[[20]byte]map[[32]byte]overlaySlot
	entries  int
}

type overlaySlot struct {
	value   uint256.Int
	present bool
}

func newStateOverlay() *stateOverlay {
	o := &stateOverlay{}
	o.reset()
	return o
}

func (o *stateOverlay) reset() {
	o.accounts = map[[20]byte]*accounts.Account{}
	o.storage = map[[20]byte]map[[32]byte]overlaySlot{}
	o.entries = 0
}

func (o *stateOverlay) putAccount(a [20]byte, acc *accounts.Account) {
	if _, ok := o.accounts[a]; !ok {
		o.entries++
	}
	o.accounts[a] = acc
}

func (o *stateOverlay) putSlot(a [20]byte, s [32]byte, v uint256.Int, present bool) {
	slots := o.storage[a]
	if slots == nil {
		slots = map[[32]byte]overlaySlot{}
		o.storage[a] = slots
	}
	if _, ok := slots[s]; !ok {
		o.entries++
	}
	slots[s] = overlaySlot{value: v, present: present}
}

// trim keeps the overlay under limit entries: the storage slots go first (the larger and
// colder part), the accounts only if that is not enough. Anything dropped is read from the
// history again.
func (o *stateOverlay) trim(limit int) {
	if o.entries <= limit {
		return
	}
	for a := range o.storage {
		o.dropStorage(a)
	}
	if o.entries > limit {
		o.reset()
	}
}

func (o *stateOverlay) dropStorage(a [20]byte) {
	o.entries -= len(o.storage[a])
	delete(o.storage, a)
}

// overlayReader serves reads from the overlay and caches successful history reads,
// including absent accounts and zero slots. Later writes replace these values.
type overlayReader struct {
	state.StateReader
	o *stateOverlay
}

func (r *overlayReader) ReadAccountData(address accounts.Address) (*accounts.Account, error) {
	a := [20]byte(address.Value())
	if acc, ok := r.o.accounts[a]; ok {
		if acc == nil {
			return nil, nil
		}
		cp := *acc
		return &cp, nil
	}
	acc, err := r.StateReader.ReadAccountData(address)
	if err == nil {
		var cached *accounts.Account
		if acc != nil {
			cp := *acc
			cached = &cp
		}
		r.o.putAccount(a, cached)
	}
	return acc, err
}

func (r *overlayReader) ReadAccountDataForDebug(address accounts.Address) (*accounts.Account, error) {
	return r.ReadAccountData(address)
}

func (r *overlayReader) ReadAccountStorage(address accounts.Address, key accounts.StorageKey) (uint256.Int, bool, error) {
	a, s := [20]byte(address.Value()), [32]byte(key.Value())
	if slots := r.o.storage[a]; slots != nil {
		if slot, ok := slots[s]; ok {
			return slot.value, slot.present, nil
		}
	}
	v, present, err := r.StateReader.ReadAccountStorage(address, key)
	if err == nil {
		r.o.putSlot(a, s, v, present)
	}
	return v, present, err
}

// overlayWriter applies a block's writes to the overlay.
type overlayWriter struct {
	o     *stateOverlay
	codes *lru.Cache[[32]byte, []byte]
}

func (w *overlayWriter) UpdateAccountData(address accounts.Address, _, account *accounts.Account) error {
	cp := *account
	w.o.putAccount([20]byte(address.Value()), &cp)
	return nil
}

func (w *overlayWriter) UpdateAccountCode(_ accounts.Address, _ uint64, codeHash accounts.CodeHash, code []byte) error {
	if !codeHash.IsEmpty() && len(code) > 0 {
		w.codes.Add(codeHash.Value(), code)
	}
	return nil
}

func (w *overlayWriter) DeleteAccount(address accounts.Address, _ *accounts.Account) error {
	a := [20]byte(address.Value())
	w.o.putAccount(a, nil)
	w.o.dropStorage(a)
	return nil
}

func (w *overlayWriter) WriteAccountStorage(address accounts.Address, _ uint64, key accounts.StorageKey, _, value uint256.Int) error {
	w.o.putSlot([20]byte(address.Value()), [32]byte(key.Value()), value, !value.IsZero())
	return nil
}

func (w *overlayWriter) CreateContract(address accounts.Address) error {
	w.o.dropStorage([20]byte(address.Value())) // a new contract starts with empty storage
	return nil
}

// recordingReader passes reads through and keeps the first value of each account and
// storage slot while record is set.
type recordingReader struct {
	state.StateReader
	w      *blockWitness
	record bool
	codes  *lru.Cache[[32]byte, []byte]
	k      *keccak
}

func (r *recordingReader) ReadAccountData(address accounts.Address) (*accounts.Account, error) {
	acc, err := r.StateReader.ReadAccountData(address)
	if err != nil || !r.record {
		return acc, err
	}
	a := [20]byte(address.Value())
	if _, seen := r.w.accounts[a]; !seen {
		wa := &witnessAccount{}
		if acc != nil {
			wa.exists, wa.nonce, wa.balance = true, acc.Nonce, acc.Balance.Bytes()
			if !acc.CodeHash.IsEmpty() {
				wa.codeHash, wa.hasCode = acc.CodeHash.Value(), true
			}
		}
		r.w.accounts[a] = wa
	}
	return acc, nil
}

func (r *recordingReader) ReadAccountStorage(address accounts.Address, key accounts.StorageKey) (uint256.Int, bool, error) {
	v, ok, err := r.StateReader.ReadAccountStorage(address, key)
	if err != nil || !r.record {
		return v, ok, err
	}
	a := [20]byte(address.Value())
	slots := r.w.storage[a]
	if slots == nil {
		slots = map[[32]byte][]byte{}
		r.w.storage[a] = slots
	}
	s := [32]byte(key.Value())
	if _, seen := slots[s]; !seen {
		slots[s] = v.Bytes()
	}
	return v, ok, nil
}

// code serves an account's bytecode by the code hash the witness recorded for it (the
// IntraBlockState only asks the reader for code of accounts it read from the reader). A
// bytecode read from history is checked against its hash before it is cached.
func (r *recordingReader) code(address accounts.Address) ([]byte, error) {
	a := [20]byte(address.Value())
	acc := r.w.accounts[a]
	if acc == nil || !acc.hasCode {
		return r.StateReader.ReadAccountCode(address)
	}
	if code, ok := r.codes.Get(acc.codeHash); ok {
		return code, nil
	}
	code, err := r.StateReader.ReadAccountCode(address)
	if err != nil {
		return nil, err
	}
	if r.k.sum(code) != acc.codeHash {
		return nil, fmt.Errorf("account %x: code does not match its code hash %x", a, acc.codeHash)
	}
	r.codes.Add(acc.codeHash, code)
	return code, nil
}

func (r *recordingReader) ReadAccountCode(address accounts.Address) ([]byte, error) {
	return r.code(address)
}

func (r *recordingReader) ReadAccountCodeSize(address accounts.Address) (int, error) {
	code, err := r.code(address)
	return len(code), err
}

// execute replays block n inside tx and returns its witness. With an overlay, the block is
// run from the overlay's state and its every change is applied to the overlay; the overlay
// must hold the state after block n-1 (or nothing).
func (x *witnessExecutor) execute(ctx context.Context, tx ekv.TemporalTx, n uint64, ov *stateOverlay) (*blockWitness, error) {
	w := newBlockWitness()
	if n == 0 {
		return w, nil // genesis has no transactions
	}
	hash, ok, err := x.db.reader.CanonicalHash(ctx, tx, n)
	if err != nil {
		return nil, fmt.Errorf("block %d: canonical hash: %w", n, err)
	}
	if !ok {
		return nil, fmt.Errorf("block %d: no canonical hash: %w", n, errStaleView)
	}
	block, _, err := x.db.reader.BlockWithSenders(ctx, tx, hash, n)
	if err != nil {
		return nil, fmt.Errorf("block %d: %w", n, err)
	}
	if block == nil {
		return nil, fmt.Errorf("block %d: not found: %w", n, errStaleView)
	}
	txs := block.Transactions()
	if len(txs) == 0 && ov == nil {
		return w, nil
	}
	cfg := x.db.chain
	header := block.HeaderNoCopy()
	minTxNum, err := x.db.txNums.Min(ctx, tx, n)
	if err != nil {
		return nil, fmt.Errorf("block %d: first txNum: %w", n, err)
	}
	chainReader := exec.NewChainReader(cfg, tx, x.db.reader, x.logger)
	rec := &recordingReader{StateReader: state.NewHistoryReaderV3(tx, minTxNum+1), w: w, codes: x.codes, k: newKeccak()}
	var writer state.StateWriter = state.NewNoopWriter()
	if ov != nil {
		writer = &overlayWriter{o: ov, codes: x.codes}
		// The pre-transaction system calls, from the state at the end of the parent block.
		pre := state.New(&overlayReader{StateReader: state.NewHistoryReaderV3(tx, minTxNum), o: ov})
		err := protocol.InitializeBlockExecution(x.engine, chainReader, header, cfg, pre, writer, x.logger, nil)
		pre.Close()
		if err != nil {
			return nil, fmt.Errorf("block %d: pre-transaction system calls: %w", n, err)
		}
		rec.StateReader = &overlayReader{StateReader: rec.StateReader, o: ov}
	}
	rec.record = true
	ibs := state.New(rec)
	defer ibs.Close()
	getHeader := func(_ common.Hash, number uint64) (*types.Header, error) {
		return x.db.reader.HeaderByNumber(ctx, tx, number)
	}
	blockCtx := protocol.NewEVMBlockContext(header, protocol.GetHashFn(header, getHeader), x.engine, accounts.NilAddress, cfg)
	rules := blockCtx.Rules(cfg)
	signer := types.MakeSigner(cfg, n, header.Time)
	evm := vm.NewEVM(blockCtx, evmtypes.TxContext{}, ibs, cfg, vm.Config{})
	var gas protocol.GasUsed
	receipts := make(types.Receipts, 0, len(txs))
	for i, txn := range txs {
		ibs.SetTxContext(n, i)
		msg, err := txn.AsMessage(*signer, block.BaseFee(), rules)
		if err != nil {
			return nil, fmt.Errorf("block %d transaction %d: %w", n, i, err)
		}
		evm.Reset(protocol.NewEVMTxContext(msg), ibs)
		gp := new(protocol.GasPool).AddGas(msg.Gas()).AddBlobGas(msg.BlobGas())
		res, err := protocol.ApplyMessage(evm, msg, gp, true /* refunds */, false /* gasBailout */, x.engine)
		if err != nil {
			return nil, fmt.Errorf("block %d transaction %d: %w", n, i, err)
		}
		if err := ibs.FinalizeTx(rules, writer); err != nil {
			return nil, fmt.Errorf("block %d transaction %d: %w", n, i, err)
		}
		gas.Receipt += res.ReceiptGasUsed
		gas.BlockExecution += res.BlockExecutionGasUsed
		gas.BlockState += res.BlockStateGasUsed
		gas.Blob += txn.GetBlobGas()
		receipts = append(receipts, protocol.MakeReceipt(&header.Number, hash, msg, txn, gas.Receipt, res, ibs, evm))
	}
	if got := gas.BlockGasUsed(); got != header.GasUsed {
		return nil, fmt.Errorf("block %d: replay used %d gas, the header records %d", n, got, header.GasUsed)
	}
	if header.BlobGasUsed != nil && *header.BlobGasUsed != gas.Blob {
		return nil, fmt.Errorf("block %d: replay used %d blob gas, the header records %d", n, gas.Blob, *header.BlobGasUsed)
	}
	if rules.IsByzantium {
		if root := types.DeriveSha(receipts); root != header.ReceiptHash {
			return nil, fmt.Errorf("block %d: replayed receipts root %x, the header records %x", n, root, header.ReceiptHash)
		}
	}
	if ov != nil {
		// The block's end: rewards, withdrawals and request system calls, then every
		// account the block changed is written to the overlay.
		rec.record = false
		if _, _, err := protocol.FinalizeBlockExecution(x.engine, rec, header, txs, block.Uncles(), writer, cfg, ibs,
			receipts, block.Withdrawals(), chainReader, false, x.logger, nil); err != nil {
			return nil, fmt.Errorf("block %d: block end: %w", n, err)
		}
		ov.trim(cmp.Or(x.overlayEntries, witnessOverlayEntries))
	}
	return w, nil
}
