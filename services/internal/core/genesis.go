package core

import (
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"
)

// Bundled full genesis files (allocation and fork schedule), by chain ID, in geth's genesis
// format, generated from Erigon v3.7.1's embedded chain specs and allocations
// (execution/chain/spec/{chainspecs,allocs}): genesis/1.json is Ethereum mainnet,
// genesis/560048.json is Hoodi. A run checks the genesis it uses against the node's block 0
// (state root and block hash). Other chains pass --genesis.
//
//go:embed genesis/*.json
var bundledGenesis embed.FS

func genesisFor(chainID uint64) ([]byte, error) {
	data, err := bundledGenesis.ReadFile(fmt.Sprintf("genesis/%d.json", chainID))
	if err != nil {
		return nil, fmt.Errorf("no bundled genesis for chain %d; pass --genesis", chainID)
	}
	return data, nil
}

// genesisBlockHash computes the genesis block hash a genesis file implies:
// the state root of its allocation and the header fields of the forks
// active at genesis (London base fee, Shanghai withdrawals root, Cancun blob
// fields and beacon root, Prague requests hash).
func genesisBlockHash(genesisJSON []byte) (string, error) {
	var g struct {
		Config        map[string]json.RawMessage `json:"config"`
		Nonce         any                        `json:"nonce"`
		Timestamp     any                        `json:"timestamp"`
		ExtraData     string                     `json:"extraData"`
		GasLimit      any                        `json:"gasLimit"`
		Difficulty    any                        `json:"difficulty"`
		MixHash       string                     `json:"mixHash"`
		MixHashLower  string                     `json:"mixhash"`
		Coinbase      string                     `json:"coinbase"`
		ParentHash    string                     `json:"parentHash"`
		BaseFee       any                        `json:"baseFeePerGas"`
		BlobGasUsed   any                        `json:"blobGasUsed"`
		ExcessBlobGas any                        `json:"excessBlobGas"`
		Number        any                        `json:"number"`
		GasUsed       any                        `json:"gasUsed"`
	}
	if err := json.Unmarshal(genesisJSON, &g); err != nil {
		return "", fmt.Errorf("genesis: %w", err)
	}
	for _, v := range []any{g.Number, g.GasUsed} {
		if n, err := parseBig(v); err != nil || n.Sign() != 0 {
			return "", errors.New("genesis number and gasUsed must be zero")
		}
	}
	root, err := genesisTrie(genesisJSON, func([32]byte, []byte) error { return nil })
	if err != nil {
		return "", err
	}
	timestamp, err := parseBig(g.Timestamp)
	if err != nil || !timestamp.IsUint64() {
		return "", fmt.Errorf("genesis timestamp: %v", g.Timestamp)
	}
	// active reports whether a fork is active at genesis.
	active := func(key string, value uint64) (bool, error) {
		raw, ok := g.Config[key]
		if !ok || string(raw) == "null" {
			return false, nil
		}
		var at uint64
		if err := json.Unmarshal(raw, &at); err != nil {
			return false, fmt.Errorf("config %s: %w", key, err)
		}
		return at <= value, nil
	}
	fixed := func(s string, n int, what string) ([]byte, error) {
		if s == "" {
			return make([]byte, n), nil
		}
		b, err := decodeHex(s)
		if err != nil || len(b) != n {
			return nil, fmt.Errorf("genesis %s %q", what, s)
		}
		return b, nil
	}
	integer := func(v any, what string) ([]byte, error) {
		n, err := parseBig(v)
		if err != nil || n.Sign() < 0 {
			return nil, fmt.Errorf("genesis %s: %v", what, v)
		}
		return n.Bytes(), nil
	}
	parent, err := fixed(g.ParentHash, 32, "parentHash")
	if err != nil {
		return "", err
	}
	coinbase, err := fixed(g.Coinbase, 20, "coinbase")
	if err != nil {
		return "", err
	}
	mix := g.MixHash
	if mix == "" {
		mix = g.MixHashLower
	}
	mixHash, err := fixed(mix, 32, "mixHash")
	if err != nil {
		return "", err
	}
	extra, err := decodeHex(g.ExtraData)
	if err != nil {
		return "", fmt.Errorf("genesis extraData: %w", err)
	}
	nonce, err := parseBig(g.Nonce)
	if err != nil || nonce.BitLen() > 64 {
		return "", fmt.Errorf("genesis nonce: %v", g.Nonce)
	}
	var nonce8 [8]byte
	nonce.FillBytes(nonce8[:])
	difficulty, err := integer(g.Difficulty, "difficulty")
	if err != nil {
		return "", err
	}
	gasLimit, err := integer(g.GasLimit, "gasLimit")
	if err != nil {
		return "", err
	}
	k := newKeccak()
	emptyList := k.sum([]byte{0xc0})
	var h []byte
	h = rlpAppendString(h, parent)
	h = rlpAppendString(h, emptyList[:])
	h = rlpAppendString(h, coinbase)
	h = rlpAppendString(h, root[:])
	h = rlpAppendString(h, emptyRootHash[:]) // transactions
	h = rlpAppendString(h, emptyRootHash[:]) // receipts
	h = rlpAppendString(h, make([]byte, 256))
	h = rlpAppendString(h, difficulty)
	h = rlpAppendString(h, nil) // number 0
	h = rlpAppendString(h, gasLimit)
	h = rlpAppendString(h, nil) // gas used 0
	h = rlpAppendString(h, timestamp.Bytes())
	h = rlpAppendString(h, extra)
	h = rlpAppendString(h, mixHash)
	h = rlpAppendString(h, nonce8[:])
	if ok, err := active("londonBlock", 0); err != nil {
		return "", err
	} else if ok {
		baseFee := any("0x3b9aca00") // EIP-1559 initial base fee
		if g.BaseFee != nil {
			baseFee = g.BaseFee
		}
		b, err := integer(baseFee, "baseFeePerGas")
		if err != nil {
			return "", err
		}
		h = rlpAppendString(h, b)
	}
	ts := timestamp.Uint64()
	if ok, err := active("shanghaiTime", ts); err != nil {
		return "", err
	} else if ok {
		h = rlpAppendString(h, emptyRootHash[:])
	}
	if ok, err := active("cancunTime", ts); err != nil {
		return "", err
	} else if ok {
		for _, v := range []any{g.BlobGasUsed, g.ExcessBlobGas} {
			b, err := integer(v, "blob gas")
			if err != nil {
				return "", err
			}
			h = rlpAppendString(h, b)
		}
		h = rlpAppendString(h, make([]byte, 32)) // parent beacon block root
	}
	if ok, err := active("pragueTime", ts); err != nil {
		return "", err
	} else if ok {
		// EIP-7685 requests hash of no requests: sha256 of nothing.
		empty, _ := hex.DecodeString("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
		h = rlpAppendString(h, empty)
	}
	for _, later := range []string{"amsterdamTime"} {
		if ok, err := active(later, ts); err != nil || ok {
			return "", fmt.Errorf("genesis with %s active is not supported", strings.TrimSuffix(later, "Time"))
		}
	}
	sum := k.sum(rlpList(h))
	return "0x" + hex.EncodeToString(sum[:]), nil
}

// checkGenesis refuses a genesis file whose genesis block is not the node's.
func checkGenesis(genesisJSON []byte, chainID uint64, nodeGenesisHash string) error {
	var g struct {
		Config struct {
			ChainID *big.Int `json:"chainId"`
		} `json:"config"`
	}
	if err := json.Unmarshal(genesisJSON, &g); err != nil {
		return fmt.Errorf("genesis: %w", err)
	}
	if g.Config.ChainID == nil || !g.Config.ChainID.IsUint64() || g.Config.ChainID.Uint64() != chainID {
		return fmt.Errorf("genesis config is for chain %v, the node is chain %d", g.Config.ChainID, chainID)
	}
	hash, err := genesisBlockHash(genesisJSON)
	if err != nil {
		return err
	}
	if !strings.EqualFold(hash, nodeGenesisHash) {
		return fmt.Errorf("genesis config implies genesis block %s, the node's is %s", hash, nodeGenesisHash)
	}
	return nil
}
