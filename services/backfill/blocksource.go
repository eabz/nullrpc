package main

// Source-independent block records. A block source (JSON-RPC, or Erigon's
// database read directly) produces a sourceBlock: the raw block plus what the
// source claims about it (senders, receipts, and optionally hashes, types and
// header values). buildBlockRecord checks every claim against the raw block and
// its header, and encodes the binary record (docs/storage.md, "Block
// records"). Both sources share every check, so for the same block they
// produce the same bytes.

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"os"
)

type sourceLog struct {
	address []byte   // 20 bytes
	topics  [][]byte // 32 bytes each, at most 4
	data    []byte
}

type sourceReceipt struct {
	txType     uint64
	outcome    []byte // empty (failed), 0x01 (success) or a 32-byte post-state root
	cumulative uint64 // the source's cumulative gas used
	gasUsed    uint64 // the source's gas used by this transaction
	logs       []sourceLog
	// blobGasPrice is the receipt's blob gas price when the source states one
	// per receipt (RPC); nil when absent.
	blobGasPrice []byte
}

// headerClaims are header values a source states separately from the raw
// block (RPC JSON). Each must equal the raw header's value.
type headerClaims struct {
	parentHash, stateRoot, receiptsRoot []byte
	gasUsed, timestamp                  uint64
	excessBlobGas                       *uint64
}

type sourceBlock struct {
	number uint64
	hash   []byte // the source's canonical hash for number
	raw    []byte // RLP [header, txs, ommers, withdrawals?], as debug_getRawBlock
	// Optional per-transaction claims, checked against the raw transactions.
	txHashes [][]byte
	txTypes  []uint64
	senders  [][]byte // 20 bytes each, required
	receipts []sourceReceipt
	header   *headerClaims
	// blockBlobGasPrice is the source's blob base fee for the block (DB:
	// Erigon's own computation), nil when not stated. Checked when present.
	blockBlobGasPrice *big.Int
}

// rawHeader holds the header fields the record checks use.
type rawHeader struct {
	parentHash, ommersHash, stateRoot, txRoot, receiptsRoot, withdrawalsRoot []byte
	logsBloom                                                                []byte
	number, gasUsed, timestamp                                               uint64
	excessBlobGas                                                            *uint64
}

func rlpUint64(item []byte) (uint64, error) {
	payload, list, _, rest, err := rlpItem(item)
	if err != nil || list || len(rest) != 0 || len(payload) > 8 {
		return 0, errors.New("expected an RLP integer of at most 8 bytes")
	}
	var v uint64
	for _, c := range payload {
		v = v<<8 | uint64(c)
	}
	return v, nil
}

func rlpHash(item []byte) ([]byte, error) {
	payload, list, _, _, err := rlpItem(item)
	if err != nil || list || len(payload) != 32 {
		return nil, errors.New("expected a 32-byte RLP string")
	}
	return payload, nil
}

func parseRawHeader(header []byte) (*rawHeader, error) {
	f, err := rlpListItems(header)
	if err != nil || len(f) < 15 {
		return nil, errors.New("header is not an RLP list of at least 15 fields")
	}
	h := &rawHeader{}
	for _, x := range []struct {
		i   int
		dst *[]byte
	}{{0, &h.parentHash}, {1, &h.ommersHash}, {3, &h.stateRoot}, {4, &h.txRoot}, {5, &h.receiptsRoot}} {
		if *x.dst, err = rlpHash(f[x.i]); err != nil {
			return nil, fmt.Errorf("header field %d: %w", x.i, err)
		}
	}
	if payload, list, _, _, err := rlpItem(f[6]); err != nil || list || len(payload) != 256 {
		return nil, errors.New("header logs bloom must be 256 bytes")
	} else {
		h.logsBloom = payload
	}
	for _, x := range []struct {
		i   int
		dst *uint64
	}{{8, &h.number}, {10, &h.gasUsed}, {11, &h.timestamp}} {
		if *x.dst, err = rlpUint64(f[x.i]); err != nil {
			return nil, fmt.Errorf("header field %d: %w", x.i, err)
		}
	}
	if len(f) > 16 {
		if h.withdrawalsRoot, err = rlpHash(f[16]); err != nil {
			return nil, fmt.Errorf("header withdrawals root: %w", err)
		}
	}
	if len(f) > 18 {
		v, err := rlpUint64(f[18])
		if err != nil {
			return nil, fmt.Errorf("header excess blob gas: %w", err)
		}
		h.excessBlobGas = &v
	}
	return h, nil
}

// buildBlockRecord checks a source's block against its raw block and header
// and returns the plain (uncompressed) record: transaction hashes and types,
// the transactions, ommers and withdrawals roots, senders (recovered from the
// signatures), the receipts root and the blob base fee (from the block's
// excess blob gas and the chain's blob schedule).
func buildBlockRecord(src *sourceBlock, blobs recordRules) ([]byte, blockInfo, error) {
	info := blockInfo{number: src.number, hash: "0x" + hex.EncodeToString(src.hash)}
	fail := func(format string, a ...any) ([]byte, blockInfo, error) {
		return nil, info, fmt.Errorf("block %d: %s", info.number, fmt.Sprintf(format, a...))
	}
	fields, err := rlpListItems(src.raw)
	if err != nil || len(fields) < 3 || len(fields) > 4 {
		return fail("raw block is not an RLP block")
	}
	if got := keccakHex(fields[0]); got != info.hash {
		return fail("raw block header hash %s differs from %s", got, info.hash)
	}
	h, err := parseRawHeader(fields[0])
	if err != nil {
		return fail("%v", err)
	}
	if h.number != src.number {
		return fail("raw header number is %d", h.number)
	}
	info.parent = "0x" + hex.EncodeToString(h.parentHash)
	info.root = "0x" + hex.EncodeToString(h.stateRoot)
	if c := src.header; c != nil {
		switch {
		case !bytes.Equal(c.parentHash, h.parentHash):
			return fail("parentHash differs from the raw header")
		case !bytes.Equal(c.stateRoot, h.stateRoot):
			return fail("stateRoot differs from the raw header")
		case !bytes.Equal(c.receiptsRoot, h.receiptsRoot):
			return fail("receiptsRoot differs from the raw header")
		case c.gasUsed != h.gasUsed:
			return fail("gasUsed differs from the raw header")
		case c.timestamp != h.timestamp:
			return fail("timestamp differs from the raw header")
		case (c.excessBlobGas == nil) != (h.excessBlobGas == nil) ||
			(c.excessBlobGas != nil && *c.excessBlobGas != *h.excessBlobGas):
			return fail("excessBlobGas differs from the raw header")
		}
	}
	rawTxs, err := rlpListItems(fields[1])
	if err != nil {
		return fail("raw transactions: %v", err)
	}
	n := len(rawTxs)
	switch {
	case len(src.senders) != n:
		return fail("%d senders for %d transactions", len(src.senders), n)
	case len(src.receipts) != n:
		return fail("%d receipts for %d transactions", len(src.receipts), n)
	case src.txHashes != nil && len(src.txHashes) != n:
		return fail("raw block has %d transactions, the source %d", n, len(src.txHashes))
	case src.txTypes != nil && len(src.txTypes) != n:
		return fail("%d transaction types for %d transactions", len(src.txTypes), n)
	}
	// The body must be the header's: transactions, ommers and withdrawals roots.
	txEnc := make([][]byte, n)
	for i, item := range rawTxs {
		payload, list, full, _, _ := rlpItem(item)
		if list {
			txEnc[i] = full
		} else {
			txEnc[i] = payload
		}
	}
	if root := orderedTrieRoot(txEnc); !bytes.Equal(root[:], h.txRoot) {
		return fail("transactions root 0x%x differs from the header's 0x%x", root, h.txRoot)
	}
	k := newKeccak()
	if got := k.sum(fields[2]); !bytes.Equal(got[:], h.ommersHash) {
		return fail("ommers hash 0x%x differs from the header's 0x%x", got, h.ommersHash)
	}
	if (len(fields) == 4) != (h.withdrawalsRoot != nil) {
		return fail("withdrawals and the header's withdrawals root must both be present or absent")
	}
	if len(fields) == 4 {
		ws, err := rlpListItems(fields[3])
		if err != nil {
			return fail("raw withdrawals: %v", err)
		}
		if root := orderedTrieRoot(ws); !bytes.Equal(root[:], h.withdrawalsRoot) {
			return fail("withdrawals root 0x%x differs from the header's 0x%x", root, h.withdrawalsRoot)
		}
	}

	senders := make([]byte, 0, 20*n)
	parts := make([]receiptParts, n)
	// The source's cumulative gas, and the running sum of per-transaction gas.
	var cumulative, summed uint64
	consistent := true
	var blobPrice []byte
	blobTxs := 0
	info.txHashes = make([]string, n)
	for i := range rawTxs {
		hash := k.sum(txEnc[i])
		if src.txHashes != nil && !bytes.Equal(src.txHashes[i], hash[:]) {
			return fail("transaction %d hash 0x%x differs from the raw block's 0x%x", i, src.txHashes[i], hash)
		}
		info.txHashes[i] = "0x" + hex.EncodeToString(hash[:])
		var txType uint64
		if txEnc[i][0] < 0x80 {
			txType = uint64(txEnc[i][0])
		}
		if src.txTypes != nil && src.txTypes[i] != txType {
			return fail("transaction %d type 0x%x differs from the raw transaction's 0x%x", i, src.txTypes[i], txType)
		}
		from := src.senders[i]
		if len(from) != 20 {
			return fail("transaction %d sender is not 20 bytes", i)
		}
		recovered, err := recoverSender(k, rawTxs[i])
		if err != nil {
			return fail("transaction %d: %v", i, err)
		}
		if !bytes.Equal(recovered, from) {
			return fail("transaction %d sender 0x%x differs from the recovered 0x%x", i, from, recovered)
		}
		senders = append(senders, from...)

		r := &src.receipts[i]
		rec := &parts[i]
		if r.txType != txType {
			return fail("receipt %d type 0x%x differs from its transaction's 0x%x", i, r.txType, txType)
		}
		rec.txType = r.txType
		switch {
		case len(r.outcome) == 0, len(r.outcome) == 1 && r.outcome[0] == 1, len(r.outcome) == 32:
			rec.outcome = r.outcome
		default:
			return fail("receipt %d outcome 0x%x is neither a status nor a root", i, r.outcome)
		}
		consistent = consistent && r.cumulative == cumulative+r.gasUsed
		cumulative, summed = r.cumulative, summed+r.gasUsed
		rec.cumulative = r.cumulative
		var logsPayload []byte
		for j, l := range r.logs {
			if len(l.address) != 20 || len(l.topics) > 4 {
				return fail("receipt %d log %d is invalid", i, j)
			}
			var topicsPayload []byte
			rec.bloomItems = append(rec.bloomItems, l.address)
			for _, t := range l.topics {
				if len(t) != 32 {
					return fail("receipt %d log %d topic is not 32 bytes", i, j)
				}
				topicsPayload = rlpAppendString(topicsPayload, t)
				rec.bloomItems = append(rec.bloomItems, t)
			}
			lp := rlpAppendString(nil, l.address)
			lp = append(lp, rlpList(topicsPayload)...)
			lp = rlpAppendString(lp, l.data)
			logsPayload = append(logsPayload, rlpList(lp)...)
		}
		rec.logs = rlpList(logsPayload)
		if txType == 3 {
			blobTxs++
			if src.blockBlobGasPrice == nil {
				// Per-receipt prices: each must be stated, and all must agree.
				if r.blobGasPrice == nil {
					return fail("blob receipt %d has no blobGasPrice", i)
				}
				if blobPrice != nil && !bytes.Equal(blobPrice, r.blobGasPrice) {
					return fail("receipts disagree on the blob gas price")
				}
				blobPrice = r.blobGasPrice
			}
		} else if r.blobGasPrice != nil {
			return fail("receipt %d of type 0x%x has a blob gas price", i, txType)
		}
	}
	if blobTxs > 0 {
		if h.excessBlobGas == nil {
			return fail("blob transactions without excessBlobGas")
		}
		want, err := blobs.price(h.timestamp, *h.excessBlobGas)
		if err != nil {
			return fail("blob base fee: %v", err)
		}
		if src.blockBlobGasPrice != nil {
			blobPrice = src.blockBlobGasPrice.Bytes()
		}
		if got := new(big.Int).SetBytes(blobPrice); got.Cmp(want) != 0 {
			return fail("blob gas price %s differs from the computed %s", got, want)
		}
	}
	// Pre-Byzantium receipts from a source without post-state roots (status
	// outcomes): their receipts root cannot match, so it is not checked when
	// statusBeforeByzantium allows it; gas must then be consistent as served
	// (no repair) and the header's logs bloom must be the receipts' blooms.
	statusOnly := n > 0 && blobs.preByzantium(h.number)
	for i := range parts {
		statusOnly = statusOnly && len(parts[i].outcome) != 32 && parts[i].txType == 0
	}
	if statusOnly && blobs.statusBeforeByzantium {
		if !consistent || cumulative != h.gasUsed {
			return fail("pre-Byzantium receipts without post-state roots must have consistent gas (%d of %d)", cumulative, h.gasUsed)
		}
		var bloom [256]byte
		for i := range parts {
			b := parts[i].bloom()
			for j := range bloom {
				bloom[j] |= b[j]
			}
		}
		if !bytes.Equal(bloom[:], h.logsBloom) {
			return fail("receipt logs bloom differs from the header's")
		}
		info.statusReceipts = true
	}
	if !consistent || cumulative != h.gasUsed {
		// Erigon restarts cumulative gas (and log indexes) partway through
		// some blocks. Rebuild it from per-transaction gas; the receipts root
		// check below accepts the result only if it is the consensus value.
		if summed != h.gasUsed {
			return fail("receipt gas sums to %d, header gas used is %d", summed, h.gasUsed)
		}
		var running uint64
		for i := range parts {
			running += src.receipts[i].gasUsed
			parts[i].cumulative = running
		}
		info.repairedReceipts = true
		fmt.Fprintf(os.Stderr, "{\"repaired_receipts\":%d,\"hash\":%q}\n", info.number, info.hash)
	}
	encoded := make([][]byte, n)
	for i := range parts {
		encoded[i] = parts[i].encode()
	}
	if root := orderedTrieRoot(encoded); !bytes.Equal(root[:], h.receiptsRoot) && !info.statusReceipts {
		if statusOnly {
			return fail("pre-Byzantium receipts carry a status, not the post-state root (Erigon v3.7.1 keeps no such roots), "+
				"so the receipts root 0x%x cannot match the header's 0x%x; --pre-byzantium-receipts=status archives them "+
				"after checking the logs bloom and gas instead", root, h.receiptsRoot)
		}
		return fail("receipts root 0x%x differs from the header's 0x%x", root, h.receiptsRoot)
	}
	var receiptsPayload []byte
	for i := range parts {
		var cg [8]byte
		binary.BigEndian.PutUint64(cg[:], parts[i].cumulative)
		var t [8]byte
		binary.BigEndian.PutUint64(t[:], parts[i].txType)
		rec := rlpAppendString(nil, trimLeadingZeros(t[:]))
		rec = rlpAppendString(rec, parts[i].outcome)
		rec = rlpAppendString(rec, trimLeadingZeros(cg[:]))
		rec = append(rec, parts[i].logs...)
		receiptsPayload = append(receiptsPayload, rlpList(rec)...)
	}
	payload := rlpAppendString(nil, src.raw)
	payload = rlpAppendString(payload, senders)
	payload = append(payload, rlpList(receiptsPayload)...)
	payload = rlpAppendString(payload, blobPrice) // empty (0) without blob transactions
	// extras: per transaction, the [name, value] pairs of receipt fields the chain's RPC adds and
	// a reader cannot derive. Ethereum has none, so every transaction's list is empty.
	var extras []byte
	for range parts {
		extras = append(extras, rlpList(nil)...)
	}
	payload = append(payload, rlpList(extras)...)
	return rlpList(payload), info, nil
}
