package main

// Streaming mode (`nullrpc-backfill --stream`): build an archive larger than the local
// disk by uploading it in pieces and removing local data once the bucket holds
// it. The state change streams are removed once the state layer is built and
// verified; the state layer is uploaded after the root check; each segment and
// each witness range is uploaded as soon as it is written. Only data
// objects are removed: the small reference objects (layer descriptors, bundle
// metadata) stay, so publish works from the local tree, and every removal
// follows a confirmed upload (the bucket reports the object with its size),
// so a crash at any point resumes.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// streamTarget is the bucket streamed objects go to.
type streamTarget struct {
	client   *s3.Client
	bucket   string
	uploader *manager.Uploader
	parallel int // objects in flight
}

func newStreamTarget(client *s3.Client, bucket string, parallel int) *streamTarget {
	return &streamTarget{client: client, bucket: bucket, uploader: newUploader(client, 64<<20, 4), parallel: max(1, parallel)}
}

// streamObject is one archive object to upload. Data objects are removed
// locally once uploaded; kept objects (descriptors, metadata) stay.
type streamObject struct {
	ref  ObjectRef
	keep bool
}

type streamStats struct {
	Objects int64   `json:"objects"`
	Sent    int64   `json:"sent"`
	Present int64   `json:"already_present"`
	Removed int64   `json:"local_removed"`
	Bytes   int64   `json:"bytes"`
	Seconds float64 `json:"seconds"`
}

// fileSha256 hashes a local file.
func fileSha256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.CopyBuffer(h, f, make([]byte, 1<<20)); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// put uploads objs: every data object first (in parallel), then the kept
// objects, so a reference object never reaches the bucket before the data it
// names. A data object is uploaded only if its local bytes match its
// reference (size and SHA-256), and its local file is removed only after the
// bucket reports it with that size. A data object whose local file is
// already gone must be in the bucket with its size (an earlier run uploaded
// and removed it); anything else is an error and nothing more is removed.
func (t *streamTarget) put(ctx context.Context, archive localArchive, objs []streamObject) (streamStats, error) {
	started := time.Now()
	var st streamStats
	var sent, present, removed, bytes atomic.Int64
	var data, kept []ObjectRef
	for _, o := range objs {
		if o.keep {
			kept = append(kept, o.ref)
		} else {
			data = append(data, o.ref)
		}
	}
	// Largest first, so the long uploads start early.
	sort.SliceStable(data, func(i, j int) bool { return data[i].Bytes > data[j].Bytes })
	putData := func(ref ObjectRef) error {
		p := archive.path(ref.Key)
		info, err := os.Stat(p)
		if errors.Is(err, os.ErrNotExist) {
			size, ok, err := remoteSize(ctx, t.client, t.bucket, ref.Key)
			if err != nil {
				return err
			}
			if !ok || uint64(size) != ref.Bytes {
				return fmt.Errorf("%s was removed locally but the bucket does not hold it (found=%v, %d of %d bytes)", ref.Key, ok, size, ref.Bytes)
			}
			present.Add(1)
			return nil
		}
		if err != nil {
			return err
		}
		if uint64(info.Size()) != ref.Bytes {
			return fmt.Errorf("%s has %d bytes, its reference %d", p, info.Size(), ref.Bytes)
		}
		sum, err := fileSha256(p)
		if err != nil {
			return err
		}
		if sum != ref.Sha256 {
			return fmt.Errorf("%s does not match its reference digest", p)
		}
		did, err := putFile(ctx, t.client, t.uploader, t.bucket, ref.Key, p, info.Size())
		if err != nil {
			return err
		}
		size, ok, err := remoteSize(ctx, t.client, t.bucket, ref.Key)
		if err != nil {
			return err
		}
		if !ok || uint64(size) != ref.Bytes {
			return fmt.Errorf("%s is not in the bucket with %d bytes after upload; keeping the local file", ref.Key, ref.Bytes)
		}
		if did {
			sent.Add(1)
			bytes.Add(info.Size())
		} else {
			present.Add(1)
		}
		if err := os.Remove(p); err != nil {
			return err
		}
		removed.Add(1)
		return nil
	}
	if err := parallelEach(data, t.parallel, putData); err != nil {
		return st, err
	}
	putKept := func(ref ObjectRef) error {
		raw, err := os.ReadFile(archive.path(ref.Key))
		if err != nil {
			return err
		}
		if uint64(len(raw)) != ref.Bytes || sha256Hex(raw) != ref.Sha256 {
			return fmt.Errorf("%s does not match its reference", ref.Key)
		}
		if err := putImmutable(ctx, t.client, t.bucket, ref.Key, raw); err != nil {
			return err
		}
		sent.Add(1)
		bytes.Add(int64(len(raw)))
		return nil
	}
	if err := parallelEach(kept, t.parallel, putKept); err != nil {
		return st, err
	}
	st = streamStats{Objects: int64(len(objs)), Sent: sent.Load(), Present: present.Load(), Removed: removed.Load(),
		Bytes: bytes.Load(), Seconds: time.Since(started).Seconds()}
	return st, nil
}

// verifyRemote checks that the bucket holds every object with its size.
func (t *streamTarget) verifyRemote(ctx context.Context, refs []ObjectRef) error {
	return parallelEach(refs, max(t.parallel, 32), func(ref ObjectRef) error {
		size, ok, err := remoteSize(ctx, t.client, t.bucket, ref.Key)
		if err != nil {
			return err
		}
		if !ok || uint64(size) != ref.Bytes {
			return fmt.Errorf("streamed object %s is missing from the bucket (found=%v, %d of %d bytes)", ref.Key, ok, size, ref.Bytes)
		}
		return nil
	})
}

// parallelEach runs fn on every item with n workers and returns the first
// error; after an error, no new item starts.
func parallelEach[T any](items []T, n int, fn func(T) error) error {
	var firstErr error
	var mu sync.Mutex
	var failed atomic.Bool
	next := make(chan T)
	var wg sync.WaitGroup
	for range max(1, n) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for it := range next {
				if failed.Load() {
					continue
				}
				if err := fn(it); err != nil {
					mu.Lock()
					if firstErr == nil {
						firstErr = err
					}
					mu.Unlock()
					failed.Store(true)
				}
			}
		}()
	}
	for _, it := range items {
		if failed.Load() {
			break
		}
		next <- it
	}
	close(next)
	wg.Wait()
	return firstErr
}

// readDescriptor reads a local reference object and checks it against ref.
func readDescriptor(archive localArchive, ref ObjectRef, v any) error {
	raw, err := os.ReadFile(archive.path(ref.Key))
	if err != nil {
		return err
	}
	if uint64(len(raw)) != ref.Bytes || sha256Hex(raw) != ref.Sha256 {
		return fmt.Errorf("%s does not match its reference", ref.Key)
	}
	return json.Unmarshal(raw, v)
}

// layerObjects lists a state layer's objects: every domain's data packs, index pack and
// filter (data), and the descriptor (kept).
func layerObjects(archive localArchive, descriptor ObjectRef) ([]streamObject, error) {
	var layer stateLayer
	if err := readDescriptor(archive, descriptor, &layer); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(layer.Domains))
	for name := range layer.Domains {
		names = append(names, name)
	}
	sort.Strings(names)
	var out []streamObject
	for _, name := range names {
		d := layer.Domains[name]
		for _, p := range d.Packs {
			out = append(out, streamObject{ref: p})
		}
		out = append(out, streamObject{ref: d.Index}, streamObject{ref: d.Filter})
	}
	return append(out, streamObject{ref: descriptor, keep: true}), nil
}

// stateObjects lists the state layer's objects.
func stateObjects(archive localArchive, layerPath string) ([]streamObject, error) {
	var layer StateHistoryLayerRef
	if err := readJSONFile(layerPath, &layer); err != nil {
		return nil, err
	}
	return layerObjects(archive, layer.Descriptor)
}

// chunkObjects lists one bundle's files (data) and its metadata (kept).
func chunkObjects(archive localArchive, ref BundleRef) ([]streamObject, error) {
	var meta BundleMetadata
	if err := readDescriptor(archive, ref.Metadata, &meta); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(meta.Files))
	for name := range meta.Files {
		names = append(names, name)
	}
	sort.Strings(names)
	var out []streamObject
	for _, name := range names {
		out = append(out, streamObject{ref: meta.Files[name]})
	}
	return append(out, streamObject{ref: ref.Metadata, keep: true}), nil
}

func refsOf(objs []streamObject) []ObjectRef {
	out := make([]ObjectRef, len(objs))
	for i, o := range objs {
		out[i] = o.ref
	}
	return out
}

// ---- bundle log (bundles.json) ----

// bundleLog is bundles.json, shared by the bundle writer (which appends each
// finished chunk) and the chunk uploader (which marks it uploaded).
type bundleLog struct {
	mu   sync.Mutex
	path string
	refs []BundleRef
}

func (l *bundleLog) saveLocked() error {
	data, _ := json.Marshal(l.refs)
	if err := os.WriteFile(l.path+".tmp", data, 0o644); err != nil {
		return err
	}
	return os.Rename(l.path+".tmp", l.path)
}

func (l *bundleLog) add(ref BundleRef) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.refs = append(l.refs, ref)
	return l.saveLocked()
}

func (l *bundleLog) markUploaded(chunkID uint64) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	for i := range l.refs {
		if l.refs[i].ChunkID == chunkID {
			l.refs[i].Uploaded = true
			return l.saveLocked()
		}
	}
	return fmt.Errorf("chunk %d is not in %s", chunkID, l.path)
}

// chunkStreamer uploads finished chunks in the background: a bounded queue,
// so at most a few chunks wait on local disk while later ones are built.
type chunkStreamer struct {
	target  *streamTarget
	archive localArchive
	log     *bundleLog
	queue   chan BundleRef
	started time.Time
	wg      sync.WaitGroup
	mu      sync.Mutex
	err     error
	stats   streamStats
}

const (
	streamChunkWorkers = 2 // chunks uploaded at once
	streamChunkQueue   = 2 // finished chunks waiting for an uploader
)

func newChunkStreamer(target *streamTarget, archive localArchive, log *bundleLog) *chunkStreamer {
	s := &chunkStreamer{target: target, archive: archive, log: log, queue: make(chan BundleRef, streamChunkQueue), started: time.Now()}
	for range streamChunkWorkers {
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			for ref := range s.queue {
				if s.failed() != nil {
					continue
				}
				st, err := streamChunk(target, archive, log, ref)
				s.mu.Lock()
				if err != nil && s.err == nil {
					s.err = fmt.Errorf("upload chunk %d: %w", ref.ChunkID, err)
				}
				s.stats.Objects += st.Objects
				s.stats.Sent += st.Sent
				s.stats.Present += st.Present
				s.stats.Bytes += st.Bytes
				s.stats.Removed += st.Removed
				s.mu.Unlock()
			}
		}()
	}
	return s
}

func (s *chunkStreamer) failed() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.err
}

// send queues a finished chunk; it blocks while the queue is full.
func (s *chunkStreamer) send(ref BundleRef) error {
	if err := s.failed(); err != nil {
		return err
	}
	s.queue <- ref
	return nil
}

// finish waits for every queued chunk.
func (s *chunkStreamer) finish() (streamStats, error) {
	close(s.queue)
	s.wg.Wait()
	s.stats.Seconds = time.Since(s.started).Seconds()
	return s.stats, s.err
}

// streamChunk uploads one chunk, removes its data files and records it.
func streamChunk(target *streamTarget, archive localArchive, log *bundleLog, ref BundleRef) (streamStats, error) {
	objs, err := chunkObjects(archive, ref)
	if err != nil {
		return streamStats{}, err
	}
	st, err := target.put(context.Background(), archive, objs)
	if err != nil {
		return st, err
	}
	return st, log.markUploaded(ref.ChunkID)
}

// streamPendingChunks uploads the chunks bundles.json lists as not yet
// uploaded (a run that stopped mid-upload), in order, before new ones.
func streamPendingChunks(target *streamTarget, archive localArchive, log *bundleLog) error {
	log.mu.Lock()
	var pending []BundleRef
	for _, r := range log.refs {
		if !r.Uploaded {
			pending = append(pending, r)
		}
	}
	log.mu.Unlock()
	if len(pending) == 0 {
		return nil
	}
	fmt.Fprintf(os.Stderr, "{\"stream\":\"resuming chunk uploads\",\"chunks\":%d}\n", len(pending))
	s := newChunkStreamer(target, archive, log)
	for _, r := range pending {
		if err := s.send(r); err != nil {
			break
		}
	}
	_, err := s.finish()
	return err
}

// ---- state change streams ----

// changeFiles lists the change stream files of a state dump directory.
func changeFiles(dir string) []string {
	entries, _ := os.ReadDir(dir)
	var out []string
	for _, e := range entries {
		if changesName.MatchString(e.Name()) {
			out = append(out, filepath.Join(dir, e.Name()))
		}
	}
	sort.Strings(out)
	return out
}

type stateCheck struct {
	Checked     int      `json:"checked"`
	CodeChecked int      `json:"code_checked"`
	Mismatches  int      `json:"mismatches"`
	Files       []string `json:"files"`
	Seconds     float64  `json:"seconds"`
}

// verifySample picks up to perDomain change files per value domain
// (accounts, storage), evenly spaced over the history, so the check
// covers early and late state without reading every file.
func verifySample(files []string, perDomain int) []string {
	byDomain := map[string][]string{}
	for _, f := range files {
		if m := changesName.FindStringSubmatch(filepath.Base(f)); m != nil && (m[1] == "accounts" || m[1] == "storage") {
			byDomain[m[1]] = append(byDomain[m[1]], f)
		}
	}
	var out []string
	for _, d := range []string{"accounts", "storage"} {
		fs := byDomain[d]
		sort.Slice(fs, func(i, j int) bool { return changeFileStart(fs[i]) < changeFileStart(fs[j]) })
		if len(fs) <= perDomain {
			out = append(out, fs...)
			continue
		}
		for i := range perDomain {
			out = append(out, fs[i*(len(fs)-1)/(perDomain-1)])
		}
	}
	return out
}

func changeFileStart(path string) uint64 {
	var from uint64
	if m := changesName.FindStringSubmatch(filepath.Base(path)); m != nil {
		fmt.Sscan(m[2], &from)
	}
	return from
}

// checkStateLayer compares state layer lookups at random blocks with the
// node, for keys sampled from the given change streams (and their code).
func checkStateLayer(archive localArchive, ref StateHistoryLayerRef, rpcURL string, paths []string, samples int, seed uint64) (stateCheck, error) {
	started := time.Now()
	res := stateCheck{Files: make([]string, len(paths))}
	for i, p := range paths {
		res.Files[i] = filepath.Base(p)
	}
	l, err := openLayer(archive, ref.Descriptor.Key)
	if err != nil {
		return res, err
	}
	// Sample every file in parallel, each with its own seeded generator.
	picked := make([][]keyChanges, len(paths))
	if err := parallelEach(indexes(len(paths)), 8, func(i int) error {
		rng := rand.New(rand.NewPCG(seed+uint64(i), seed^0x9e3779b9))
		var err error
		picked[i], err = sampleKeys(paths[i], samples, rng)
		return err
	}); err != nil {
		return res, err
	}
	rng := rand.New(rand.NewPCG(seed, seed^0x9e3779b9))
	for _, keys := range picked {
		for _, kc := range keys {
			block := rng.Uint64N(ref.LastBlock + 1)
			n, codes, bad, err := checkKey(l, rpcURL, kc.key, block)
			if err != nil {
				return res, err
			}
			res.Checked += n
			res.CodeChecked += codes
			res.Mismatches += bad
		}
	}
	res.Seconds = time.Since(started).Seconds()
	return res, nil
}

func indexes(n int) []int {
	out := make([]int, n)
	for i := range out {
		out[i] = i
	}
	return out
}

// removeChangeFiles deletes the change streams (keeping changes/.done, so the
// state dump stays done).
func removeChangeFiles(dir string) (int64, error) {
	var freed int64
	for _, p := range changeFiles(dir) {
		if info, err := os.Stat(p); err == nil {
			freed += info.Size()
		}
		if err := os.Remove(p); err != nil {
			return freed, err
		}
	}
	return freed, nil
}

// streamMarker persists streaming mode in a work directory: once data is
// removed locally, every later run must stream too.
const streamMarker = "stream.json"

func isStreamWork(root string) bool {
	_, err := os.Stat(filepath.Join(root, streamMarker))
	return err == nil
}

// trieTmpDir is the root check's sort directory: WORK/trie.tmp, or a directory of its
// own under --tmp (the stage empties it, so never --tmp itself).
func trieTmpDir(work, tmp string) string {
	if tmp == "" {
		return filepath.Join(work, "trie.tmp")
	}
	abs, err := filepath.Abs(work)
	if err != nil {
		abs = work
	}
	return filepath.Join(tmp, "nullrpc-backfill-trie-"+sha256Hex([]byte(abs))[:12]+".tmp")
}

func describeStreamStats(what string, st streamStats) string {
	return fmt.Sprintf("{\"stream\":%q,\"objects\":%d,\"sent\":%d,\"already_present\":%d,\"local_removed\":%d,\"gb\":%.2f,\"seconds\":%.0f}",
		what, st.Objects, st.Sent, st.Present, st.Removed, float64(st.Bytes)/1e9, st.Seconds)
}

// streamedRefs lists every object the streaming stages uploaded (the state layer, each
// segment, each witness range, both indexes), for the final check before HEAD is published.
func streamedRefs(w *workDir) ([]ObjectRef, error) {
	objs, err := stateObjects(w.archive(), w.at("state-layer.json"))
	if err != nil {
		return nil, err
	}
	refs := refsOf(objs)
	_, bundles := w.layerAndBundles()
	for _, b := range bundles {
		if !b.Uploaded {
			return nil, fmt.Errorf("chunk %d is not uploaded yet", b.ChunkID)
		}
		objs, err := chunkObjects(w.archive(), b)
		if err != nil {
			return nil, err
		}
		refs = append(refs, refsOf(objs)...)
	}
	var witnesses witnessState
	if err := readJSONFile(w.at(witnessStateFile), &witnesses); err != nil {
		return nil, err
	}
	for _, r := range witnesses.Ranges {
		if !witnesses.Uploaded[r.First] {
			return nil, fmt.Errorf("witness range %d-%d is not uploaded yet", r.First, r.Last)
		}
		refs = append(refs, r.Offsets)
		refs = append(refs, r.Packs...)
	}
	var index hashIndexState
	if err := readJSONFile(w.at(hashIndexStateFile), &index); err == nil {
		refs = append(refs, refsOf(index.Object.objects())...)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	var logs logIndexState
	if err := readJSONFile(w.at(logIndexStateFile), &logs); err == nil {
		refs = append(refs, refsOf(logs.Object.objects())...)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return refs, nil
}
