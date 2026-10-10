package core

// daemon (docs/pipeline.md, "Phase 3: Live"; docs/dags.md): follows a pruned node and
// keeps the live window (nullrpc-live's Durable Objects) and the R2 archive current.
//
//   - Restart (dags.md, "Restart"): read R2's HEAD.json (P), the live window's state, and the
//     spool; finish a promotion that stopped after HEAD.json moved; write spooled blocks the
//     live window lacks.
//   - Block (dags.md, "Block"): for every new block, extract and check it, spool it, write it
//     to the live window (in groups of `group` blocks), then move the head.
//   - Reorg (dags.md, "Reorg"): when a block's parent is not the spooled head.
//   - Promotion and compaction (daemon_promote.go): the promotion and each kind of merge in
//     its own goroutine.

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

type daemonConfig struct {
	spool      string
	rpc        string
	ws         string
	live       string
	batch      uint64
	maxAge     time.Duration
	maxBatches uint64
	maxObjects uint64
	group      uint64
	window     int
	genesis    string
}

type daemon struct {
	cfg     daemonConfig
	rpc     *rpcClient
	live    *liveClient
	r2      *r2Archive // nil in tests: publishPointers and the record writes are then no-ops
	gc      *gcList    // nil in tests: live objects are then never scheduled for deletion
	spool   *spool
	blobs   recordRules
	shards  int
	chainID uint64

	// Follower state (main goroutine).
	head    BlockID      // last spooled block
	pending []*liveBlock // spooled, not yet in the live window (an incomplete group)

	liveHead   atomic.Pointer[BlockID] // last block in the live window
	promoted   atomic.Pointer[BlockID] // P
	finalized  atomic.Pointer[BlockID]
	safe       atomic.Pointer[BlockID]
	network    atomic.Pointer[BlockID] // the node's head, the status page's lag target
	generation atomic.Uint64           // the archive generation the live window was last pruned to
	pointersMu sync.Mutex              // serializes live/HEAD.json writes (daemon_pointers.go)
	window     liveWindow              // the window's blocks for live/HEAD.json (daemon_records.go)
	wake       chan struct{}
}

// DaemonMain is the daemon command; args excludes the program name.
func DaemonMain(args []string) {
	programName = "daemon"
	fs := flag.NewFlagSet("daemon", flag.ExitOnError)
	cfg := daemonConfig{}
	fs.StringVar(&cfg.spool, "spool", envOr("NULLRPC_SPOOL", "nullrpc-spool"), "spool directory (env NULLRPC_SPOOL); daemon.env there holds the credentials")
	fs.StringVar(&cfg.rpc, "rpc", envOr("NULLRPC_RPC_URL", "http://127.0.0.1:8545"), "the node's JSON-RPC (env NULLRPC_RPC_URL)")
	fs.StringVar(&cfg.ws, "ws", os.Getenv("NULLRPC_WS_URL"), "the node's WebSocket for newHeads (env NULLRPC_WS_URL; default: --rpc with ws://)")
	fs.StringVar(&cfg.live, "live", os.Getenv("NULLRPC_LIVE_URL"), "the chain's nullrpc-live Worker (env NULLRPC_LIVE_URL; default: https://live-{chain-id}.nullrpc.dev)")
	fs.Uint64Var(&cfg.batch, "batch", 256, "blocks per promotion (docs/storage.md, \"Parameters\")")
	fs.DurationVar(&cfg.maxAge, "max-age", 2*time.Hour, "promote a smaller batch once the oldest unpromoted finalized block is this old")
	fs.Uint64Var(&cfg.maxBatches, "max-batches", 8, "batches promoted at most at once")
	fs.Uint64Var(&cfg.maxObjects, "max-objects", 6, "state layers, hash index objects and log index objects kept above the base; compaction merges beyond it (docs/storage.md, \"Compaction\")")
	fs.Uint64Var(&cfg.group, "group", 1, "blocks per live window row")
	fs.IntVar(&cfg.window, "window", 16, "blocks extracted in parallel while catching up")
	fs.StringVar(&cfg.genesis, "genesis", "", "full genesis JSON (default: bundled for known chains)")
	fs.Parse(args)
	if cfg.batch == 0 || cfg.group == 0 || cfg.batch%cfg.group != 0 {
		fail(errors.New("--batch must be a positive multiple of --group"))
	}
	if cfg.ws == "" {
		cfg.ws = strings.Replace(strings.Replace(cfg.rpc, "https://", "wss://", 1), "http://", "ws://", 1)
	}
	if err := os.MkdirAll(cfg.spool, 0o755); err != nil {
		fail(err)
	}
	if env := filepath.Join(cfg.spool, "daemon.env"); fileExists(env) {
		if err := loadEnvFile(env); err != nil {
			fail(err)
		}
	}
	token := os.Getenv("NULLRPC_INGEST_TOKEN")
	if token == "" {
		fail(errors.New("NULLRPC_INGEST_TOKEN is not set (nullrpc-live's INGEST_TOKEN secret)"))
	}
	if err := runDaemon(cfg, token); err != nil {
		fail(err)
	}
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func runDaemon(cfg daemonConfig, token string) error {
	d := &daemon{cfg: cfg, rpc: newRPCClient(cfg.rpc, cfg.window*4), wake: make(chan struct{}, 1)}
	var err error
	if d.spool, err = openSpool(cfg.spool); err != nil {
		return err
	}
	chainID, ns, err := nodeNamespace(d.rpc)
	if err != nil {
		return err
	}
	d.chainID = chainID
	if cfg.live == "" {
		cfg.live = fmt.Sprintf("https://live-%d.nullrpc.dev", chainID)
		d.cfg.live = cfg.live
	}
	d.live = newLiveClient(cfg.live, token)
	d.live.promotion = map[string]any{"batch": cfg.batch, "max_age_s": int64(cfg.maxAge.Seconds()), "max_batches": cfg.maxBatches, "group": cfg.group}
	var genesis []byte
	if cfg.genesis != "" {
		genesis, err = os.ReadFile(cfg.genesis)
	} else {
		genesis, err = genesisFor(chainID)
	}
	if err != nil {
		return err
	}
	if d.blobs, err = parseRecordRules(genesis); err != nil {
		return err
	}
	client, bucket, err := r2Client()
	if err != nil {
		return fmt.Errorf("%w; put the NULLRPC_R2_* variables in %s", err, filepath.Join(cfg.spool, "daemon.env"))
	}
	r2 := newR2Archive(client, bucket, ns)
	d.r2 = r2
	gc, err := loadGC(filepath.Join(cfg.spool, "gc.json"))
	if err != nil {
		return err
	}
	d.gc = gc
	fmt.Fprintf(os.Stderr, "chain %d, namespace %s, live %s, spool %s\n", chainID, ns, cfg.live, cfg.spool)
	if err := d.restart(r2); err != nil {
		return fmt.Errorf("restart: %w", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go d.subscribe(ctx)
	errs := make(chan error, 2)
	go func() {
		errs <- d.maintain(ctx, newPromotion(d, r2, gc, cfg.spool))
	}()
	go func() { errs <- d.follow(ctx) }()
	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
		fmt.Fprintln(os.Stderr, "stopping")
		return nil
	}
}

// ---- restart (dags.md, "Restart") ----

func (d *daemon) restart(r2 *r2Archive) error {
	_, _, m, err := r2.current()
	if err != nil {
		return err
	}
	p := m.ArchivedThrough.anchorID()
	st, err := d.live.state()
	if err != nil {
		return err
	}
	d.shards = st.Shards
	if st.ChainID != fmt.Sprint(d.chainID) {
		return fatalf("%s serves chain %s, the node is on chain %d", d.cfg.live, st.ChainID, d.chainID)
	}
	switch {
	case st.Promoted == nil:
		if st, err = d.live.init(p, m.Generation); err != nil {
			return err
		}
	case st.Promoted.Number < p.Number:
		// HEAD.json moved but the live window was not pruned yet.
		if err := d.live.prune(p, m.Generation); err != nil {
			return err
		}
		if st, err = d.live.state(); err != nil {
			return err
		}
	case st.Promoted.Number > p.Number:
		return fmt.Errorf("the live window says block %d is promoted, R2 ends at %d", st.Promoted.Number, p.Number)
	}
	d.promoted.Store(&p)
	d.generation.Store(m.Generation)

	// Spooled blocks above P, linked from P; anything else is acked or orphaned.
	var chain []*liveBlock
	dirOf := map[string]string{} // hash -> spool directory
	byNumber := map[uint64][]BlockID{}
	for _, dir := range []string{spoolLive, spoolReady} {
		ids, err := d.spool.list(dir)
		if err != nil {
			return err
		}
		for _, id := range ids {
			if id.Number <= p.Number {
				if err := d.spool.move(id, dir, spoolAcked); err != nil {
					return err
				}
				continue
			}
			dirOf[id.Hash] = dir
			byNumber[id.Number] = append(byNumber[id.Number], id)
		}
	}
	prev := p
	for n := p.Number + 1; ; n++ {
		var b *liveBlock
		for _, id := range byNumber[n] {
			if cand, err := d.spool.read(dirOf[id.Hash], id); err == nil && cand.Parent == prev.Hash {
				b = cand
				break
			}
		}
		if b == nil {
			break
		}
		chain = append(chain, b)
		prev = b.id()
	}
	// Spool files off that chain are orphans.
	onChain := map[string]bool{}
	for _, b := range chain {
		onChain[b.Hash] = true
	}
	for _, dir := range []string{spoolLive, spoolReady} {
		ids, _ := d.spool.list(dir)
		for _, id := range ids {
			if id.Number > p.Number && !onChain[id.Hash] {
				if err := d.spool.move(id, dir, spoolOrphaned); err != nil {
					return err
				}
			}
		}
	}

	// The live window must hold exactly the spooled chain: lower its head to the last block
	// both agree on, then write what it lacks.
	common := p
	for _, b := range chain {
		if st.Head != nil && b.Number == st.Head.Number && b.Hash == st.Head.Hash {
			common = *st.Head
		}
	}
	if st.Head == nil || *st.Head != common {
		var removed []BlockID
		if st.Head != nil && st.Head.Number > common.Number {
			removed = append(removed, *st.Head)
		}
		if err := d.live.reorg(common, removed); err != nil {
			return err
		}
	}
	d.liveHead.Store(&common)
	d.head = common
	var rewrite, present []*liveBlock
	for _, b := range chain {
		if b.Number > common.Number {
			rewrite = append(rewrite, b)
		} else {
			present = append(present, b)
			if dirOf[b.Hash] == spoolReady {
				if err := d.spool.move(b.id(), spoolReady, spoolLive); err != nil {
					return err
				}
			}
		}
		d.head = b.id()
	}
	// The blocks the live Worker already holds get their records (a no-op when they exist);
	// flush writes the rest with theirs.
	d.putRecords(present)
	d.pending = rewrite
	if err := d.flush(true); err != nil {
		return err
	}
	d.publishPointers()
	fmt.Fprintf(os.Stderr, "{\"restart\":true,\"promoted\":%d,\"live_head\":%d,\"spooled_head\":%d}\n", p.Number, d.liveHead.Load().Number, d.head.Number)
	return nil
}

// ---- following the node ----

// subscribe wakes the follower on every newHeads notification; polling covers its absence.
func (d *daemon) subscribe(ctx context.Context) {
	for ctx.Err() == nil {
		err := func() error {
			c, _, err := websocket.Dial(ctx, d.cfg.ws, nil)
			if err != nil {
				return err
			}
			defer c.CloseNow()
			c.SetReadLimit(1 << 20)
			sub, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "eth_subscribe", "params": []any{"newHeads"}})
			if err := c.Write(ctx, websocket.MessageText, sub); err != nil {
				return err
			}
			for {
				if _, _, err := c.Read(ctx); err != nil {
					return err
				}
				select {
				case d.wake <- struct{}{}:
				default:
				}
			}
		}()
		if ctx.Err() == nil {
			fmt.Fprintf(os.Stderr, "{\"newheads\":\"unavailable, polling\",\"error\":%q}\n", err.Error())
			select {
			case <-ctx.Done():
			case <-time.After(30 * time.Second):
			}
		}
	}
}

// maxFailures is how many consecutive failures of the follower or the promotion loop are
// retried (with backoff) before the daemon stops: transient RPC and R2 errors pass, a block that
// keeps failing its checks stops it.
const maxFailures = 10

// errNotReady is a block at the node's head that the node announced but cannot trace yet: the
// follower retries it quietly, without counting a failure, for up to maxNotReady tries.
var errNotReady = errors.New("the node cannot trace this block yet")

const (
	// tipSlack is how far below the node's head a block counts as at the tip.
	tipSlack    = 2
	maxNotReady = 30
	notReadyGap = time.Second
)

// notReadyAtTip tells whether err is the node not yet able to trace block n, just announced.
func notReadyAtTip(n, nodeHead uint64, err error) bool {
	return n+tipSlack >= nodeHead && strings.Contains(err.Error(), "block not found")
}

func backoff(ctx context.Context, what string, failures int, err error) bool {
	delay := min(time.Duration(1<<min(failures, 8))*time.Second, 5*time.Minute)
	fmt.Fprintf(os.Stderr, "{\"retry\":%q,\"failures\":%d,\"error\":%q,\"in_s\":%.0f}\n", what, failures, err.Error(), delay.Seconds())
	select {
	case <-ctx.Done():
		return false
	case <-time.After(delay):
		return true
	}
}

func (d *daemon) follow(ctx context.Context) error {
	poll := time.NewTicker(2 * time.Second)
	defer poll.Stop()
	failures, notReady := 0, 0
	for {
		if err := d.step(); err != nil {
			if errors.Is(err, errNotReady) && notReady < maxNotReady {
				notReady++
				select {
				case <-ctx.Done():
					return nil
				case <-time.After(notReadyGap):
				}
				continue
			}
			var fatal *fatalError
			if failures++; failures >= maxFailures || errors.As(err, &fatal) {
				return err
			}
			if !backoff(ctx, "follow", failures, err) {
				return nil
			}
			continue
		}
		failures, notReady = 0, 0
		select {
		case <-ctx.Done():
			return nil
		case <-d.wake:
		case <-poll.C:
		}
	}
}

func (d *daemon) blockTag(tag string) (*BlockID, error) {
	a, err := rpcAnchor(d.rpc, tag)
	if err != nil {
		if strings.Contains(err.Error(), "empty result") {
			return nil, nil
		}
		return nil, err
	}
	return &BlockID{Number: a.Number, Hash: a.Hash}, nil
}

// step brings the spool and the live window up to the node's head.
func (d *daemon) step() error {
	latest, err := d.blockTag("latest")
	if err != nil {
		return err
	}
	if latest == nil {
		return errors.New("the node has no latest block")
	}
	d.network.Store(latest)
	nodeHead := latest.Number
	if fin, err := d.blockTag("finalized"); err == nil && fin != nil {
		d.finalized.Store(fin)
	}
	if safe, err := d.blockTag("safe"); err == nil && safe != nil {
		d.safe.Store(safe)
	}
	for d.head.Number < nodeHead {
		from := d.head.Number + 1
		to := min(nodeHead, from+uint64(d.cfg.window)-1)
		blocks := make([]*liveBlock, to-from+1)
		errs := make([]error, len(blocks))
		var wg sync.WaitGroup
		for i := range blocks {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				blocks[i], errs[i] = extractBlock(d.rpc, from+uint64(i), d.blobs)
			}(i)
		}
		wg.Wait()
		for i, b := range blocks {
			if errs[i] != nil {
				if notReadyAtTip(from+uint64(i), nodeHead, errs[i]) {
					return fmt.Errorf("block %d: %w: %w", from+uint64(i), errNotReady, errs[i])
				}
				return fmt.Errorf("block %d: %w (if the node pruned its state, it cannot trace this block: restore it from a snapshot at or below block %d)", from+uint64(i), errs[i], d.liveHead.Load().Number)
			}
			if b.Parent != d.head.Hash {
				if err := d.reorg(b.Number); err != nil {
					return err
				}
				break
			}
			if err := d.spool.write(b); err != nil {
				return err
			}
			d.pending = append(d.pending, b)
			d.head = b.id()
		}
		if err := d.flush(false); err != nil {
			return err
		}
	}
	return nil
}

// flush writes complete groups of pending blocks to the live window, then moves their spool
// files to live/. With all, an incomplete last group is written too (restart).
func (d *daemon) flush(all bool) error {
	var groups [][]*liveBlock
	var cur []*liveBlock
	done := 0
	for i, b := range d.pending {
		cur = append(cur, b)
		if (b.Number+1)%d.cfg.group == 0 || (all && i == len(d.pending)-1) {
			groups = append(groups, cur)
			done += len(cur)
			cur = nil
		}
	}
	if len(groups) == 0 {
		return nil
	}
	safe, fin := d.safe.Load(), d.finalized.Load()
	for start := 0; start < len(groups); start += 64 {
		batch := groups[start:min(start+64, len(groups))]
		last := batch[len(batch)-1]
		head := last[len(last)-1]
		var blocks []*liveBlock
		for _, g := range batch {
			blocks = append(blocks, g...)
		}
		// Records first: live/HEAD.json names a block only once its record is in R2.
		d.putRecords(blocks)
		headID := head.id()
		if err := d.live.writeGroups(batch, d.shards, capAt(safe, &headID), capAt(fin, &headID), d.network.Load()); err != nil {
			return err
		}
		for _, g := range batch {
			for _, b := range g {
				if err := d.spool.move(b.id(), spoolReady, spoolLive); err != nil {
					return err
				}
			}
		}
		id := head.id()
		d.liveHead.Store(&id)
		d.publishPointers()
	}
	d.pending = d.pending[done:]
	return nil
}

// capAt is a chain pointer (safe, finalized) as the live window may hold it: the pointer itself
// when it is at or below the head, else the head. A node finalized past the daemon's head (the
// daemon catching up) has finalized the head too, so the head is finalized; dropping the
// pointer instead would leave the live window without one for the whole catch-up (no finalized
// block in /status.json, no promotion schedule on the status page).
func capAt(b *BlockID, head *BlockID) *BlockID {
	if b == nil || head == nil {
		return nil
	}
	if b.Number > head.Number {
		h := *head
		return &h
	}
	return b
}

// ---- reorgs (dags.md, "Reorg") ----

// reorg handles a block at n whose parent is not the spooled head: find the common ancestor,
// remove the blocks above it from the live window and the spool, and continue from it.
func (d *daemon) reorg(n uint64) error {
	finalized := d.finalized.Load()
	spooled := map[uint64]BlockID{}
	dirOf := map[string]string{}
	for _, dir := range []string{spoolLive, spoolReady} {
		ids, err := d.spool.list(dir)
		if err != nil {
			return err
		}
		for _, id := range ids {
			spooled[id.Number] = id
			dirOf[id.Hash] = dir
		}
	}
	promoted := d.promoted.Load()
	ancestor := *promoted
	for k := n - 1; k > promoted.Number; k-- {
		mine, ok := spooled[k]
		if !ok {
			continue
		}
		theirs, err := d.blockTag(fmt.Sprintf("0x%x", k))
		if err != nil {
			return err
		}
		if theirs != nil && theirs.Hash == mine.Hash {
			ancestor = mine
			break
		}
	}
	if finalized != nil && ancestor.Number < finalized.Number {
		return fatalf("reorg below the finalized block %d (common ancestor %d): the node is on another chain, or finality was violated", finalized.Number, ancestor.Number)
	}
	var removed []BlockID
	for num, id := range spooled {
		if num > ancestor.Number {
			removed = append(removed, id)
		}
	}
	if err := d.live.reorg(ancestor, removed); err != nil {
		return err
	}
	for _, id := range removed {
		if err := d.spool.move(id, dirOf[id.Hash], spoolOrphaned); err != nil {
			return err
		}
	}
	var keep []*liveBlock
	for _, b := range d.pending {
		if b.Number <= ancestor.Number {
			keep = append(keep, b)
		}
	}
	d.pending = keep
	d.head = ancestor
	if lh := d.liveHead.Load(); lh.Number > ancestor.Number {
		d.liveHead.Store(&ancestor)
	}
	d.dropRecords(d.window.truncateAbove(ancestor.Number))
	d.publishPointers()
	fmt.Fprintf(os.Stderr, "{\"reorg\":true,\"at\":%d,\"ancestor\":%d,\"removed\":%d}\n", n, ancestor.Number, len(removed))
	return nil
}

// ---- promotion and compaction loop ----

// maintain promotes when a target is due and compacts in a goroutine per kind of merge
// (compactLoop), so a merge never delays a promotion, promotions never starve the merges, and
// one kind's merges never starve another's. Any loop stopping on an error stops the daemon.
func (d *daemon) maintain(ctx context.Context, p *promotion) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	errs := make(chan error, mergeChunk)
	for kind := mergeStateLayers; kind <= mergeChunk; kind++ {
		go func() { errs <- d.compactLoop(ctx, p, kind) }()
	}
	tick := time.NewTicker(10 * time.Second)
	defer tick.Stop()
	failures := 0
	for {
		select {
		case err := <-errs:
			return err
		default:
		}
		target, ok, err := d.promotionTarget()
		if err != nil {
			return err
		}
		if ok {
			if err := p.promote(target, *d.finalized.Load()); err != nil {
				if failures++; failures >= maxFailures {
					return fmt.Errorf("promotion to %d: %w", target.Number, err)
				}
				if !backoff(ctx, "promotion", failures, err) {
					return nil
				}
				continue
			}
			failures = 0
			continue
		}
		d.spool.expire()
		select {
		case <-ctx.Done():
			return nil
		case err := <-errs:
			return err
		case <-tick.C:
		}
	}
}

// compactLoop runs one kind's merges back to back while there is something to merge; when
// there is nothing, it looks again in 10 s. The chunk loop, idle most of the time, also deletes
// the objects due for deletion.
func (d *daemon) compactLoop(ctx context.Context, p *promotion, kind mergeKind) error {
	failures := 0
	for ctx.Err() == nil {
		merged, err := p.compact(kind)
		if err != nil {
			if failures++; failures >= maxFailures {
				return fmt.Errorf("compaction of %s: %w", kind, err)
			}
			if !backoff(ctx, "compaction of "+kind.String(), failures, err) {
				return nil
			}
			continue
		}
		failures = 0
		if merged {
			continue
		}
		if kind == mergeChunk {
			if err := p.gc.collect(p.r2); err != nil {
				fmt.Fprintf(os.Stderr, "{\"gc_error\":%q}\n", err.Error())
			}
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(10 * time.Second):
		}
	}
	return nil
}

// promotionTarget decides whether blocks are due for promotion: a full batch is finalized, or
// the oldest unpromoted finalized block is older than max-age. The target ends at a group
// boundary and at most max-batches batches above P, and never above the live window's head.
// The max-age rule applies only once the live window is within a batch of the node's head:
// while the daemon catches up, every spooled block is old, and the rule would promote each
// extraction window of 16 blocks as its own batch (mainnet's catch-up of 2026-10-10 wrote 140
// objects of 16 or 32 blocks per kind in 35 minutes); until then only full batches go.
func (d *daemon) promotionTarget() (BlockID, bool, error) {
	p, fin, lh := d.promoted.Load(), d.finalized.Load(), d.liveHead.Load()
	if fin == nil || lh == nil {
		return BlockID{}, false, nil
	}
	limit := min(fin.Number, lh.Number, p.Number+d.cfg.maxBatches*d.cfg.batch)
	// End on a group boundary: (to+1) % group == 0.
	to := (limit+1)/d.cfg.group*d.cfg.group - 1
	if limit+1 < d.cfg.group || to <= p.Number {
		return BlockID{}, false, nil
	}
	if to-p.Number < d.cfg.batch {
		if head := d.network.Load(); head != nil && head.Number > lh.Number+d.cfg.batch {
			return BlockID{}, false, nil
		}
		first, err := d.spool.read(spoolLive, d.spoolID(p.Number+1))
		if err != nil {
			return BlockID{}, false, nil
		}
		if time.Since(time.Unix(int64(first.Timestamp), 0)) < d.cfg.maxAge {
			return BlockID{}, false, nil
		}
	}
	id := d.spoolID(to)
	if id.Hash == "" {
		return BlockID{}, false, nil
	}
	return id, true, nil
}

// spoolID finds a block's id in live/.
func (d *daemon) spoolID(n uint64) BlockID {
	ids, _ := d.spool.list(spoolLive)
	for _, id := range ids {
		if id.Number == n {
			return id
		}
	}
	return BlockID{}
}

// afterPromotion runs once HEAD.json names the new generation: prune the live window, record
// P, and move the promoted spool files to acked/.
func (d *daemon) afterPromotion(to BlockID, generation uint64) error {
	if err := d.live.prune(to, generation); err != nil {
		return err
	}
	d.promoted.Store(&to)
	d.generation.Store(generation)
	d.dropRecords(d.window.pruneAtOrBelow(to.Number))
	d.publishPointers()
	ids, err := d.spool.list(spoolLive)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if id.Number <= to.Number {
			if err := d.spool.move(id, spoolLive, spoolAcked); err != nil {
				return err
			}
		}
	}
	return nil
}

// fatalError stops the daemon at once: retrying cannot fix it.
type fatalError struct{ err error }

func (e *fatalError) Error() string { return e.err.Error() }
func (e *fatalError) Unwrap() error { return e.err }

func fatalf(format string, a ...any) error { return &fatalError{fmt.Errorf(format, a...)} }

func ignoreCanceled(err error) error {
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}
