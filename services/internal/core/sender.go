package core

// Transaction sender recovery, so archived senders do not depend on Erigon's
// `from` field. Erigon's Ecrecover uses libsecp256k1 when built with cgo
// (about 30 µs per signature) and pure Go otherwise (about 180 µs), so build
// with CGO_ENABLED=1 for full-chain runs.

import (
	"errors"
	"fmt"
	"math/big"

	ecrypto "github.com/erigontech/erigon/common/crypto"
)

// recoverSender returns the 20-byte sender of one transaction as it appears in
// a block body: an RLP list for legacy transactions, or an RLP string holding
// type || RLP(payload) for EIP-2718 typed transactions.
func recoverSender(k *keccak, item []byte) ([]byte, error) {
	payload, list, _, _, err := rlpItem(item)
	if err != nil {
		return nil, err
	}
	var signing [32]byte
	var v uint64
	var r, s []byte
	if list {
		// Legacy: [nonce, gasPrice, gas, to, value, data, v, r, s].
		fields, err := rlpListItems(item)
		if err != nil || len(fields) != 9 {
			return nil, errors.New("legacy transaction must have 9 fields")
		}
		vBig, err := itemInt(fields[6])
		if err != nil {
			return nil, err
		}
		body := concat(fields[:6])
		switch {
		case vBig.IsUint64() && (vBig.Uint64() == 27 || vBig.Uint64() == 28):
			v = vBig.Uint64() - 27
		case vBig.Cmp(big.NewInt(35)) >= 0:
			// EIP-155: v = chainId*2 + 35 + recovery id.
			rest := new(big.Int).Sub(vBig, big.NewInt(35))
			v = new(big.Int).And(rest, big.NewInt(1)).Uint64()
			chainID := rest.Rsh(rest, 1)
			body = rlpAppendString(body, chainID.Bytes())
			body = rlpAppendString(body, nil)
			body = rlpAppendString(body, nil)
		default:
			return nil, fmt.Errorf("legacy transaction v %s is invalid", vBig)
		}
		signing = k.sum(rlpList(body))
		r, s = itemPayload(fields[7]), itemPayload(fields[8])
	} else {
		// Typed: type || RLP([..., yParity, r, s]); the signing hash drops the
		// last three fields.
		if len(payload) < 2 || payload[0] > 0x7f {
			return nil, errors.New("typed transaction has no type byte")
		}
		fields, err := rlpListItems(payload[1:])
		if err != nil || len(fields) < 4 {
			return nil, errors.New("typed transaction payload must be an RLP list")
		}
		n := len(fields)
		parity, err := itemInt(fields[n-3])
		if err != nil || !parity.IsUint64() || parity.Uint64() > 1 {
			return nil, errors.New("typed transaction y parity must be 0 or 1")
		}
		v = parity.Uint64()
		signing = k.sum([]byte{payload[0]}, rlpList(concat(fields[:n-3])))
		r, s = itemPayload(fields[n-2]), itemPayload(fields[n-1])
	}
	if len(r) > 32 || len(s) > 32 {
		return nil, errors.New("signature value longer than 32 bytes")
	}
	// [R || S || V], V the recovery id.
	var sig [65]byte
	copy(sig[32-len(r):32], r)
	copy(sig[64-len(s):64], s)
	sig[64] = byte(v)
	pub, err := ecrypto.Ecrecover(signing[:], sig[:])
	if err != nil {
		return nil, fmt.Errorf("recover sender: %w", err)
	}
	h := k.sum(pub[1:])
	return h[12:], nil
}

func concat(items [][]byte) []byte {
	var out []byte
	for _, it := range items {
		out = append(out, it...)
	}
	return out
}

func itemPayload(item []byte) []byte {
	payload, _, _, _, _ := rlpItem(item)
	return payload
}

func itemInt(item []byte) (*big.Int, error) {
	payload, list, _, _, err := rlpItem(item)
	if err != nil || list {
		return nil, errors.New("expected an RLP integer")
	}
	return new(big.Int).SetBytes(payload), nil
}
