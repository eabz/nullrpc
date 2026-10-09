//go:build cgo

package core

// In-process witness executor (docs/pipeline.md, "Witnesses").
//
// Each block is re-executed with Erigon's own EVM against the node's history, read-only, the
// way debug_traceBlockByNumber does (rpc/jsonrpc/tracing.go traceBlock), without a tracer,
// JSON or HTTP. State comes from a HistoryReaderV3 at txNum minTxNum(n)+1: the state at the
// start of block n after its pre-transaction system calls (Erigon executes those in the
// block's first system transaction, minTxNum). Every read the IntraBlockState sends to that
// reader is recorded; the IntraBlockState caches what it reads and what transactions write,
// so a key reaches the reader at most once per block, the first time a transaction touches
// it, and the reader always answers with the value at the start of the block.
//
// Every block is verified: the gas the execution used must equal the header's gas used (and
// blob gas used), and from Byzantium on the receipts it produced must hash to the header's
// receipts root. A block whose replay diverges stops the run.

import (
	"context"
	"fmt"
	"runtime/debug"

	lru "github.com/hashicorp/golang-lru/v2"
	"github.com/holiman/uint256"

	"github.com/erigontech/erigon/common"
	"github.com/erigontech/erigon/common/log/v3"
	ekv "github.com/erigontech/erigon/db/kv"
	"github.com/erigontech/erigon/execution/protocol"
	"github.com/erigontech/erigon/execution/protocol/rules"
	"github.com/erigontech/erigon/execution/state"
	"github.com/erigontech/erigon/execution/types"
	"github.com/erigontech/erigon/execution/types/accounts"
	"github.com/erigontech/erigon/execution/vm"
	"github.com/erigontech/erigon/execution/vm/evmtypes"
	"github.com/erigontech/erigon/node/rulesconfig"
)

// witnessCodeCache is how many bytecodes the executor keeps, by code hash, across blocks and
// workers. A code hash names one immutable bytecode, so a cached code is never stale.
const witnessCodeCache = 200_000

type witnessExecutor struct {
	db     *erigonDB
	engine rules.Engine
	codes  *lru.Cache[[32]byte, []byte]
}

func newWitnessExecutor(ctx context.Context, datadir string) (*witnessExecutor, func(), error) {
	db, err := openErigonDB(ctx, datadir)
	if err != nil {
		return nil, nil, err
	}
	logger := log.New()
	logger.SetHandler(log.LvlFilterHandler(log.LvlWarn, log.StderrHandler))
	codes, _ := lru.New[[32]byte, []byte](witnessCodeCache)
	x := &witnessExecutor{db: db, engine: rulesconfig.CreateRulesEngineBareBones(ctx, db.chain, logger), codes: codes}
	// Execution allocates heavily and keeps little: collect less often.
	debug.SetGCPercent(400)
	return x, func() { x.engine.Close(); db.close() }, nil
}

// readTx opens a read transaction for a batch of blocks. Batches stay short so the node's
// database is never pinned to an old snapshot for long.
func (x *witnessExecutor) readTx(ctx context.Context) (ekv.TemporalTx, error) {
	return x.db.db.BeginTemporalRo(ctx)
}

// recordingReader passes reads through to the history reader and keeps the first value of
// each account and storage slot.
type recordingReader struct {
	state.StateReader
	w     *blockWitness
	codes *lru.Cache[[32]byte, []byte]
	k     *keccak
}

// code serves an account's bytecode by the code hash it had at the start of the block (the
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

func (r *recordingReader) ReadAccountData(address accounts.Address) (*accounts.Account, error) {
	acc, err := r.StateReader.ReadAccountData(address)
	if err != nil {
		return nil, err
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
	if err != nil {
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

// execute replays block n inside tx and returns its witness.
func (x *witnessExecutor) execute(ctx context.Context, tx ekv.TemporalTx, n uint64) (*blockWitness, error) {
	w := newBlockWitness()
	if n == 0 {
		return w, nil // genesis has no transactions
	}
	hash, ok, err := x.db.reader.CanonicalHash(ctx, tx, n)
	if err != nil {
		return nil, fmt.Errorf("block %d: canonical hash: %w", n, err)
	}
	if !ok {
		return nil, fmt.Errorf("block %d: no canonical hash", n)
	}
	block, _, err := x.db.reader.BlockWithSenders(ctx, tx, hash, n)
	if err != nil {
		return nil, fmt.Errorf("block %d: %w", n, err)
	}
	if block == nil {
		return nil, fmt.Errorf("block %d: not found", n)
	}
	txs := block.Transactions()
	if len(txs) == 0 {
		return w, nil
	}
	cfg := x.db.chain
	header := block.HeaderNoCopy()
	minTxNum, err := x.db.txNums.Min(ctx, tx, n)
	if err != nil {
		return nil, fmt.Errorf("block %d: first txNum: %w", n, err)
	}
	ibs := state.New(&recordingReader{StateReader: state.NewHistoryReaderV3(tx, minTxNum+1), w: w, codes: x.codes, k: newKeccak()})
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
		if err := ibs.FinalizeTx(rules, state.NewNoopWriter()); err != nil {
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
	return w, nil
}
