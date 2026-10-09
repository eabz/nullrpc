package main

// Consensus receipts root, used to check every block's receipts against its
// header before they are archived. Erigon can serve wrong cumulative gas and
// log indexes for a block (they restart mid-block), so its JSON alone is not
// trusted.

import "encoding/binary"

// receiptParts is one receipt's consensus content.
type receiptParts struct {
	txType     uint64
	outcome    []byte // empty / 0x01 status, or a 32-byte pre-Byzantium root
	cumulative uint64
	logs       []byte // RLP list of [address, [topics], data]
	bloomItems [][]byte
}

// bloom is the receipt's logs bloom.
func (r *receiptParts) bloom() [256]byte {
	var bloom [256]byte
	k := newKeccak()
	for _, item := range r.bloomItems {
		h := k.sum(item)
		for i := 0; i < 6; i += 2 {
			bit := binary.BigEndian.Uint16(h[i:]) & 2047
			bloom[255-bit/8] |= 1 << (bit % 8)
		}
	}
	return bloom
}

// encode returns the EIP-2718 receipt encoding (legacy receipts are bare RLP).
func (r *receiptParts) encode() []byte {
	bloom := r.bloom()
	var cg [8]byte
	binary.BigEndian.PutUint64(cg[:], r.cumulative)
	p := rlpAppendString(nil, r.outcome)
	p = rlpAppendString(p, trimLeadingZeros(cg[:]))
	p = rlpAppendString(p, bloom[:])
	p = append(p, r.logs...)
	body := rlpList(p)
	if r.txType == 0 {
		return body
	}
	return append([]byte{byte(r.txType)}, body...)
}

// orderedTrieRoot is the root of the trie mapping rlp(i) to values[i], as used
// for transactions and receipts roots.
func orderedTrieRoot(values [][]byte) [32]byte {
	if len(values) == 0 {
		return emptyRootHash
	}
	keys := make([][]byte, len(values))
	for i := range values {
		var n [8]byte
		binary.BigEndian.PutUint64(n[:], uint64(i))
		key := rlpAppendString(nil, trimLeadingZeros(n[:]))
		nibbles := make([]byte, 0, 2*len(key))
		for _, c := range key {
			nibbles = append(nibbles, c>>4, c&15)
		}
		keys[i] = nibbles
	}
	idx := make([]int, len(values))
	for i := range idx {
		idx[i] = i
	}
	k := newKeccak()
	return k.sum(trieNode(k, keys, values, idx, 0))
}

// trieNode returns the RLP of the node holding entries idx below depth.
func trieNode(k *keccak, keys, values [][]byte, idx []int, depth int) []byte {
	if len(idx) == 1 {
		i := idx[0]
		return rlpList(append(rlpAppendString(nil, hexPrefix(nil, keys[i][depth:], true)), rlpAppendString(nil, values[i])...))
	}
	// Common prefix of all remaining keys.
	prefix := 0
	for {
		d := depth + prefix
		if d >= len(keys[idx[0]]) {
			break
		}
		c := keys[idx[0]][d]
		same := true
		for _, i := range idx[1:] {
			if d >= len(keys[i]) || keys[i][d] != c {
				same = false
				break
			}
		}
		if !same {
			break
		}
		prefix++
	}
	if prefix > 0 {
		child := trieNode(k, keys, values, idx, depth+prefix)
		path := keys[idx[0]][depth : depth+prefix]
		return rlpList(append(rlpAppendString(nil, hexPrefix(nil, path, false)), childRef(k, child)...))
	}
	var groups [16][]int
	var value []byte
	for _, i := range idx {
		if len(keys[i]) == depth {
			value = values[i]
			continue
		}
		c := keys[i][depth]
		groups[c] = append(groups[c], i)
	}
	var p []byte
	for _, g := range groups {
		if len(g) == 0 {
			p = rlpAppendString(p, nil)
			continue
		}
		p = append(p, childRef(k, trieNode(k, keys, values, g, depth+1))...)
	}
	p = rlpAppendString(p, value)
	return rlpList(p)
}

// childRef embeds nodes shorter than 32 bytes and references the rest by hash.
func childRef(k *keccak, node []byte) []byte {
	if len(node) < 32 {
		return node
	}
	h := k.sum(node)
	return rlpAppendString(nil, h[:])
}
