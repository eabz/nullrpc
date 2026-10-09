package core

import (
	"bytes"
	"fmt"
	"os"
	"testing"
)

// TestLiveIntegration drives a local nullrpc-live (bunx wrangler dev) with the daemon's client:
// NULLRPC_LIVE_TEST_URL=http://127.0.0.1:8799 NULLRPC_LIVE_TEST_TOKEN=... go test -run LiveIntegration.
// ChainDO.setHead only accepts a head whose section it can decode, so a successful write
// checks that both sides agree on the row encoding.
func TestLiveIntegration(t *testing.T) {
	url := os.Getenv("NULLRPC_LIVE_TEST_URL")
	if url == "" {
		t.Skip("NULLRPC_LIVE_TEST_URL is not set")
	}
	c := newLiveClient(url, os.Getenv("NULLRPC_LIVE_TEST_TOKEN"))
	st, err := c.state()
	if err != nil {
		t.Fatal(err)
	}
	p := BlockID{Number: 99, Hash: fmt.Sprintf("0x%064x", 99+1000)}
	if st.Promoted == nil {
		if st, err = c.init(p, 1); err != nil {
			t.Fatal(err)
		}
	}
	if *st.Promoted != p {
		t.Fatalf("promoted %+v", st.Promoted)
	}
	var blocks []*liveBlock
	for n := uint64(100); n < 108; n++ {
		b := testBlock(n,
			diffEntry{Domain: diffAccounts, Key: bytes.Repeat([]byte{byte(n)}, 20), Value: acct(n, 1)},
			diffEntry{Domain: diffStorage, Key: bytes.Repeat([]byte{7}, 52), Value: []byte{byte(n)}},
			diffEntry{Domain: diffCode, Key: bytes.Repeat([]byte{byte(n)}, 32), Value: []byte{0x60}})
		b.Record, b.Witness, b.TxHashes = []byte{0xc0}, []byte{1, 0, 0}, []string{fmt.Sprintf("0x%064x", n)}
		blocks = append(blocks, b)
	}
	// Groups of 4: 100-103, 104-107.
	if err := c.writeGroups([][]*liveBlock{blocks[:4], blocks[4:]}, st.Shards, nil, nil); err != nil {
		t.Fatal(err)
	}
	if st, _ = c.state(); st.Head == nil || *st.Head != blocks[7].id() {
		t.Fatalf("head %+v", st.Head)
	}
	// A reorg back to 105 trims the second group; the head must accept 105.
	if err := c.reorg(blocks[5].id(), []BlockID{blocks[6].id(), blocks[7].id()}); err != nil {
		t.Fatal(err)
	}
	if st, _ = c.state(); *st.Head != blocks[5].id() {
		t.Fatalf("head after reorg %+v", st.Head)
	}
	// Promotion of the first group.
	if err := c.prune(blocks[3].id(), 2); err != nil {
		t.Fatal(err)
	}
	if st, _ = c.state(); *st.Promoted != blocks[3].id() || st.Generation != 2 {
		t.Fatalf("after prune %+v", st)
	}
	// Writing 106 again on top of the trimmed group.
	if err := c.writeGroups([][]*liveBlock{blocks[4:7]}, st.Shards, nil, nil); err != nil {
		t.Fatal(err)
	}
	if st, _ = c.state(); *st.Head != blocks[6].id() {
		t.Fatalf("head %+v", st.Head)
	}
}
