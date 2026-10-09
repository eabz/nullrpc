package core

// Block records (docs/storage.md, "Block records"): per block one zstd frame of RLP
// [raw_block, senders, receipts, blob_gas_price, extras], built from what the node's RPC
// returns. A reader reconstructs the block and receipt JSON from it.

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"
)

const blockCodec = "rlp+zstd-v1"

// JSON fields the reader reconstructs. Any other field would be lost, so the
// writer refuses it instead of dropping it silently.
var (
	blockKeys = keySet("number hash parentHash nonce mixHash sha3Uncles logsBloom stateRoot miner difficulty " +
		"extraData gasLimit gasUsed timestamp transactionsRoot receiptsRoot baseFeePerGas withdrawalsRoot " +
		"blobGasUsed excessBlobGas parentBeaconBlockRoot requestsHash blockAccessListHash slotNumber size " +
		"transactions uncles withdrawals")
	txKeys = keySet("blockHash blockNumber blockTimestamp from gas gasPrice maxPriorityFeePerGas maxFeePerGas " +
		"hash input nonce to transactionIndex value type accessList chainId maxFeePerBlobGas " +
		"blobVersionedHashes authorizationList v yParity r s")
	receiptKeys = keySet("blockHash blockNumber transactionHash transactionIndex from to type gasUsed " +
		"cumulativeGasUsed contractAddress logs logsBloom effectiveGasPrice status root blobGasPrice blobGasUsed")
	logKeys = keySet("address topics data blockNumber transactionHash transactionIndex blockHash logIndex " +
		"removed blockTimestamp")
)

func keySet(s string) map[string]bool {
	m := map[string]bool{}
	for _, k := range strings.Fields(s) {
		m[k] = true
	}
	return m
}

func checkKeys(what string, obj map[string]json.RawMessage, allowed map[string]bool) error {
	for k := range obj {
		if !allowed[k] {
			return fmt.Errorf("%s has field %q, which the block format does not keep", what, k)
		}
	}
	return nil
}

// blockInfo is what the bundle writer needs besides the record itself.
type blockInfo struct {
	number             uint64
	hash, parent, root string
	txHashes           []string
	// repairedReceipts: Erigon's cumulative gas was rebuilt (see encodeBlockRecord).
	repairedReceipts bool
	// statusReceipts: pre-Byzantium receipts archived with Erigon's status
	// (no post-state roots), so the receipts root was not checked.
	statusReceipts bool
}

func decodeData(s string, size int) ([]byte, error) {
	if !strings.HasPrefix(s, "0x") {
		return nil, fmt.Errorf("hex data %q must start with 0x", s)
	}
	b, err := hex.DecodeString(s[2:])
	if err != nil {
		return nil, err
	}
	if size >= 0 && len(b) != size {
		return nil, fmt.Errorf("hex data %q must be %d bytes", s, size)
	}
	return b, nil
}

func quantityBytes(s string) ([]byte, error) {
	if !strings.HasPrefix(s, "0x") || len(s) < 3 || (len(s) > 3 && s[2] == '0') {
		return nil, fmt.Errorf("invalid quantity %q", s)
	}
	v, ok := new(big.Int).SetString(s[2:], 16)
	if !ok {
		return nil, fmt.Errorf("invalid quantity %q", s)
	}
	return v.Bytes(), nil
}

func str(obj map[string]json.RawMessage, key string) (string, error) {
	var s string
	if err := json.Unmarshal(obj[key], &s); err != nil {
		return "", fmt.Errorf("field %q: %w", key, err)
	}
	return s, nil
}

func isNull(raw json.RawMessage) bool { return len(raw) == 0 || string(raw) == "null" }

// rlpItem splits one RLP item off b: its payload, whether it is a list, the
// item's full encoding and the remaining bytes.
func rlpItem(b []byte) (payload []byte, list bool, full []byte, rest []byte, err error) {
	if len(b) == 0 {
		return nil, false, nil, nil, errors.New("missing RLP item")
	}
	c := b[0]
	var start, n int
	switch {
	case c < 0x80:
		start, n = 0, 1
	case c <= 0xb7:
		start, n = 1, int(c-0x80)
	case c <= 0xbf:
		ll := int(c - 0xb7)
		if len(b) < 1+ll {
			return nil, false, nil, nil, errors.New("truncated RLP length")
		}
		for _, x := range b[1 : 1+ll] {
			n = n<<8 | int(x)
		}
		start = 1 + ll
	case c <= 0xf7:
		start, n, list = 1, int(c-0xc0), true
	default:
		ll := int(c - 0xf7)
		if len(b) < 1+ll {
			return nil, false, nil, nil, errors.New("truncated RLP length")
		}
		for _, x := range b[1 : 1+ll] {
			n = n<<8 | int(x)
		}
		start, list = 1+ll, true
	}
	if n < 0 || start+n > len(b) {
		return nil, false, nil, nil, errors.New("truncated RLP item")
	}
	return b[start : start+n], list, b[:start+n], b[start+n:], nil
}

func rlpListItems(b []byte) ([][]byte, error) {
	payload, list, _, rest, err := rlpItem(b)
	if err != nil {
		return nil, err
	}
	if !list || len(rest) != 0 {
		return nil, errors.New("expected one RLP list")
	}
	var items [][]byte
	for len(payload) > 0 {
		_, _, full, r, err := rlpItem(payload)
		if err != nil {
			return nil, err
		}
		items = append(items, full)
		payload = r
	}
	return items, nil
}

func keccakHex(parts ...[]byte) string {
	h := newKeccak().sum(parts...)
	return "0x" + hex.EncodeToString(h[:])
}

// encodeBlockRecord converts one block's RPC results (eth_getBlockByNumber
// with full transactions, eth_getBlockReceipts, debug_getRawBlock) into a
// sourceBlock, refusing any JSON field the record does not keep, and builds
// the record with the shared checks (buildBlockRecord).
func encodeBlockRecord(blockJSON, receiptsJSON json.RawMessage, rawHex string, blobs recordRules) ([]byte, blockInfo, error) {
	src, err := sourceFromJSON(blockJSON, receiptsJSON, rawHex)
	if err != nil {
		return nil, blockInfo{number: src.number}, err
	}
	return buildBlockRecord(src, blobs)
}

func sourceFromJSON(blockJSON, receiptsJSON json.RawMessage, rawHex string) (*sourceBlock, error) {
	src := &sourceBlock{}
	var block map[string]json.RawMessage
	if err := json.Unmarshal(blockJSON, &block); err != nil {
		return src, fmt.Errorf("block: %w", err)
	}
	if err := checkKeys("block", block, blockKeys); err != nil {
		return src, err
	}
	numberHex, err := str(block, "number")
	if err != nil {
		return src, err
	}
	if src.number, err = parseQuantity(numberHex); err != nil {
		return src, err
	}
	fail := func(format string, a ...any) (*sourceBlock, error) {
		return src, fmt.Errorf("block %d: %s", src.number, fmt.Sprintf(format, a...))
	}
	hdr := &headerClaims{}
	src.header = hdr
	for _, f := range []struct {
		key string
		dst *[]byte
	}{{"hash", &src.hash}, {"parentHash", &hdr.parentHash}, {"stateRoot", &hdr.stateRoot}, {"receiptsRoot", &hdr.receiptsRoot}} {
		s, err := str(block, f.key)
		if err != nil {
			return fail("%v", err)
		}
		if *f.dst, err = decodeData(strings.ToLower(s), 32); err != nil {
			return fail("%s: %v", f.key, err)
		}
	}
	for _, f := range []struct {
		key string
		dst *uint64
	}{{"gasUsed", &hdr.gasUsed}, {"timestamp", &hdr.timestamp}} {
		s, err := str(block, f.key)
		if err != nil {
			return fail("%v", err)
		}
		if *f.dst, err = parseQuantity(s); err != nil {
			return fail("%s: %v", f.key, err)
		}
	}
	if !isNull(block["excessBlobGas"]) {
		s, err := str(block, "excessBlobGas")
		if err != nil {
			return fail("%v", err)
		}
		v, err := parseQuantity(s)
		if err != nil {
			return fail("excessBlobGas: %v", err)
		}
		hdr.excessBlobGas = &v
	}
	var txs []map[string]json.RawMessage
	if err := json.Unmarshal(block["transactions"], &txs); err != nil {
		return fail("transactions must be full objects: %v", err)
	}
	var receipts []map[string]json.RawMessage
	if err := json.Unmarshal(receiptsJSON, &receipts); err != nil {
		return fail("receipts: %v", err)
	}
	if len(receipts) != len(txs) {
		return fail("%d receipts for %d transactions", len(receipts), len(txs))
	}
	if src.raw, err = decodeData(rawHex, -1); err != nil {
		return fail("raw block: %v", err)
	}
	src.txHashes = make([][]byte, len(txs))
	src.txTypes = make([]uint64, len(txs))
	src.senders = make([][]byte, len(txs))
	src.receipts = make([]sourceReceipt, len(txs))
	for i, tx := range txs {
		if err := checkKeys(fmt.Sprintf("transaction %d", i), tx, txKeys); err != nil {
			return fail("%v", err)
		}
		hash, err := str(tx, "hash")
		if err != nil {
			return fail("transaction %d: %v", i, err)
		}
		if src.txHashes[i], err = decodeData(strings.ToLower(hash), 32); err != nil {
			return fail("transaction %d hash: %v", i, err)
		}
		fromHex, err := str(tx, "from")
		if err != nil {
			return fail("transaction %d: %v", i, err)
		}
		if src.senders[i], err = decodeData(fromHex, 20); err != nil {
			return fail("transaction %d from: %v", i, err)
		}
		txTypeHex, err := str(tx, "type")
		if err != nil {
			return fail("transaction %d: %v", i, err)
		}
		if src.txTypes[i], err = parseQuantity(txTypeHex); err != nil || src.txTypes[i] > 0x7f {
			return fail("transaction %d type %q", i, txTypeHex)
		}

		if src.receipts[i], err = receiptFromJSON(i, receipts[i]); err != nil {
			return fail("%v", err)
		}
	}
	return src, nil
}

// receiptFromJSON converts receipt i of eth_getBlockReceipts, refusing any
// field the record does not keep. Hashes and indexes are checked by callers.
func receiptFromJSON(i int, r map[string]json.RawMessage) (rec sourceReceipt, err error) {
	if err := checkKeys(fmt.Sprintf("receipt %d", i), r, receiptKeys); err != nil {
		return rec, err
	}
	txType := "0x0"
	if !isNull(r["type"]) {
		if txType, err = str(r, "type"); err != nil {
			return rec, fmt.Errorf("receipt %d: %v", i, err)
		}
	}
	if rec.txType, err = parseQuantity(txType); err != nil || rec.txType > 0x7f {
		return rec, fmt.Errorf("receipt %d type %q", i, txType)
	}
	switch status, root := r["status"], r["root"]; {
	case !isNull(status) && isNull(root):
		s, _ := str(r, "status")
		switch s {
		case "0x0":
		case "0x1":
			rec.outcome = []byte{1}
		default:
			return rec, fmt.Errorf("receipt %d status %q", i, s)
		}
	case isNull(status) && !isNull(root):
		s, _ := str(r, "root")
		b, err := decodeData(s, 32)
		if err != nil {
			return rec, fmt.Errorf("receipt %d root: %v", i, err)
		}
		rec.outcome = b
	default:
		return rec, fmt.Errorf("receipt %d must have exactly one of status and root", i)
	}
	cgHex, err := str(r, "cumulativeGasUsed")
	if err != nil {
		return rec, fmt.Errorf("receipt %d: %v", i, err)
	}
	if rec.cumulative, err = parseQuantity(cgHex); err != nil {
		return rec, fmt.Errorf("receipt %d cumulative gas %q", i, cgHex)
	}
	guHex, err := str(r, "gasUsed")
	if err != nil {
		return rec, fmt.Errorf("receipt %d: %v", i, err)
	}
	if rec.gasUsed, err = parseQuantity(guHex); err != nil {
		return rec, fmt.Errorf("receipt %d gas used %q", i, guHex)
	}
	var logs []map[string]json.RawMessage
	if err := json.Unmarshal(r["logs"], &logs); err != nil {
		return rec, fmt.Errorf("receipt %d logs: %v", i, err)
	}
	rec.logs = make([]sourceLog, len(logs))
	for j, l := range logs {
		if err := checkKeys(fmt.Sprintf("receipt %d log %d", i, j), l, logKeys); err != nil {
			return rec, err
		}
		addrHex, _ := str(l, "address")
		if rec.logs[j].address, err = decodeData(addrHex, 20); err != nil {
			return rec, fmt.Errorf("receipt %d log %d address: %v", i, j, err)
		}
		var topics []string
		if err := json.Unmarshal(l["topics"], &topics); err != nil || len(topics) > 4 {
			return rec, fmt.Errorf("receipt %d log %d topics are invalid", i, j)
		}
		for _, t := range topics {
			b, err := decodeData(t, 32)
			if err != nil {
				return rec, fmt.Errorf("receipt %d log %d topic: %v", i, j, err)
			}
			rec.logs[j].topics = append(rec.logs[j].topics, b)
		}
		dataHex, _ := str(l, "data")
		if rec.logs[j].data, err = decodeData(dataHex, -1); err != nil {
			return rec, fmt.Errorf("receipt %d log %d data: %v", i, j, err)
		}
	}
	if !isNull(r["blobGasPrice"]) {
		s, err := str(r, "blobGasPrice")
		if err != nil {
			return rec, fmt.Errorf("receipt %d: %v", i, err)
		}
		if rec.blobGasPrice, err = quantityBytes(s); err != nil {
			return rec, fmt.Errorf("receipt %d blobGasPrice: %v", i, err)
		}
	}
	return rec, nil
}
