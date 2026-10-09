package core

// Segment layout 2 (docs/storage.md, "Block bundles"): a block's record is stored as two frames,
// the block frame in blocks.pack and the receipts frame in receipts.pack, so that a log query
// decompresses and decodes only receipt bytes. offsets.bin then has 128-byte records: the
// block frame's 80-byte record, then the receipts frame's offset, lengths and digest.
//
//	block frame     RLP [raw_block, senders, blob_gas_price]
//	receipts frame  RLP [number, timestamp, tx_hashes, receipts, extras]
//
// tx_hashes is 32 bytes per transaction, in order, so the receipts frame answers eth_getLogs
// on its own; number and timestamp are the header's, checked by readers against the offsets
// record's block. Layout 1 segments (one frame per block, the whole record) stay readable:
// readSegmentBlocks splits them when a merge rewrites a chunk.

import (
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
)

const (
	segmentLayoutV1   = 1
	segmentLayoutV2   = 2
	offsetRecordLenV2 = 128
	codecReceipts     = 6 // receipts frames (docs/storage.md, "Packs")
)

func rlpAppendUint(dst []byte, v uint64) []byte {
	var be [8]byte
	binary.BigEndian.PutUint64(be[:], v)
	return rlpAppendString(dst, trimLeadingZeros(be[:]))
}

// splitRecord splits a block record [raw_block, senders, receipts, blob_gas_price, extras] into
// the layout-2 block and receipts frames. txHashes (0x-prefixed, in order) are taken when
// given and computed from the raw block otherwise.
func splitRecord(record []byte, txHashes []string, k *keccak) (block, receipts []byte, err error) {
	items, err := rlpListItems(record)
	if err != nil || len(items) != 5 {
		return nil, nil, errors.New("block record is not an RLP list of 5 items")
	}
	raw, list, _, _, err := rlpItem(items[0])
	if err != nil || list {
		return nil, nil, errors.New("block record: raw block is not a byte string")
	}
	fields, err := rlpListItems(raw)
	if err != nil || len(fields) < 2 {
		return nil, nil, errors.New("block record: raw block is not an RLP block")
	}
	header, err := rlpListItems(fields[0])
	if err != nil || len(header) < 12 {
		return nil, nil, errors.New("block record: header is not an RLP list")
	}
	number, err := rlpUint64(header[8])
	if err != nil {
		return nil, nil, errors.New("block record: header number")
	}
	timestamp, err := rlpUint64(header[11])
	if err != nil {
		return nil, nil, errors.New("block record: header timestamp")
	}
	txs, err := rlpListItems(fields[1])
	if err != nil {
		return nil, nil, errors.New("block record: transactions")
	}
	hashes := make([]byte, 0, 32*len(txs))
	if txHashes != nil {
		if len(txHashes) != len(txs) {
			return nil, nil, fmt.Errorf("block record: %d hashes for %d transactions", len(txHashes), len(txs))
		}
		for _, h := range txHashes {
			b, err := decodeData(h, 32)
			if err != nil {
				return nil, nil, err
			}
			hashes = append(hashes, b...)
		}
	} else {
		if k == nil {
			k = newKeccak()
		}
		for _, tx := range txs {
			payload, list, full, _, _ := rlpItem(tx)
			// A legacy transaction is a list, hashed whole; a typed one is a byte string whose
			// payload is hashed.
			var h [32]byte
			if list {
				h = k.sum(full)
			} else {
				h = k.sum(payload)
			}
			hashes = append(hashes, h[:]...)
		}
	}
	bp := make([]byte, 0, len(items[0])+len(items[1])+len(items[3]))
	bp = append(bp, items[0]...)
	bp = append(bp, items[1]...)
	bp = append(bp, items[3]...)
	rp := make([]byte, 0, 24+len(hashes)+len(items[2])+len(items[4]))
	rp = rlpAppendUint(rp, number)
	rp = rlpAppendUint(rp, timestamp)
	rp = rlpAppendString(rp, hashes)
	rp = append(rp, items[2]...)
	rp = append(rp, items[4]...)
	return rlpList(bp), rlpList(rp), nil
}

// joinRecord rebuilds the block record from layout-2 frames (the inverse of splitRecord).
func joinRecord(block, receipts []byte) ([]byte, error) {
	b, err := rlpListItems(block)
	if err != nil || len(b) != 3 {
		return nil, errors.New("block frame is not an RLP list of 3 items")
	}
	r, err := rlpListItems(receipts)
	if err != nil || len(r) != 5 {
		return nil, errors.New("receipts frame is not an RLP list of 5 items")
	}
	out := make([]byte, 0, len(block)+len(receipts))
	out = append(out, b[0]...)
	out = append(out, b[1]...)
	out = append(out, r[3]...)
	out = append(out, b[2]...)
	out = append(out, r[4]...)
	return rlpList(out), nil
}

// receiptsFrameLogs walks a receipts frame's logs like recordLogs walks a record's: the frame
// must describe block `number`.
func receiptsFrameLogs(plain []byte, number uint64, fn func(address []byte, topics [][]byte)) (uint64, error) {
	fail := func(format string, a ...any) (uint64, error) {
		return 0, fmt.Errorf("block %d receipts: %s", number, fmt.Sprintf(format, a...))
	}
	items, err := rlpListItems(plain)
	if err != nil || len(items) != 5 {
		return fail("not an RLP list of 5 items")
	}
	if got, err := rlpUint64(items[0]); err != nil || got != number {
		return fail("frame is for block %d", got)
	}
	hashes, list, _, _, err := rlpItem(items[2])
	if err != nil || list || len(hashes)%32 != 0 {
		return fail("transaction hashes")
	}
	receipts, err := rlpListItems(items[3])
	if err != nil {
		return fail("receipts: %v", err)
	}
	if len(receipts) != len(hashes)/32 {
		return fail("%d receipts for %d transactions", len(receipts), len(hashes)/32)
	}
	return walkReceiptLogs(receipts, fail, fn)
}

// offsetRecordV2 is one 128-byte offsets.bin record of a layout-2 segment: the block frame's
// 80-byte record (offsetRecord), then the receipts frame's offset (u64 LE), length (u32 LE),
// uncompressed length (u32 LE) and SHA-256.
func offsetRecordV2(blockHash string, block, receipts RecordOffset) ([]byte, error) {
	out, err := offsetRecord(blockHash, block)
	if err != nil {
		return nil, err
	}
	sum, err := hex.DecodeString(receipts.Sha256)
	if err != nil || len(sum) != 32 {
		return nil, errors.New("invalid receipts frame digest")
	}
	if receipts.Length > math.MaxUint32 || receipts.UncompressedLength > math.MaxUint32 {
		return nil, errors.New("receipts frame exceeds 4 GiB")
	}
	out = append(out, make([]byte, offsetRecordLenV2-offsetRecordLen)...)
	binary.LittleEndian.PutUint64(out[80:], receipts.Offset)
	binary.LittleEndian.PutUint32(out[88:], uint32(receipts.Length))
	binary.LittleEndian.PutUint32(out[92:], uint32(receipts.UncompressedLength))
	copy(out[96:], sum)
	return out, nil
}

// segmentRecordLen is the offsets.bin record length of a segment's layout.
func segmentRecordLen(meta *BundleMetadata) (uint64, error) {
	switch meta.Layout {
	case 0, segmentLayoutV1:
		return offsetRecordLen, nil
	case segmentLayoutV2:
		if _, ok := meta.Files["receipts.pack"]; !ok {
			return 0, errors.New("layout 2 segment lacks receipts.pack")
		}
		return offsetRecordLenV2, nil
	}
	return 0, fmt.Errorf("unsupported segment layout %d", meta.Layout)
}

// frameAt reads one frame's location from an offsets record at `at` (80 or 128 bytes in).
func frameAt(rec []byte, at int) (offset, length, uncompressed uint64, sha string) {
	return binary.LittleEndian.Uint64(rec[at:]), uint64(binary.LittleEndian.Uint32(rec[at+8:])),
		uint64(binary.LittleEndian.Uint32(rec[at+12:])), hex.EncodeToString(rec[at+16 : at+48])
}
