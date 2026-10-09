package core

// `backfill` with no subcommand runs the whole pipeline in a work directory.
// Every stage leaves its output there, so the current stage is derived from
// the files present: rerunning resumes, and `backfill status` reports it.

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type stage struct {
	name string
	done func(w *workDir) bool
	run  func(w *workDir) error
}

type workDir struct {
	root      string
	datadir   string
	rpc       *rpcClient
	namespace string
	genesis   []byte
	opts      runOptions
}

// envFileName holds the R2 credentials, as KEY=VALUE lines, in the work directory.
const envFileName = "backfill.env"

type runOptions struct {
	concurrency  int
	chunkBlocks  uint64
	upload       bool
	files        int
	deleteAfter  bool
	source       blockSourceOptions // datadir filled in by blockSource
	preByzantium string             // --pre-byzantium-receipts
	stream       bool               // upload in pieces and remove local data (see stream.go)
	tmp          string             // parent directory for the trie sort runs ("" = WORK/trie.tmp)
}

func (o runOptions) blockSource(datadir string) blockSourceOptions {
	src := o.source
	src.datadir = datadir
	return src
}

func (w *workDir) at(name string) string { return filepath.Join(w.root, name) }
func (w *workDir) exists(name string) bool {
	_, err := os.Stat(w.at(name))
	return err == nil
}
func (w *workDir) archive() localArchive { return localArchive{w.at("archive")} }

// stages lists the pipeline (docs/dags.md, "Backfill"). Streaming mode adds two stages
// (state check, state upload) and uploads each segment and witness range as it is written.
func stages(stream bool) []stage {
	all := []stage{
		{"block boundaries", func(w *workDir) bool { return w.exists("blocks.bin") }, func(w *workDir) error {
			_, _, err := extractBlocks(w.datadir, w.at("blocks.bin.tmp"))
			if err == nil {
				err = os.Rename(w.at("blocks.bin.tmp"), w.at("blocks.bin"))
			}
			return err
		}},
		{"state dump", func(w *workDir) bool { return w.exists("changes/.done") }, func(w *workDir) error {
			os.RemoveAll(w.at("changes"))
			if _, err := dumpState(w.datadir, []string{"accounts", "storage", "code"}, 0, w.at("changes"), runtime.NumCPU()/2, 0); err != nil {
				return err
			}
			return os.WriteFile(w.at("changes/.done"), nil, 0o644)
		}},
		{"state history", func(w *workDir) bool { return w.exists("state-layer.json") }, func(w *workDir) error {
			if w.exists("state-verify.json") || len(changeFiles(w.at("changes"))) == 0 {
				return errors.New("the change streams were removed (streaming mode); remove changes/.done and state-verify.json to dump them again")
			}
			stepSize, err := erigonStepSize(w.datadir)
			if err != nil {
				return err
			}
			ref, err := buildStateLayer(w.rpc, w.at("changes"), w.at("blocks.bin"), w.archive(), w.namespace, stepSize)
			if err != nil {
				return err
			}
			data, _ := json.Marshal(ref)
			return os.WriteFile(w.at("state-layer.json"), data, 0o644)
		}},
		// Streaming: check the layer against the node, then drop changes/.
		{"state check", func(w *workDir) bool {
			return w.exists("state-verify.json") && len(changeFiles(w.at("changes"))) == 0
		}, func(w *workDir) error {
			if !w.exists("state-verify.json") {
				var ref StateHistoryLayerRef
				if err := readJSONFile(w.at("state-layer.json"), &ref); err != nil {
					return err
				}
				files := verifySample(changeFiles(w.at("changes")), 4)
				res, err := checkStateLayer(w.archive(), ref, w.rpc.url, files, 100, 1)
				if err != nil {
					return err
				}
				line, _ := json.Marshal(res)
				fmt.Fprintln(os.Stderr, string(line))
				if res.Mismatches > 0 || res.Checked == 0 {
					return fmt.Errorf("state layer check failed (%d of %d values differ from the node); change streams kept", res.Mismatches, res.Checked)
				}
				if err := os.WriteFile(w.at("state-verify.json"), line, 0o644); err != nil {
					return err
				}
			}
			freed, err := removeChangeFiles(w.at("changes"))
			fmt.Fprintf(os.Stderr, "{\"stream\":\"change streams removed\",\"gb\":%.2f}\n", float64(freed)/1e9)
			return err
		}},
		// The state trie at the tip, built only to check its root against the header.
		{"root check", func(w *workDir) bool { return w.exists("root-check.json") }, func(w *workDir) error {
			return rootCheckStage(w.rpc, w.archive(), w.at("state-layer.json"),
				defaultTrieOptions(trieTmpDir(w.root, w.opts.tmp)), w.at("root-check.json"))
		}},
		// Streaming: upload the state layer, then drop its data.
		{"state upload", func(w *workDir) bool { return w.exists("state-upload.done") }, func(w *workDir) error {
			target, err := w.streamTarget()
			if err != nil {
				return err
			}
			objs, err := stateObjects(w.archive(), w.at("state-layer.json"))
			if err != nil {
				return err
			}
			st, err := target.put(context.Background(), w.archive(), objs)
			if err != nil {
				return err
			}
			line := describeStreamStats("state layer", st)
			fmt.Fprintln(os.Stderr, line)
			return os.WriteFile(w.at("state-upload.done"), []byte(line), 0o644)
		}},
		{"block bundles", func(w *workDir) bool {
			layer, bundles := w.layerAndBundles()
			if layer == nil || len(bundles) == 0 || bundles[len(bundles)-1].LastBlock != layer.LastBlock {
				return false
			}
			for _, b := range bundles {
				if w.opts.stream && !b.Uploaded {
					return false
				}
			}
			return true
		}, func(w *workDir) error {
			layer, done := w.layerAndBundles()
			if layer == nil {
				return errors.New("state layer missing")
			}
			blocks, err := loadBlocks(w.at("blocks.bin"))
			if err != nil {
				return err
			}
			blobs, err := parseRecordRules(w.genesis)
			if err == nil {
				err = applyPreByzantium(&blobs, w.opts.preByzantium)
			}
			if err != nil {
				return err
			}
			var target *streamTarget
			if w.opts.stream {
				if target, err = w.streamTarget(); err != nil {
					return err
				}
			}
			return buildBundles(w.rpc, w.opts.blockSource(w.datadir), blocks, w.archive(), w.namespace, 0, layer.LastBlock,
				w.opts.chunkBlocks, done, w.at("bundles.json"), blobs, target)
		}},
		// One witness range per segment, traced on the archive node.
		{"witnesses", func(w *workDir) bool {
			_, bundles := w.layerAndBundles()
			var st witnessState
			return readJSONFile(w.at(witnessStateFile), &st) == nil && len(bundles) > 0 && len(st.Ranges) == len(bundles)
		}, func(w *workDir) error { return witnessStage(w) }},
		{"hash index", func(w *workDir) bool { return w.exists(hashIndexStateFile) }, func(w *workDir) error { return hashIndexStage(w) }},
		{"log index", func(w *workDir) bool { return w.exists(logIndexStateFile) }, func(w *workDir) error { return logIndexStage(w) }},
		// Generation 1: manifest and HEAD.json in the local tree.
		{"publish", func(w *workDir) bool { return w.exists("archive/" + w.namespace + "/HEAD.json") }, func(w *workDir) error {
			return publish(w.rpc, w.archive(), w.namespace, publishInputs{
				layer: w.at("state-layer.json"), bundles: w.at("bundles.json"), rootCheck: w.at("root-check.json"),
				hashIndex: w.at(hashIndexStateFile), logIndex: w.at(logIndexStateFile), witnesses: w.at(witnessStateFile),
			}, w.genesis, w.opts.chunkBlocks)
		}},
		// Every object, manifests after data, HEAD.json last with If-None-Match.
		{"upload", func(w *workDir) bool { return w.exists("upload.done") }, func(w *workDir) error {
			if !w.opts.upload {
				return errSkip
			}
			client, bucket, err := r2Client()
			if err != nil {
				return fmt.Errorf("%w; put the NULLRPC_R2_* variables in %s", err, w.at(envFileName))
			}
			if w.opts.stream {
				// Streamed objects are no longer local: confirm each is in the
				// bucket before any manifest or HEAD names it.
				refs, err := streamedRefs(w)
				if err != nil {
					return err
				}
				target := newStreamTarget(client, bucket, w.opts.files)
				if err := target.verifyRemote(context.Background(), refs); err != nil {
					return err
				}
				fmt.Fprintf(os.Stderr, "{\"stream\":\"streamed objects present in the bucket\",\"objects\":%d}\n", len(refs))
			}
			if err := upload(client, bucket, w.archive(), w.namespace, w.opts.files, 64<<20, 4, w.opts.deleteAfter); err != nil {
				return err
			}
			return os.WriteFile(w.at("upload.done"), []byte(time.Now().UTC().Format(time.RFC3339)), 0o644)
		}},
	}
	if stream {
		return all
	}
	out := all[:0:0]
	for _, s := range all {
		if s.name != "state check" && s.name != "state upload" {
			out = append(out, s)
		}
	}
	return out
}

// streamTarget is the bucket of a streaming run (credentials as for upload).
func (w *workDir) streamTarget() (*streamTarget, error) {
	client, bucket, err := r2Client()
	if err != nil {
		return nil, fmt.Errorf("streaming mode uploads during the run: %w; put the NULLRPC_R2_* variables in %s", err, w.at(envFileName))
	}
	return newStreamTarget(client, bucket, w.opts.files), nil
}

var errSkip = errors.New("skipped")

func (w *workDir) layerAndBundles() (*StateHistoryLayerRef, []BundleRef) {
	var layer StateHistoryLayerRef
	if readJSONFile(w.at("state-layer.json"), &layer) != nil {
		return nil, nil
	}
	var bundles []BundleRef
	readJSONFile(w.at("bundles.json"), &bundles)
	return &layer, bundles
}

func workFlags(fs *flag.FlagSet) (*string, *string, *string) {
	work := fs.String("work", defaultWork(), "work directory, keeps every stage's output (env NULLRPC_WORK; default: the current directory if it is one, else ./nullrpc-work)")
	datadir := fs.String("datadir", os.Getenv("NULLRPC_DATADIR"), "Erigon datadir (env NULLRPC_DATADIR; default: from the running erigon process)")
	rpcURL := fs.String("rpc", envOr("NULLRPC_RPC_URL", "http://127.0.0.1:8545"), "Erigon JSON-RPC of the archive node (env NULLRPC_RPC_URL)")
	return work, datadir, rpcURL
}

// defaultWork is NULLRPC_WORK, the current directory when it already holds a run's output or
// its credentials, or ./nullrpc-work.
func defaultWork() string {
	if v := os.Getenv("NULLRPC_WORK"); v != "" {
		return v
	}
	for _, marker := range []string{envFileName, ".lock", "blocks.bin", "state-layer.json", "root-check.json", "bundles.json"} {
		if _, err := os.Stat(marker); err == nil {
			return "."
		}
	}
	return "nullrpc-work"
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

// openWork resolves everything a run needs from the node and the work dir.
func openWork(work, datadir, rpcURL, genesisPath string, concurrency int) (*workDir, error) {
	if err := os.MkdirAll(work, 0o755); err != nil {
		return nil, err
	}
	w := &workDir{root: work, datadir: datadir, rpc: newRPCClient(rpcURL, concurrency*3)}
	if w.datadir == "" {
		var err error
		if w.datadir, err = erigonDatadir(); err != nil {
			return nil, err
		}
	}
	for _, env := range []string{w.at(envFileName), envFileName} {
		if _, err := os.Stat(env); err == nil {
			if err := loadEnvFile(env); err != nil {
				return nil, err
			}
			break
		}
	}
	chainID, namespace, err := nodeNamespace(w.rpc)
	if err != nil {
		return nil, err
	}
	// The datadir and the RPC must be the same chain: stages read both.
	if id, genesis, err := datadirChain(context.Background(), w.datadir); err != nil {
		fmt.Fprintf(os.Stderr, "warning: cannot read the chain of %s (%v); not checked against the RPC\n", w.datadir, err)
	} else if id != chainID || "0x"+namespace[len(namespace)-64:] != genesis {
		return nil, fmt.Errorf("the datadir %s is chain %d (genesis %s), but the RPC at %s is chain %d (genesis 0x%s); pass --rpc for the node that owns the datadir",
			w.datadir, id, genesis, w.rpc.url, chainID, namespace[len(namespace)-64:])
	}
	w.namespace = namespace
	if genesisPath != "" {
		w.genesis, err = os.ReadFile(genesisPath)
	} else {
		w.genesis, err = genesisFor(chainID)
	}
	if err != nil {
		return nil, err
	}
	// The genesis config is published with the archive: it must describe
	// the node's chain (its allocation and header give the node's block 0).
	if err := checkGenesis(w.genesis, chainID, "0x"+namespace[len(namespace)-64:]); err != nil {
		return nil, err
	}
	return w, nil
}

// nodeNamespace is CHAIN_ID-GENESIS_HASH, as reported by the node.
func nodeNamespace(rpc *rpcClient) (uint64, string, error) {
	raw, err := rpc.call("eth_chainId")
	if err != nil {
		return 0, "", fmt.Errorf("cannot reach the node's RPC: %w", err)
	}
	var chainHex string
	json.Unmarshal(raw, &chainHex)
	chainID, err := parseQuantity(chainHex)
	if err != nil {
		return 0, "", err
	}
	genesis, err := rpcAnchor(rpc, "0x0")
	if err != nil {
		return 0, "", err
	}
	return chainID, fmt.Sprintf("%d-%s", chainID, genesis.Hash[2:]), nil
}

// erigonDatadir reads --datadir from a running erigon process.
func erigonDatadir() (string, error) {
	procs, _ := filepath.Glob("/proc/[0-9]*/cmdline")
	pattern := regexp.MustCompile(`^--datadir(?:=(.*))?$`)
	for _, p := range procs {
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		args := strings.Split(strings.TrimRight(string(data), "\x00"), "\x00")
		if len(args) == 0 || filepath.Base(args[0]) != "erigon" {
			continue
		}
		for i, a := range args {
			if m := pattern.FindStringSubmatch(a); m != nil {
				if m[1] != "" {
					return m[1], nil
				}
				if i+1 < len(args) {
					return args[i+1], nil
				}
			}
		}
	}
	return "", errors.New("no running erigon process with --datadir found; pass --datadir or set NULLRPC_DATADIR")
}

// lockWork prevents two runs from building into the same work directory.
func lockWork(work string) (func(), error) {
	f, err := os.OpenFile(filepath.Join(work, ".lock"), os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		pid, _ := os.ReadFile(filepath.Join(work, ".lock"))
		f.Close()
		return nil, fmt.Errorf("another backfill run (pid %s) is using %s; see `backfill status`", strings.TrimSpace(string(pid)), work)
	}
	f.Truncate(0)
	f.WriteString(strconv.Itoa(os.Getpid()))
	return func() { f.Close() }, nil
}

func runPipeline(args []string) {
	fs := flag.NewFlagSet("backfill", flag.ExitOnError)
	work, datadir, rpcURL := workFlags(fs)
	genesis := fs.String("genesis", "", "full genesis JSON (default: bundled for known chains)")
	concurrency := fs.Int("concurrency", 48, "parallel RPC calls (witness tracing, --block-source rpc, RPC fallbacks)")
	source := blockSourceFlags(fs)
	preByzantium := preByzantiumFlag(fs)
	chunkBlocks := fs.Uint64("chunk-blocks", 8192, "blocks per segment")
	doUpload := fs.Bool("upload", true, "upload to R2 (credentials from WORK/"+envFileName+")")
	files := fs.Int("upload-files", 16, "objects uploaded in parallel")
	deleteAfter := fs.Bool("delete-after", false, "remove local objects once uploaded")
	stream := fs.Bool("stream", false, "streaming mode for limited disk: upload the state layer, each segment and each witness range during the run and remove local data once uploaded (sticky per work directory)")
	tmp := fs.String("tmp", "", "directory for the root check's sort runs, e.g. on another disk (default: WORK/trie.tmp)")
	fs.Parse(args)
	unlock, err := lockWork(mustMkdir(*work))
	if err != nil {
		fail(err)
	}
	defer unlock()
	w, err := openWork(*work, *datadir, *rpcURL, *genesis, *concurrency)
	if err != nil {
		fail(err)
	}
	w.opts = runOptions{concurrency: *concurrency, chunkBlocks: *chunkBlocks, upload: *doUpload, files: *files,
		deleteAfter: *deleteAfter, source: source.options("", *concurrency), preByzantium: *preByzantium, stream: *stream, tmp: *tmp}
	if isStreamWork(w.root) && !w.opts.stream {
		fmt.Fprintf(os.Stderr, "%s was started in streaming mode; continuing with --stream\n", w.root)
		w.opts.stream = true
	}
	if w.opts.stream {
		if !w.opts.upload {
			fail(errors.New("--stream uploads during the run; it cannot be combined with --upload=false"))
		}
		if _, err := w.streamTarget(); err != nil {
			fail(err)
		}
		if !isStreamWork(w.root) {
			if err := os.WriteFile(w.at(streamMarker), []byte(`{"stream":true}`), 0o644); err != nil {
				fail(err)
			}
		}
	}
	fmt.Fprintf(os.Stderr, "namespace %s\ndatadir   %s\nwork      %s\n", w.namespace, w.datadir, w.root)
	if w.opts.stream {
		fmt.Fprintf(os.Stderr, "streaming to bucket %s; root check sort runs in %s\n", os.Getenv("NULLRPC_R2_BUCKET"), trieTmpDir(w.root, w.opts.tmp))
	}
	all := stages(w.opts.stream)
	for i, s := range all {
		label := fmt.Sprintf("[%d/%d] %s", i+1, len(all), s.name)
		if s.done(w) {
			fmt.Fprintf(os.Stderr, "%s: done\n", label)
			continue
		}
		fmt.Fprintf(os.Stderr, "%s: running\n", label)
		started := time.Now()
		if err := s.run(w); err != nil {
			if errors.Is(err, errSkip) {
				fmt.Fprintf(os.Stderr, "%s: skipped\n", label)
				continue
			}
			fail(fmt.Errorf("%s: %w", s.name, err))
		}
		fmt.Fprintf(os.Stderr, "%s: done in %s\n", label, time.Since(started).Round(time.Second))
	}
	fmt.Fprintf(os.Stderr, "archive %s is complete\n", w.namespace)
}

func mustMkdir(dir string) string {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fail(err)
	}
	return dir
}

// runStatus reports each stage from the work directory, without the node.
func runStatus(args []string) {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	work, _, _ := workFlags(fs)
	fs.Parse(args)
	w := &workDir{root: *work}
	w.opts.stream = isStreamWork(w.root)
	if ns, err := discoverNamespace(w.at("archive")); err == nil {
		w.namespace = ns
	} else if layer, _ := w.layerAndBundles(); layer != nil {
		if ns, _, ok := strings.Cut(layer.Descriptor.Key, "/state/layers/"); ok {
			w.namespace = ns
		}
	}
	if pid, err := os.ReadFile(w.at(".lock")); err == nil && len(pid) > 0 {
		f, _ := os.Open(w.at(".lock"))
		if f != nil && syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
			fmt.Printf("running: pid %s\n", strings.TrimSpace(string(pid)))
		} else {
			fmt.Println("running: no")
		}
		if f != nil {
			f.Close()
		}
	}
	if w.namespace != "" {
		fmt.Printf("namespace: %s\n", w.namespace)
	}
	current := ""
	if w.opts.stream {
		fmt.Println("mode: streaming (data uploaded during the run, local copies removed)")
	}
	all := stages(w.opts.stream)
	for i, s := range all {
		state := "pending"
		if s.done(w) {
			state = "done"
		} else if current == "" {
			current = s.name
			state = "current"
		}
		detail := ""
		if s.name == "root check" && state == "done" {
			var c rootCheck
			if readJSONFile(w.at("root-check.json"), &c) == nil {
				detail = fmt.Sprintf(" (block %d, root %s matches the header)", c.Block, c.StateRoot)
			}
		}
		if s.name == "witnesses" {
			var st witnessState
			if _, bundles := w.layerAndBundles(); readJSONFile(w.at(witnessStateFile), &st) == nil && len(bundles) > 0 {
				detail = fmt.Sprintf(" (%d/%d ranges, %d values cross-checked)", len(st.Ranges), len(bundles), st.Checked)
			}
		}
		if w.opts.stream && state == "done" {
			switch s.name {
			case "state dump":
				if w.exists("state-verify.json") && len(changeFiles(w.at("changes"))) == 0 {
					detail = " (change streams removed after the state check)"
				}
			case "state check":
				var c stateCheck
				if readJSONFile(w.at("state-verify.json"), &c) == nil {
					detail = fmt.Sprintf(" (%d values and %d codes match the node; change streams removed)", c.Checked, c.CodeChecked)
				}
			case "state upload":
				detail = " (state layer uploaded, local data removed; descriptor kept)"
			}
		}
		if s.name == "block bundles" {
			if layer, bundles := w.layerAndBundles(); layer != nil {
				next := uint64(0)
				if len(bundles) > 0 {
					next = bundles[len(bundles)-1].LastBlock + 1
				}
				detail = fmt.Sprintf(" (%d/%d blocks, %.1f%%", next, layer.LastBlock+1, 100*float64(next)/float64(layer.LastBlock+1))
				if w.opts.stream {
					uploaded := 0
					for _, b := range bundles {
						if b.Uploaded {
							uploaded++
						}
					}
					detail += fmt.Sprintf("; %d/%d chunks uploaded, local data removed", uploaded, len(bundles))
				}
				detail += ")"
			}
		}
		if w.opts.stream && s.name == "upload" && state != "done" && w.exists("state-upload.done") {
			detail = " (data already streamed; uploads the genesis config, manifest and HEAD)"
		}
		fmt.Printf("[%d/%d] %-16s %s%s\n", i+1, len(all), s.name, state, detail)
	}
	if current == "" {
		fmt.Println("complete")
	}
}

// discoverNamespace finds the single archive (directory with HEAD.json) in root.
func discoverNamespace(root string) (string, error) {
	var found []string
	filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() && (d.Name() == ".tmp" || d.Name() == "segments" || d.Name() == "state" || d.Name() == "witnesses" || d.Name() == "manifests") {
			return filepath.SkipDir
		}
		if !d.IsDir() && d.Name() == "HEAD.json" {
			rel, _ := filepath.Rel(root, filepath.Dir(p))
			found = append(found, filepath.ToSlash(rel))
		}
		return nil
	})
	switch len(found) {
	case 1:
		return found[0], nil
	case 0:
		return "", fmt.Errorf("no published archive (HEAD.json) under %s", root)
	}
	return "", fmt.Errorf("several archives under %s: %v; pass --namespace", root, found)
}
