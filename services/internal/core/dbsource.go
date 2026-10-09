//go:build cgo

package core

// Block source that reads a running Erigon v3.7.1 node's datadir directly
// with Erigon's own libraries, the way `rpcdaemon --datadir` (local mode,
// cmd/rpcdaemon/cli/config.go RemoteServices) does, but strictly read-only:
//
//   - chaindata (MDBX) is opened with Accede (never create) and Readonly
//     (MDBX_RDONLY: no write transactions are possible; tables are opened in a
//     read transaction). Like every MDBX reader, the process registers in the
//     reader table of chaindata/mdbx.lck, as rpcdaemon does.
//   - the block files (snapshots/*.seg + .idx) and state files are opened with
//     OpenFolder, which only mmaps existing files read-only. Nothing that
//     builds, merges, prunes or deletes files is ever called; files Erigon
//     retires are only closed. erigondb.toml and salt-state.txt must already
//     exist, so the open path never writes them.
//
// Per block it reads what eth_getBlockByNumber, eth_getBlockReceipts and
// debug_getRawBlock read: BlockReader.BlockWithSenders (headers, bodies and
// transactions with stored senders, from block files or MDBX) and
// rawdb.ReadReceiptsCacheV2 (the persisted receipts in the rcache domain, the
// path GetReceipts serves when the receipts are persisted). Blocks the
// database cannot serve without execution (pre-Byzantium, or receipts not
// persisted) fall back to the JSON-RPC source for that block.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/erigontech/erigon/common"
	"github.com/erigontech/erigon/common/log/v3"
	"github.com/erigontech/erigon/db/datadir"
	ekv "github.com/erigontech/erigon/db/kv"
	"github.com/erigontech/erigon/db/kv/dbcfg"
	kvmdbx "github.com/erigontech/erigon/db/kv/mdbx"
	"github.com/erigontech/erigon/db/kv/rawdbv3"
	"github.com/erigontech/erigon/db/kv/temporal"
	"github.com/erigontech/erigon/db/rawdb"
	"github.com/erigontech/erigon/db/snapshotsync/blocksnapshots"
	"github.com/erigontech/erigon/db/snapshotsync/freezeblocks"
	dbstate "github.com/erigontech/erigon/db/state"
	"github.com/erigontech/erigon/execution/chain"
	"github.com/erigontech/erigon/execution/protocol/misc"
	"github.com/erigontech/erigon/execution/rlp"
	"github.com/erigontech/erigon/execution/types"
	"github.com/erigontech/erigon/node/ethconfig"
	"github.com/erigontech/erigon/node/ethconfig/features"
)

const defaultBlockSource = "db"

type erigonDB struct {
	raw    ekv.RwDB
	agg    *dbstate.Aggregator
	snaps  *blocksnapshots.RoSnapshots
	db     *temporal.DB
	reader *freezeblocks.BlockReader
	txNums rawdbv3.TxNumsReader
	chain  *chain.Config
}

// datadirChain reads the chain ID and genesis hash recorded in a datadir's chaindata,
// read-only, so a run can check that the datadir and the RPC belong to the same chain.
func datadirChain(ctx context.Context, path string) (uint64, string, error) {
	logger := log.New()
	logger.SetHandler(log.LvlFilterHandler(log.LvlWarn, log.StderrHandler))
	dirs := datadir.Open(path)
	if _, err := os.Stat(filepath.Join(dirs.Chaindata, "mdbx.dat")); err != nil {
		return 0, "", err
	}
	db, err := kvmdbx.New(dbcfg.ChainDB, logger).Path(dirs.Chaindata).Accede(true).Readonly(true).Open(ctx)
	if err != nil {
		return 0, "", fmt.Errorf("open chaindata read-only: %w", err)
	}
	defer db.Close()
	var id uint64
	var hash string
	err = db.View(ctx, func(tx ekv.Tx) error {
		genesis, err := rawdb.ReadCanonicalHash(tx, 0)
		if err != nil {
			return err
		}
		cfg, err := rawdb.ReadChainConfig(tx, genesis)
		if err != nil {
			return err
		}
		if cfg == nil || cfg.ChainID == nil {
			return errors.New("chain config not found in chaindata")
		}
		id, hash = cfg.ChainID.Uint64(), strings.ToLower(genesis.Hex())
		return nil
	})
	return id, hash, err
}

// One open per datadir per process (MDBX refuses a second open of the same environment in
// one process), shared by the stages that run at the same time and closed with the last
// release.
var sharedDBs struct {
	sync.Mutex
	open map[string]*sharedDB
}

type sharedDB struct {
	db   *erigonDB
	refs int
}

func sharedErigonDB(ctx context.Context, datadir string) (*erigonDB, func(), error) {
	sharedDBs.Lock()
	defer sharedDBs.Unlock()
	if sharedDBs.open == nil {
		sharedDBs.open = map[string]*sharedDB{}
	}
	key := filepath.Clean(datadir)
	s := sharedDBs.open[key]
	if s == nil {
		db, err := openErigonDB(ctx, datadir)
		if err != nil {
			return nil, nil, err
		}
		s = &sharedDB{db: db}
		sharedDBs.open[key] = s
	}
	s.refs++
	release := func() {
		sharedDBs.Lock()
		defer sharedDBs.Unlock()
		if s.refs--; s.refs == 0 {
			s.db.close()
			delete(sharedDBs.open, key)
		}
	}
	return s.db, release, nil
}

// openErigonDB opens datadir next to the running node, read-only.
func openErigonDB(ctx context.Context, path string) (*erigonDB, error) {
	logger := log.New()
	logger.SetHandler(log.LvlFilterHandler(log.LvlWarn, log.StderrHandler))
	log.Root().SetHandler(log.LvlFilterHandler(log.LvlWarn, log.StderrHandler))
	dirs := datadir.Open(path) // datadir.New would create missing directories
	// Files whose absence would make Erigon's open path create them.
	for _, name := range []string{"salt-blocks.txt", "salt-state.txt", dbstate.ERIGONDB_SETTINGS_FILE} {
		if _, err := os.Stat(filepath.Join(dirs.Snap, name)); err != nil {
			return nil, fmt.Errorf("%s: %w (the datadir must belong to a synced node)", filepath.Join(dirs.Snap, name), err)
		}
	}
	if _, err := os.Stat(filepath.Join(dirs.Chaindata, "mdbx.dat")); err != nil {
		return nil, err
	}
	e := &erigonDB{}
	ok := false
	defer func() {
		if !ok {
			e.close()
		}
	}()
	var err error
	e.raw, err = kvmdbx.New(dbcfg.ChainDB, logger).Path(dirs.Chaindata).Accede(true).Readonly(true).Open(ctx)
	if err != nil {
		return nil, fmt.Errorf("open chaindata read-only: %w", err)
	}
	if err := e.raw.View(ctx, func(tx ekv.Tx) error {
		major, minor, _, found, err := rawdb.ReadDBSchemaVersion(tx)
		if err != nil {
			return err
		}
		if found && (major != ekv.DBSchemaVersion.Major || minor != ekv.DBSchemaVersion.Minor) {
			return fmt.Errorf("chaindata schema %d.%d, this build reads %d.%d", major, minor, ekv.DBSchemaVersion.Major, ekv.DBSchemaVersion.Minor)
		}
		genesis, err := rawdb.ReadCanonicalHash(tx, 0)
		if err != nil {
			return err
		}
		e.chain, err = rawdb.ReadChainConfig(tx, genesis)
		return err
	}); err != nil {
		return nil, err
	}
	if e.chain == nil {
		return nil, errors.New("chain config not found in chaindata")
	}
	// Reads the persisted-receipts flag and enables the rcache history, as
	// rpcdaemon does, before the state files are opened.
	syncCfg, err := features.EnableSyncCfg(e.raw, ethconfig.Sync{})
	if err != nil {
		return nil, err
	}
	if !syncCfg.PersistReceiptsCacheV2 {
		return nil, errors.New("the node does not persist receipts (rcache); use --block-source rpc")
	}
	e.snaps = blocksnapshots.NewRoSnapshots(ethconfig.BlocksFreezing{ChainName: e.chain.ChainName}, dirs.Snap, logger)
	e.snaps.DownloadComplete()
	e.reader = freezeblocks.NewBlockReader(e.snaps)
	e.txNums = e.reader.TxnumReader()
	if err := dbstate.CheckSnapshotsCompatibility(dirs); err != nil {
		return nil, err
	}
	settings, err := dbstate.ResolveErigonDBSettings(dirs, logger, false) // reads the existing erigondb.toml
	if err != nil {
		return nil, err
	}
	e.agg, err = dbstate.New(dirs).Logger(logger).WithErigonDBSettings(settings).Open(ctx)
	if err != nil {
		return nil, fmt.Errorf("open state files: %w", err)
	}
	e.db, err = temporal.New(e.raw, e.agg, e.snaps)
	if err != nil {
		return nil, err
	}
	if err := e.snaps.OpenFolder(); err != nil {
		return nil, fmt.Errorf("open block files: %w", err)
	}
	if err := e.db.OpenStateSnapshots(ctx); err != nil {
		return nil, fmt.Errorf("open state files: %w", err)
	}
	ok = true
	return e, nil
}

func (e *erigonDB) close() {
	if e.agg != nil {
		e.agg.Close()
	}
	if e.snaps != nil {
		e.snaps.Close()
	}
	if e.raw != nil {
		e.raw.Close()
	}
}

// errNeedsRPC marks blocks the database cannot serve without execution;
// errNeedsReceipts marks those whose block and senders it serves but not
// their receipts (fetched alone over RPC).
var (
	errNeedsRPC      = errors.New("not servable from the database")
	errNeedsReceipts = fmt.Errorf("%w: receipts", errNeedsRPC)
)

// readBlock reads block n as a sourceBlock within one read transaction. statusReceipts
// accepts pre-Byzantium receipts with a status in place of the post-state root
// (--pre-byzantium-receipts=status); otherwise those blocks' receipts come from RPC.
func (e *erigonDB) readBlock(ctx context.Context, tx ekv.TemporalTx, n uint64, blocks []blockTx, statusReceipts bool) (*sourceBlock, error) {
	hash, ok, err := e.reader.CanonicalHash(ctx, tx, n)
	if err != nil {
		return nil, fmt.Errorf("block %d: canonical hash: %w", n, err)
	}
	if !ok {
		return nil, fmt.Errorf("block %d: no canonical hash", n)
	}
	block, senders, err := e.reader.BlockWithSenders(ctx, tx, hash, n)
	if err != nil {
		return nil, fmt.Errorf("block %d: %w", n, err)
	}
	if block == nil {
		return nil, fmt.Errorf("block %d: not found", n)
	}
	txs := block.Transactions()
	if n < uint64(len(blocks)) {
		// Erigon's own body record: user transactions plus two system transactions.
		if uint64(blocks[n].count) != uint64(len(txs))+2 {
			return nil, fmt.Errorf("block %d: %d transactions, Erigon body records %d", n, len(txs), blocks[n].count-2)
		}
		if base, err := e.txNums.Min(ctx, tx, n); err != nil || base != blocks[n].base {
			return nil, fmt.Errorf("block %d: first txNum %d differs from blocks.bin %d (%v)", n, base, blocks[n].base, err)
		}
	}
	if len(senders) != len(txs) {
		return nil, fmt.Errorf("block %d: %w: %d stored senders for %d transactions", n, errNeedsRPC, len(senders), len(txs))
	}
	raw, err := rlp.EncodeToBytes(block)
	if err != nil {
		return nil, fmt.Errorf("block %d: encode: %w", n, err)
	}
	src := &sourceBlock{number: n, hash: hash[:], raw: raw,
		senders: make([][]byte, len(txs)), receipts: make([]sourceReceipt, len(txs))}
	for i := range senders {
		src.senders[i] = senders[i][:]
	}
	if len(txs) == 0 {
		return src, nil
	}
	needReceipts := func(why string) (*sourceBlock, error) {
		src.receipts = nil
		src.txHashes = make([][]byte, len(txs))
		for i, t := range txs {
			h := t.Hash()
			src.txHashes[i] = h[:]
		}
		return src, fmt.Errorf("block %d: %w: %s", n, errNeedsReceipts, why)
	}
	if !e.chain.IsByzantium(n) && !statusReceipts {
		// Pre-Byzantium receipts carry post-state roots the rcache does not keep; the RPC
		// has none either, so the fallback only helps a node that serves them.
		return needReceipts("pre-Byzantium receipts")
	}
	receipts, err := rawdb.ReadReceiptsCacheV2(tx, block, e.txNums)
	if err != nil {
		return nil, fmt.Errorf("block %d: receipts: %w", n, err)
	}
	if len(receipts) != len(txs) {
		return needReceipts(fmt.Sprintf("%d persisted receipts for %d transactions", len(receipts), len(txs)))
	}
	for i, r := range receipts {
		if r.TransactionIndex != uint(i) {
			return nil, fmt.Errorf("block %d: receipt %d has transaction index %d", n, i, r.TransactionIndex)
		}
		rec := &src.receipts[i]
		rec.txType = uint64(r.Type)
		switch {
		case len(r.PostState) > 0:
			rec.outcome = r.PostState
		case r.Status == types.ReceiptStatusSuccessful:
			rec.outcome = []byte{1}
		case r.Status != types.ReceiptStatusFailed:
			return nil, fmt.Errorf("block %d: receipt %d status %d", n, i, r.Status)
		}
		rec.cumulative, rec.gasUsed = r.CumulativeGasUsed, r.GasUsed
		rec.logs = make([]sourceLog, len(r.Logs))
		for j, l := range r.Logs {
			sl := &rec.logs[j]
			sl.address = common.Copy(l.Address[:])
			sl.data = l.Data
			for _, t := range l.Topics {
				sl.topics = append(sl.topics, common.Copy(t[:]))
			}
		}
	}
	header := block.HeaderNoCopy()
	if header.ExcessBlobGas != nil {
		for _, t := range txs {
			if t.Type() == types.BlobTxType {
				// Erigon's own blob base fee, as eth_getBlockReceipts reports it.
				price, err := misc.GetBlobGasPrice(e.chain, *header.ExcessBlobGas, header.Time)
				if err != nil {
					return nil, fmt.Errorf("block %d: blob gas price: %w", n, err)
				}
				src.blockBlobGasPrice = price.ToBig()
				break
			}
		}
	}
	return src, nil
}

// dbBlockSource builds records from the database, one short read
// transaction per batch of consecutive blocks.
type dbBlockSource struct {
	db       *erigonDB
	blocks   []blockTx
	blobs    recordRules
	rpc      *rpcClient // per-block fallback
	opts     blockSourceOptions
	fallback func(n uint64, reason error)
}

// fetchReceipts fills the receipts of blocks the database served without
// them, from eth_getBlockReceipts: opts.rpcBatch blocks per JSON-RPC batch,
// opts.rpcParallel batches at once. Each receipt must name its block and
// transaction.
func (s *dbBlockSource) fetchReceipts(srcs []*sourceBlock) error {
	var groups [][]*sourceBlock
	for i := 0; i < len(srcs); i += s.opts.rpcBatch {
		groups = append(groups, srcs[i:min(i+s.opts.rpcBatch, len(srcs))])
	}
	return parallelEach(groups, s.opts.rpcParallel, func(group []*sourceBlock) error {
		calls := make([]rpcCall, len(group))
		for i, src := range group {
			calls[i] = rpcCall{"eth_getBlockReceipts", []any{fmt.Sprintf("0x%x", src.number)}}
		}
		results, err := s.rpc.batch(calls)
		if err != nil {
			return err
		}
		for i, src := range group {
			var rs []map[string]json.RawMessage
			if err := json.Unmarshal(results[i], &rs); err != nil {
				return fmt.Errorf("block %d receipts: %w", src.number, err)
			}
			if len(rs) != len(src.txHashes) {
				return fmt.Errorf("block %d: %d receipts for %d transactions", src.number, len(rs), len(src.txHashes))
			}
			src.receipts = make([]sourceReceipt, len(rs))
			for j, r := range rs {
				var txHash, blockHash, index string
				json.Unmarshal(r["transactionHash"], &txHash)
				json.Unmarshal(r["blockHash"], &blockHash)
				json.Unmarshal(r["transactionIndex"], &index)
				idx, _ := parseQuantity(index)
				if !strings.EqualFold(txHash, fmt.Sprintf("0x%x", src.txHashes[j])) ||
					!strings.EqualFold(blockHash, fmt.Sprintf("0x%x", src.hash)) || idx != uint64(j) {
					return fmt.Errorf("block %d: receipt %d does not match its transaction", src.number, j)
				}
				if src.receipts[j], err = receiptFromJSON(j, r); err != nil {
					return fmt.Errorf("block %d: %w", src.number, err)
				}
			}
		}
		return nil
	})
}

func (s *dbBlockSource) fetchRange(ctx context.Context, first, last uint64) ([]*fetchedBlock, error) {
	out := make([]*fetchedBlock, 0, last-first+1)
	var needRPC []uint64
	var needReceipts []*sourceBlock
	err := func() error {
		tx, err := s.db.db.BeginTemporalRo(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		for n := first; n <= last; n++ {
			src, err := s.db.readBlock(ctx, tx, n, s.blocks, s.blobs.statusBeforeByzantium)
			if errors.Is(err, errNeedsReceipts) && src != nil {
				s.fallback(n, err)
				needReceipts = append(needReceipts, src)
				out = append(out, nil)
				continue
			}
			if errors.Is(err, errNeedsRPC) {
				s.fallback(n, err)
				needRPC = append(needRPC, n)
				out = append(out, nil)
				continue
			}
			if err != nil {
				return err
			}
			plain, info, err := buildBlockRecord(src, s.blobs)
			if err != nil {
				return err
			}
			out = append(out, &fetchedBlock{blockInfo: info, record: compressFrame(plain)})
		}
		return nil
	}()
	if err != nil {
		return nil, err
	}
	// RPC fallbacks run after the read transaction is closed.
	if len(needReceipts) > 0 {
		if err := s.fetchReceipts(needReceipts); err != nil {
			return nil, err
		}
		for _, src := range needReceipts {
			plain, info, err := buildBlockRecord(src, s.blobs)
			if err != nil {
				return nil, err
			}
			out[src.number-first] = &fetchedBlock{blockInfo: info, record: compressFrame(plain)}
		}
	}
	for _, n := range needRPC {
		f, err := fetchBlock(s.rpc, s.blocks, n, s.blobs)
		if err != nil {
			return nil, err
		}
		out[n-first] = f
	}
	return out, nil
}

func newDBBlockSource(ctx context.Context, opts blockSourceOptions, rpc *rpcClient, blocks []blockTx, blobs recordRules) (blockSource, func(), error) {
	db, release, err := sharedErigonDB(ctx, opts.datadir)
	if err != nil {
		return nil, nil, err
	}
	var fallbacks atomic.Uint64
	src := &dbBlockSource{db: db, blocks: blocks, blobs: blobs, rpc: rpc, opts: opts,
		// Logged for the first blocks, then every 100,000th (mainnet has
		// millions of pre-Byzantium blocks).
		fallback: func(n uint64, reason error) {
			if c := fallbacks.Add(1); c <= 20 || c%100000 == 0 {
				fmt.Fprintf(os.Stderr, "{\"rpc_fallback\":%d,\"count\":%d,\"reason\":%q}\n", n, c, reason.Error())
			}
		}}
	return src, release, nil
}
