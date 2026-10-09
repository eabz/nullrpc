package main

// Account values (docs/storage.md, "State history"):
//
//	uvarint(nonce) uvarint(len) balance[len] code_hash[32]?
//
// balance is big-endian without leading zeros; the code hash is omitted for an account
// without code. An empty value means the account does not exist. Erigon's history files
// hold its V3 encoding (length-prefixed nonce, balance, code hash, incarnation), which
// convertAccountV3 turns into this one.

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"
)

type account struct {
	nonce    uint64
	balance  []byte // big-endian, no leading zeros
	codeHash [32]byte
	hasCode  bool
}

func encodeAccount(a account) []byte {
	out := binary.AppendUvarint(nil, a.nonce)
	out = binary.AppendUvarint(out, uint64(len(a.balance)))
	out = append(out, a.balance...)
	if a.hasCode {
		out = append(out, a.codeHash[:]...)
	}
	return out
}

func decodeAccount(b []byte) (account, error) {
	var a account
	nonce, n := binary.Uvarint(b)
	if n <= 0 {
		return a, errors.New("invalid account nonce")
	}
	b = b[n:]
	size, n := binary.Uvarint(b)
	if n <= 0 || size > 32 || uint64(len(b)-n) < size {
		return a, errors.New("invalid account balance")
	}
	a.nonce, a.balance = nonce, b[n:n+int(size)]
	b = b[n+int(size):]
	switch len(b) {
	case 0:
	case 32:
		copy(a.codeHash[:], b)
		a.hasCode = true
	default:
		return a, errors.New("invalid account code hash")
	}
	return a, nil
}

// convertAccountV3 converts an Erigon V3 account value; empty stays empty (no account).
func convertAccountV3(v []byte) ([]byte, error) {
	if len(v) == 0 {
		return nil, nil
	}
	var fields [4][]byte
	b := v
	for i := range fields {
		if len(b) == 0 || len(b) < 1+int(b[0]) {
			return nil, fmt.Errorf("malformed account value %x", v)
		}
		fields[i] = b[1 : 1+int(b[0])]
		b = b[1+int(b[0]):]
	}
	if len(b) != 0 || len(fields[0]) > 8 || len(fields[1]) > 32 {
		return nil, fmt.Errorf("malformed account value %x", v)
	}
	a := account{nonce: new(big.Int).SetBytes(fields[0]).Uint64(), balance: trimLeadingZeros(fields[1])}
	switch len(fields[2]) {
	case 0:
	case 32:
		copy(a.codeHash[:], fields[2])
		// Erigon writes a zero hash, and sometimes the empty-code hash, for no code.
		a.hasCode = a.codeHash != [32]byte{} && a.codeHash != emptyCodeHash
		if !a.hasCode {
			a.codeHash = [32]byte{}
		}
	default:
		return nil, fmt.Errorf("malformed code hash in account value %x", v)
	}
	return encodeAccount(a), nil
}

// accountLeafOf is the state trie leaf of an account value.
func accountLeafOf(v []byte, storageRoot [32]byte) ([]byte, error) {
	a, err := decodeAccount(v)
	if err != nil {
		return nil, err
	}
	codeHash := emptyCodeHash
	if a.hasCode {
		codeHash = a.codeHash
	}
	var nonce [8]byte
	binary.BigEndian.PutUint64(nonce[:], a.nonce)
	return accountLeaf(trimLeadingZeros(nonce[:]), a.balance, storageRoot, codeHash), nil
}
