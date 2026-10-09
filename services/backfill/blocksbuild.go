package main

// Segments of block records (docs/storage.md, "Block bundles"),
// built from the node's JSON-RPC, which serves blocks, receipts and raw blocks
// from the same frozen block files and persisted receipts.

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

type rpcClient struct {
	url  string
	http *http.Client
}

func newRPCClient(url string, conns int) *rpcClient {
	return &rpcClient{url: url, http: &http.Client{
		Timeout:   2 * time.Minute,
		Transport: &http.Transport{MaxIdleConnsPerHost: conns, MaxConnsPerHost: conns},
	}}
}

// call returns the raw JSON `result`, retrying transient failures.
func (c *rpcClient) call(method string, params ...any) (json.RawMessage, error) {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	var lastErr error
	for attempt := range 5 {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt*attempt) * 200 * time.Millisecond)
		}
		resp, err := c.http.Post(c.url, "application/json", bytes.NewReader(body))
		if err != nil {
			lastErr = err
			continue
		}
		data, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			lastErr = err
			continue
		}
		var out struct {
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(data, &out); err != nil {
			lastErr = fmt.Errorf("%s: invalid response: %w", method, err)
			continue
		}
		if out.Error != nil {
			return nil, fmt.Errorf("%s: %d %s", method, out.Error.Code, out.Error.Message)
		}
		if len(out.Result) == 0 || string(out.Result) == "null" {
			return nil, fmt.Errorf("%s%v: empty result", method, params)
		}
		return out.Result, nil
	}
	return nil, lastErr
}

type rpcCall struct {
	method string
	params []any
}

// batch sends calls as one JSON-RPC batch request and returns each result in
// order, retrying transient failures like call. Any error or empty result in
// the batch fails it.
func (c *rpcClient) batch(calls []rpcCall) ([]json.RawMessage, error) {
	if len(calls) == 1 {
		r, err := c.call(calls[0].method, calls[0].params...)
		return []json.RawMessage{r}, err
	}
	reqs := make([]map[string]any, len(calls))
	for i, call := range calls {
		reqs[i] = map[string]any{"jsonrpc": "2.0", "id": i, "method": call.method, "params": call.params}
	}
	body, _ := json.Marshal(reqs)
	var lastErr error
	for attempt := range 5 {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt*attempt) * 200 * time.Millisecond)
		}
		resp, err := c.http.Post(c.url, "application/json", bytes.NewReader(body))
		if err != nil {
			lastErr = err
			continue
		}
		data, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			lastErr = err
			continue
		}
		var outs []struct {
			ID     *int            `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(data, &outs); err != nil {
			lastErr = fmt.Errorf("batch of %d %s: invalid response: %.200s", len(calls), calls[0].method, data)
			continue
		}
		results := make([]json.RawMessage, len(calls))
		for _, o := range outs {
			if o.ID == nil || *o.ID < 0 || *o.ID >= len(calls) || results[*o.ID] != nil {
				return nil, errors.New("batch response ids do not match the request")
			}
			call := calls[*o.ID]
			if o.Error != nil {
				return nil, fmt.Errorf("%s%v: %d %s", call.method, call.params, o.Error.Code, o.Error.Message)
			}
			if len(o.Result) == 0 || string(o.Result) == "null" {
				return nil, fmt.Errorf("%s%v: empty result", call.method, call.params)
			}
			results[*o.ID] = o.Result
		}
		for i, r := range results {
			if r == nil {
				return nil, fmt.Errorf("batch response lacks %s%v", calls[i].method, calls[i].params)
			}
		}
		return results, nil
	}
	return nil, lastErr
}

type rpcBlockHead struct {
	Number       string `json:"number"`
	Hash         string `json:"hash"`
	ParentHash   string `json:"parentHash"`
	StateRoot    string `json:"stateRoot"`
	Transactions []struct {
		Hash string `json:"hash"`
	} `json:"transactions"`
}

const offsetRecordLen = 80

type fetchedBlock struct {
	blockInfo
	record frame // zstd frame of the binary block record
}

func parseQuantity(s string) (uint64, error) {
	if !strings.HasPrefix(s, "0x") || len(s) < 3 {
		return 0, fmt.Errorf("invalid quantity %q", s)
	}
	return strconv.ParseUint(s[2:], 16, 64)
}

func fetchBlock(rpc *rpcClient, blocks []blockTx, n uint64, blobs recordRules) (*fetchedBlock, error) {
	tag := fmt.Sprintf("0x%x", n)
	block, err := rpc.call("eth_getBlockByNumber", tag, true)
	if err != nil {
		return nil, err
	}
	receipts, err := rpc.call("eth_getBlockReceipts", tag)
	if err != nil {
		return nil, err
	}
	raw, err := rpc.call("debug_getRawBlock", tag)
	if err != nil {
		return nil, err
	}
	var head rpcBlockHead
	if err := json.Unmarshal(block, &head); err != nil {
		return nil, fmt.Errorf("block %d: %w", n, err)
	}
	if got, err := parseQuantity(head.Number); err != nil || got != n {
		return nil, fmt.Errorf("block %d: RPC returned number %s", n, head.Number)
	}
	var rs []struct {
		TransactionHash  string `json:"transactionHash"`
		TransactionIndex string `json:"transactionIndex"`
		BlockHash        string `json:"blockHash"`
	}
	if err := json.Unmarshal(receipts, &rs); err != nil {
		return nil, fmt.Errorf("block %d receipts: %w", n, err)
	}
	if len(rs) != len(head.Transactions) {
		return nil, fmt.Errorf("block %d: %d receipts for %d transactions", n, len(rs), len(head.Transactions))
	}
	for i, tx := range head.Transactions {
		idx, _ := parseQuantity(rs[i].TransactionIndex)
		if !strings.EqualFold(rs[i].TransactionHash, tx.Hash) || !strings.EqualFold(rs[i].BlockHash, head.Hash) || idx != uint64(i) {
			return nil, fmt.Errorf("block %d: receipt %d does not match its transaction", n, i)
		}
	}
	// Erigon's own body record: user transactions plus two system transactions.
	if n < uint64(len(blocks)) && uint64(blocks[n].count) != uint64(len(head.Transactions))+2 {
		return nil, fmt.Errorf("block %d: %d transactions, Erigon body records %d", n, len(head.Transactions), blocks[n].count-2)
	}
	var rawHex string
	if err := json.Unmarshal(raw, &rawHex); err != nil || !strings.HasPrefix(rawHex, "0x") || len(rawHex) < 4 {
		return nil, fmt.Errorf("block %d: invalid raw block", n)
	}
	plain, info, err := encodeBlockRecord(block, receipts, rawHex, blobs)
	if err != nil {
		return nil, err
	}
	f := &fetchedBlock{blockInfo: info, record: compressFrame(plain)}
	return f, nil
}

// blockSource produces checked records for consecutive blocks.
type blockSource interface {
	fetchRange(ctx context.Context, first, last uint64) ([]*fetchedBlock, error)
}

type rpcBlockSource struct {
	rpc    *rpcClient
	blocks []blockTx
	blobs  recordRules
}

func (s *rpcBlockSource) fetchRange(_ context.Context, first, last uint64) ([]*fetchedBlock, error) {
	out := make([]*fetchedBlock, 0, last-first+1)
	for n := first; n <= last; n++ {
		f, err := fetchBlock(s.rpc, s.blocks, n, s.blobs)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, nil
}

// blockSourceOptions selects and sizes the block source of the bundle stage.
type blockSourceOptions struct {
	kind       string // "db" or "rpc"
	datadir    string // Erigon datadir, for "db"
	rpcWorkers int    // parallel RPC blocks
	dbWorkers  int    // parallel database batches
	// Receipts the database cannot serve (pre-Byzantium) are fetched over
	// RPC: rpcBatch receipts per JSON-RPC batch request, rpcParallel batch
	// requests at once per database worker.
	rpcBatch, rpcParallel int
}

// openBlockSource returns the source, its worker count and batch size, and a
// close function.
func openBlockSource(opts blockSourceOptions, rpc *rpcClient, blocks []blockTx, blobs recordRules) (blockSource, int, int, func(), error) {
	switch opts.kind {
	case "rpc":
		return &rpcBlockSource{rpc, blocks, blobs}, opts.rpcWorkers, 1, func() {}, nil
	case "db":
		src, closeDB, err := newDBBlockSource(context.Background(), opts, rpc, blocks, blobs)
		if err != nil {
			return nil, 0, 0, nil, fmt.Errorf("block source db: %w", err)
		}
		return src, opts.dbWorkers, dbBatchBlocks, closeDB, nil
	}
	return nil, 0, 0, nil, fmt.Errorf("unknown block source %q (db or rpc)", opts.kind)
}

// dbBatchBlocks is the number of consecutive blocks read in one database
// read transaction: short enough for Erigon to reclaim pages promptly.
const dbBatchBlocks = 64

type blockSourceFlagValues struct {
	kind                             *string
	dbWorkers, rpcBatch, rpcParallel *int
}

func blockSourceFlags(fs *flag.FlagSet) blockSourceFlagValues {
	return blockSourceFlagValues{
		kind:        fs.String("block-source", defaultBlockSource, "where block records come from: db (Erigon's datadir, read-only) or rpc"),
		dbWorkers:   fs.Int("db-workers", runtime.NumCPU(), "parallel database readers (--block-source db)"),
		rpcBatch:    fs.Int("rpc-batch", 16, "receipts per JSON-RPC batch for blocks the database cannot serve (pre-Byzantium)"),
		rpcParallel: fs.Int("rpc-parallel", 2, "JSON-RPC receipt batches in flight per database reader"),
	}
}

func (v blockSourceFlagValues) options(datadir string, rpcWorkers int) blockSourceOptions {
	return blockSourceOptions{kind: *v.kind, datadir: datadir, rpcWorkers: rpcWorkers, dbWorkers: *v.dbWorkers,
		rpcBatch: max(1, *v.rpcBatch), rpcParallel: max(1, *v.rpcParallel)}
}

type chunkSlot struct {
	id, first, last uint64
	blocks          []*fetchedBlock
	pending         sync.WaitGroup
	mu              sync.Mutex
	err             error
}

// buildBundles writes the bundles from the end of done (or from, when done is
// empty) through to, in chunk order. With a stream target, each finished
// chunk is uploaded and its local data files removed while later chunks are
// built (bundles.json marks it uploaded).
func buildBundles(rpc *rpcClient, opts blockSourceOptions, blocks []blockTx, archive localArchive, namespace string,
	from, to, chunkBlocks uint64, done []BundleRef, outPath string, blobs recordRules, stream *streamTarget) (err error) {
	log := &bundleLog{path: outPath, refs: done}
	if stream != nil {
		if err := streamPendingChunks(stream, archive, log); err != nil {
			return err
		}
	}
	next := from
	if len(done) > 0 {
		next = done[len(done)-1].LastBlock + 1
	}
	if next > to {
		fmt.Fprintf(os.Stderr, "bundles already cover blocks %d-%d\n", from, next-1)
		return nil
	}
	// Only finalized blocks: read by number at or below the finalized block,
	// so every record is canonical and final when read.
	finalized, err := rpcAnchor(rpc, "finalized")
	if err != nil {
		return fmt.Errorf("read finalized block: %w", err)
	}
	if to > finalized.Number {
		return fmt.Errorf("block %d is not finalized (finalized=%d)", to, finalized.Number)
	}
	src, workers, batch, closeSource, err := openBlockSource(opts, rpc, blocks, blobs)
	if err != nil {
		return err
	}
	defer closeSource()
	var streamer *chunkStreamer
	if stream != nil {
		streamer = newChunkStreamer(stream, archive, log)
		defer func() {
			st, serr := streamer.finish()
			if err == nil {
				err = serr
			}
			if serr == nil {
				fmt.Fprintln(os.Stderr, describeStreamStats("chunks", st))
			}
		}()
	}
	fmt.Fprintf(os.Stderr, "{\"block_source\":%q,\"workers\":%d,\"batch\":%d,\"from\":%d,\"to\":%d}\n", opts.kind, workers, batch, next, to)
	started, startBlock := time.Now(), next
	slots := make(chan *chunkSlot, 4) // chunks fetched ahead of the writer
	work := make(chan func(), workers*4)
	for range workers {
		go func() {
			for job := range work {
				job()
			}
		}()
	}
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		defer close(work)
		defer close(slots)
		for first := next; first <= to; {
			last := min((first/chunkBlocks+1)*chunkBlocks-1, to)
			slot := &chunkSlot{id: first / chunkBlocks, first: first, last: last,
				blocks: make([]*fetchedBlock, last-first+1)}
			jobs := (int(last-first) + batch) / batch
			slot.pending.Add(jobs)
			select {
			case slots <- slot:
			case <-stop:
				return
			}
			for b := first; b <= last; b += uint64(batch) {
				e := min(b+uint64(batch)-1, last)
				job := func() {
					defer slot.pending.Done()
					fs, err := src.fetchRange(context.Background(), b, e)
					if err != nil {
						slot.mu.Lock()
						if slot.err == nil {
							slot.err = err
						}
						slot.mu.Unlock()
						return
					}
					copy(slot.blocks[b-slot.first:], fs)
				}
				select {
				case work <- job:
				case <-stop:
					return
				}
			}
			first = last + 1
		}
	}()
	prevHash := ""
	if len(done) > 0 {
		prevHash = done[len(done)-1].LastBlockHash
	}
	repaired, statusReceipts := 0, 0
	for slot := range slots {
		slot.pending.Wait()
		if slot.err != nil {
			return slot.err
		}
		for _, b := range slot.blocks {
			if b.repairedReceipts {
				repaired++
			}
			if b.statusReceipts {
				statusReceipts++
			}
		}
		ref, err := writeBundle(archive, namespace, slot, prevHash)
		if err != nil {
			return fmt.Errorf("chunk %d: %w", slot.id, err)
		}
		prevHash = ref.LastBlockHash
		if err := log.add(ref); err != nil {
			return err
		}
		if streamer != nil {
			if err := streamer.send(ref); err != nil {
				return err
			}
		}
		rate := float64(ref.LastBlock+1-startBlock) / time.Since(started).Seconds()
		fmt.Fprintf(os.Stderr, "{\"chunk\":%d,\"first\":%d,\"last\":%d,\"blocks_per_s\":%.0f,\"eta_s\":%.0f,\"repaired_receipts\":%d,\"status_receipt_blocks\":%d}\n",
			slot.id, ref.FirstBlock, ref.LastBlock, rate, float64(to-ref.LastBlock)/rate, repaired, statusReceipts)
		slot.blocks = nil
	}
	return nil
}

func writeBundle(archive localArchive, namespace string, slot *chunkSlot, prevHash string) (BundleRef, error) {
	return writeBundleAs(archive, namespace, slot, prevHash)
}

// hashSpillDir holds each chunk's hash index entries (hashes.go), next to the archive tree.
func hashSpillDir(archive localArchive) string {
	return filepath.Join(filepath.Dir(archive.root), "hashes")
}

// writeBundleAs writes a segment (`segments/{first}-{last}-{last hash}/{content-id}/`:
// meta.json, blocks.pack, offsets.bin) and spills its hash index entries.
func writeBundleAs(archive localArchive, namespace string, slot *chunkSlot, prevHash string) (BundleRef, error) {
	first, last := slot.blocks[0], slot.blocks[len(slot.blocks)-1]
	if prevHash != "" && first.parent != prevHash {
		return BundleRef{}, fmt.Errorf("block %d parent %s does not follow %s", first.number, first.parent, prevHash)
	}
	tmp := archive.path(fmt.Sprintf("%s/.tmp/chunk-%d", namespace, slot.id))
	if err := os.RemoveAll(tmp); err != nil {
		return BundleRef{}, err
	}
	pack, err := newPackWriter(filepath.Join(tmp, "blocks.pack"), codecBlocks)
	if err != nil {
		return BundleRef{}, err
	}
	offsets := make([]byte, 0, len(slot.blocks)*offsetRecordLen)
	spill := newHashSpill()
	for i, b := range slot.blocks {
		if i > 0 && b.parent != slot.blocks[i-1].hash {
			return BundleRef{}, fmt.Errorf("discontinuous block sequence at %d", b.number)
		}
		if b.number != first.number+uint64(i) {
			return BundleRef{}, fmt.Errorf("block %d out of order", b.number)
		}
		r, err := pack.push(b.number, b.record)
		if err != nil {
			return BundleRef{}, err
		}
		rec, err := offsetRecord(b.hash, r)
		if err != nil {
			return BundleRef{}, fmt.Errorf("block %d: %w", b.number, err)
		}
		offsets = append(offsets, rec...)
		if err := spill.block(b.hash, b.number); err != nil {
			return BundleRef{}, err
		}
		for idx, h := range b.txHashes {
			if err := spill.tx(h, b.number, uint64(idx)); err != nil {
				return BundleRef{}, err
			}
		}
	}
	type payload struct {
		path string
		size uint64
		sum  string
	}
	payloads := map[string]payload{}
	size, sum, err := pack.close()
	if err != nil {
		return BundleRef{}, err
	}
	payloads["blocks.pack"] = payload{pack.path, size, sum}
	offsetsPath := filepath.Join(tmp, "offsets.bin")
	if err := os.WriteFile(offsetsPath, offsets, 0o644); err != nil {
		return BundleRef{}, err
	}
	payloads["offsets.bin"] = payload{offsetsPath, uint64(len(offsets)), sha256Hex(offsets)}
	// content-id = SHA-256 of the sorted name -> digest map.
	fingerprints := map[string]string{}
	for name, p := range payloads {
		fingerprints[name] = p.sum
	}
	fpJSON, _ := json.Marshal(fingerprints)
	base := fmt.Sprintf("%s/segments/%020d-%020d-%s/%s", namespace, first.number, last.number,
		strings.TrimPrefix(last.hash, "0x"), sha256Hex(fpJSON))
	files := map[string]ObjectRef{}
	for name, p := range payloads {
		ref, err := archive.adoptFile(base+"/"+name, p.path, p.size, p.sum)
		if err != nil {
			return BundleRef{}, err
		}
		files[name] = ref
	}
	os.RemoveAll(tmp)
	if err := spill.write(hashSpillDir(archive), slot.id); err != nil {
		return BundleRef{}, err
	}
	meta := BundleMetadata{First: first.number, Last: last.number,
		FirstParentHash: first.parent, LastHash: last.hash, Files: files}
	metaRef, err := archive.putJSON(base+"/meta.json", meta)
	if err != nil {
		return BundleRef{}, err
	}
	return BundleRef{FirstBlock: first.number, LastBlock: last.number, FirstParentHash: first.parent,
		LastBlockHash: last.hash, ChunkID: slot.id, Metadata: metaRef}, nil
}

// offsetRecord is one 80-byte offsets.bin record: block hash, frame offset
// (u64 LE), frame length (u32 LE), uncompressed length (u32 LE), frame SHA-256.
func offsetRecord(blockHash string, r RecordOffset) ([]byte, error) {
	hash, err := decodeData(blockHash, 32)
	if err != nil {
		return nil, err
	}
	sum, err := hex.DecodeString(r.Sha256)
	if err != nil || len(sum) != 32 {
		return nil, errors.New("invalid frame digest")
	}
	if r.Length > math.MaxUint32 || r.UncompressedLength > math.MaxUint32 {
		return nil, errors.New("block record exceeds 4 GiB")
	}
	out := make([]byte, offsetRecordLen)
	copy(out, hash)
	binary.LittleEndian.PutUint64(out[32:], r.Offset)
	binary.LittleEndian.PutUint32(out[40:], uint32(r.Length))
	binary.LittleEndian.PutUint32(out[44:], uint32(r.UncompressedLength))
	copy(out[48:], sum)
	return out, nil
}
