package core

// live/HEAD.json (docs/storage.md, "Live pointers"): the live window's pointers, written to R2
// after every change to the head in the live Worker, so the RPC Worker reads them from R2 and
// its edge cache instead of asking ChainDO on every request. Since the window's records are in
// R2 too (daemon_records.go), the document also lists the window's hashes and names its
// transaction index. The object is the only one besides
// HEAD.json that changes: it is written unconditionally and the latest write wins, so the writer
// serializes its writes and snapshots the pointers under the lock. A failed write is logged, not
// returned: ingestion never waits on it, and a Worker that finds the object missing or stale
// falls back to the live Worker's state().

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// livePointersKey is the object's key under the archive namespace.
const livePointersKey = "live/HEAD.json"

// livePointers is the document. Pointers above the head are left out (null), as the live
// Worker's state() leaves them unset.
type livePointers struct {
	Version    int      `json:"version"`
	Head       *BlockID `json:"head"`
	Safe       *BlockID `json:"safe"`
	Finalized  *BlockID `json:"finalized"`
	Promoted   *BlockID `json:"promoted"`
	Generation uint64   `json:"generation"`
	WrittenAt  string   `json:"written_at"`
	// Blocks lists the window's newest blocks (first..head, hashes in order), whose records are
	// live/records/{number}-{hash}.bin; TxIndex names their transaction index (daemon_records.go).
	// Both are left out when the window is unknown (a daemon without one, as in tests).
	Blocks  *liveBlocks `json:"blocks,omitempty"`
	TxIndex *ObjectRef  `json:"tx_index,omitempty"`
}

// pointers snapshots the live window's pointers as the daemon knows them.
func (d *daemon) pointers(now time.Time) livePointers {
	doc := livePointers{Version: 1, Head: d.liveHead.Load(), Promoted: d.promoted.Load(), Generation: d.generation.Load(), WrittenAt: now.UTC().Format(time.RFC3339Nano)}
	if doc.Head != nil {
		doc.Safe = capAt(d.safe.Load(), doc.Head.Number)
		doc.Finalized = capAt(d.finalized.Load(), doc.Head.Number)
	}
	return doc
}

// publishPointers writes live/HEAD.json with the current pointers. Errors are logged.
func (d *daemon) publishPointers() {
	if d.r2 == nil {
		return
	}
	d.pointersMu.Lock()
	defer d.pointersMu.Unlock()
	doc := d.pointers(time.Now())
	if doc.Head == nil || doc.Promoted == nil {
		return
	}
	// The records were written before their blocks reached the live Worker; the index goes
	// before the pointers that name it.
	blocks, entries := d.window.snapshot(*doc.Head, doc.Promoted.Number)
	doc.Blocks = &blocks
	doc.TxIndex = d.publishIndex(blocks, *doc.Head, entries)
	data, err := json.Marshal(doc)
	if err != nil {
		fmt.Fprintf(os.Stderr, "{\"live_pointers_error\":%q}\n", err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := d.r2.putPointers(ctx, data); err != nil {
		fmt.Fprintf(os.Stderr, "{\"live_pointers_error\":%q,\"head\":%d}\n", err.Error(), doc.Head.Number)
	}
}

// putPointers writes live/HEAD.json unconditionally.
func (r *r2Archive) putPointers(ctx context.Context, data []byte) error {
	key := r.ns + "/" + livePointersKey
	_, err := r.client.PutObject(ctx, &s3.PutObjectInput{Bucket: &r.bucket, Key: &key, Body: bytes.NewReader(data), ContentType: aws.String("application/json")})
	if err != nil {
		return fmt.Errorf("write %s: %w", key, err)
	}
	return nil
}
