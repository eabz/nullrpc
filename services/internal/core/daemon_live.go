package core

// Writes to the live window (docs/storage.md, "Durable Objects") through nullrpc-live's
// ingest route, and the row encoding both sides share.
//
// A row holds one group of consecutive blocks (docs/storage.md, "Parameters", `group`), keyed
// by its first block. Its data is one section per block:
//
//	section := uvarint(number - first) hash[32] uvarint(len) payload
//
// ChainDO payload: uvarint(len) record, uvarint(len) witness, uvarint(n) tx hashes (32 bytes each).
// StateShard payload: per entry a domain byte, the key (20, 52 or 32 bytes by domain), uvarint(len)
// and the value. A shard row holds only the blocks that touch the shard.

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

type liveClient struct {
	url   string
	token string
	http  *http.Client
}

func newLiveClient(url, token string) *liveClient {
	return &liveClient{url: strings.TrimRight(url, "/"), token: token, http: &http.Client{Timeout: 2 * time.Minute}}
}

// liveState is GET /ingest/state.
type liveState struct {
	ChainID    string   `json:"chain_id"`
	Shards     int      `json:"shards"`
	Head       *BlockID `json:"head"`
	Safe       *BlockID `json:"safe"`
	Finalized  *BlockID `json:"finalized"`
	Promoted   *BlockID `json:"promoted"`
	Generation uint64   `json:"generation"`
}

// do sends one request, retrying network errors and 5xx answers with backoff until it succeeds.
// A 4xx answer is returned as an error: the request itself is wrong, and retrying cannot fix it.
func (c *liveClient) do(method, path string, body, out any) error {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return err
		}
	}
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequest(method, c.url+path, bytes.NewReader(payload))
		if err != nil {
			return err
		}
		req.Header.Set("authorization", "Bearer "+c.token)
		req.Header.Set("content-type", "application/json")
		resp, err := c.http.Do(req)
		if err == nil {
			data, rerr := io.ReadAll(resp.Body)
			resp.Body.Close()
			switch {
			case rerr != nil:
				err = rerr
			case resp.StatusCode >= 400 && resp.StatusCode < 500:
				return fmt.Errorf("%s %s: HTTP %d: %s", method, path, resp.StatusCode, strings.TrimSpace(string(data)))
			case resp.StatusCode >= 300:
				err = fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(data)))
			default:
				if out == nil {
					return nil
				}
				return json.Unmarshal(data, out)
			}
		}
		delay := min(time.Duration(1<<min(attempt, 8))*time.Second, 5*time.Minute)
		fmt.Fprintf(os.Stderr, "{\"live_retry\":%q,\"error\":%q,\"in_s\":%.0f}\n", path, err.Error(), delay.Seconds())
		time.Sleep(delay)
	}
}

func (c *liveClient) state() (liveState, error) {
	var st liveState
	return st, c.do("GET", "/ingest/state", nil, &st)
}

func (c *liveClient) init(promoted BlockID, generation uint64) (liveState, error) {
	var st liveState
	return st, c.do("POST", "/ingest/init", map[string]any{"promoted": promoted, "generation": generation}, &st)
}

// ingestRow is one group: its ChainDO row and one row per touched shard.
type ingestRow struct {
	First  uint64            `json:"first"`
	Last   uint64            `json:"last"`
	Chain  string            `json:"chain"`
	Shards map[string]string `json:"shards"`
}

// writeGroups writes groups of blocks (shards, then block rows, then the head) in one request.
// network is the node's head, which the status page measures the lag to; nil omits it.
func (c *liveClient) writeGroups(groups [][]*liveBlock, shards int, safe, finalized, network *BlockID) error {
	rows := make([]ingestRow, len(groups))
	for i, g := range groups {
		rows[i] = encodeGroup(g, shards)
	}
	last := groups[len(groups)-1]
	head := last[len(last)-1].id()
	body := map[string]any{"rows": rows, "head": head, "safe": safe, "finalized": finalized}
	if network != nil {
		body["network_head"] = network
	}
	return c.do("POST", "/ingest/blocks", body, nil)
}

func (c *liveClient) reorg(ancestor BlockID, removed []BlockID) error {
	return c.do("POST", "/ingest/reorg", map[string]any{"ancestor": ancestor, "removed": removed}, nil)
}

func (c *liveClient) prune(promoted BlockID, generation uint64) error {
	return c.do("POST", "/ingest/prune", map[string]any{"promoted": promoted, "generation": generation}, nil)
}

func appendSection(dst []byte, first uint64, b *liveBlock, payload []byte) []byte {
	dst = binary.AppendUvarint(dst, b.Number-first)
	h, _ := hex.DecodeString(strings.TrimPrefix(b.Hash, "0x"))
	dst = append(dst, h...)
	dst = binary.AppendUvarint(dst, uint64(len(payload)))
	return append(dst, payload...)
}

func chainPayload(b *liveBlock) []byte {
	out := binary.AppendUvarint(nil, uint64(len(b.Record)))
	out = append(out, b.Record...)
	out = binary.AppendUvarint(out, uint64(len(b.Witness)))
	out = append(out, b.Witness...)
	out = binary.AppendUvarint(out, uint64(len(b.TxHashes)))
	for _, h := range b.TxHashes {
		raw, _ := hex.DecodeString(strings.TrimPrefix(h, "0x"))
		out = append(out, raw...)
	}
	return out
}

// shardOf routes a state key: keccak256(address)[0] mod n for accounts and storage,
// code_hash[0] mod n for code.
func shardOf(k *keccak, e diffEntry, n int) int {
	if e.Domain == diffCode {
		return int(e.Key[0]) % n
	}
	h := k.sum(e.Key[:20])
	return int(h[0]) % n
}

func encodeGroup(g []*liveBlock, shards int) ingestRow {
	first := g[0].Number
	k := newKeccak()
	var chain []byte
	perShard := map[int][]byte{}
	for _, b := range g {
		chain = appendSection(chain, first, b, chainPayload(b))
		entries := map[int][]byte{}
		for _, e := range b.Diff {
			s := shardOf(k, e, shards)
			buf := append(entries[s], e.Domain)
			buf = append(buf, e.Key...)
			buf = binary.AppendUvarint(buf, uint64(len(e.Value)))
			entries[s] = append(buf, e.Value...)
		}
		for s, payload := range entries {
			perShard[s] = appendSection(perShard[s], first, b, payload)
		}
	}
	row := ingestRow{First: first, Last: g[len(g)-1].Number, Chain: base64.StdEncoding.EncodeToString(chain), Shards: map[string]string{}}
	for s, data := range perShard {
		row.Shards[fmt.Sprint(s)] = base64.StdEncoding.EncodeToString(data)
	}
	return row
}
