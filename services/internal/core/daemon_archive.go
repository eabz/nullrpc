package core

// The daemon's side of R2: read the current generation, upload new objects, publish a
// generation with If-Match, and delete objects no manifest has referenced for 7 days
// (docs/storage.md, "Rules").

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

const gcDelay = 7 * 24 * time.Hour

type r2Archive struct {
	client   *s3.Client
	bucket   string
	ns       string
	src      s3Source
	uploader *manager.Uploader
}

func newR2Archive(client *s3.Client, bucket, ns string) *r2Archive {
	return &r2Archive{client: client, bucket: bucket, ns: ns, src: s3Source{client, bucket}, uploader: newUploader(client, 64<<20, 4)}
}

// current reads HEAD.json (with its ETag) and the manifest it names.
func (r *r2Archive) current() (Head, string, *Manifest, error) {
	raw, etag, err := r.src.getWithETag(r.ns + "/HEAD.json")
	if err != nil {
		return Head{}, "", nil, fmt.Errorf("read HEAD.json: %w", err)
	}
	var head Head
	if err := json.Unmarshal(raw, &head); err != nil {
		return Head{}, "", nil, fmt.Errorf("HEAD.json: %w", err)
	}
	data, err := r.src.get(head.Manifest.Key)
	if err != nil {
		return Head{}, "", nil, err
	}
	if uint64(len(data)) != head.Manifest.Bytes || sha256Hex(data) != head.Manifest.Sha256 {
		return Head{}, "", nil, fmt.Errorf("%s does not match HEAD.json", head.Manifest.Key)
	}
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return Head{}, "", nil, err
	}
	if m.Format != manifestFormat || m.Version != 1 || m.Generation != head.Generation {
		return Head{}, "", nil, fmt.Errorf("unsupported manifest %s", head.Manifest.Key)
	}
	// Key and partition sizes are manifest-level fields.
	if m.HashIndex != nil {
		for i := range m.HashIndex.Objects {
			m.HashIndex.Objects[i].KeyBytes = m.HashIndex.KeyBytes
		}
	}
	if m.LogIndex != nil {
		for i := range m.LogIndex.Objects {
			m.LogIndex.Objects[i].KeyBytes = m.LogIndex.KeyBytes
			m.LogIndex.Objects[i].PartitionBlocks = m.LogIndex.PartitionBlocks
		}
	}
	return head, etag, &m, nil
}

// upload sends the given objects of the local staging tree to R2 (create-if-absent; an
// object already there with the same size counts as uploaded) and removes the local copies.
func (r *r2Archive) upload(local localArchive, refs []ObjectRef) error {
	return parallelEach(refs, 16, func(ref ObjectRef) error {
		path := local.path(ref.Key)
		if _, err := putFile(context.Background(), r.client, r.uploader, r.bucket, ref.Key, path, int64(ref.Bytes)); err != nil {
			return err
		}
		return os.Remove(path)
	})
}

// publish writes manifest m and moves HEAD.json to it with If-Match on etag. It returns the
// new HEAD and its ETag.
func (r *r2Archive) publish(m *Manifest, etag string) (Head, string, error) {
	data, err := json.Marshal(m)
	if err != nil {
		return Head{}, "", err
	}
	key := fmt.Sprintf("%s/manifests/%020d-%s.json", r.ns, m.Generation, sha256Hex(data))
	ctx := context.Background()
	if err := putImmutable(ctx, r.client, r.bucket, key, data); err != nil {
		return Head{}, "", err
	}
	head := Head{Version: 1, Generation: m.Generation, Manifest: ObjectRef{Key: key, Bytes: uint64(len(data)), Sha256: sha256Hex(data)}}
	headData, _ := json.Marshal(head)
	headKey := r.ns + "/HEAD.json"
	out, err := r.client.PutObject(ctx, &s3.PutObjectInput{Bucket: &r.bucket, Key: &headKey,
		Body: strings.NewReader(string(headData)), ContentType: aws.String("application/json"), IfMatch: aws.String(etag)})
	if err != nil {
		return Head{}, "", fmt.Errorf("move HEAD.json (it changed since it was read, or R2 failed): %w", err)
	}
	return head, aws.ToString(out.ETag), nil
}

// segmentKeys lists a segment's objects (meta.json and the files it names).
func (r *r2Archive) segmentKeys(s SegmentRef) ([]string, error) {
	var meta BundleMetadata
	raw, err := r.src.get(s.Meta.Key)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(raw, &meta); err != nil {
		return nil, err
	}
	keys := []string{s.Meta.Key}
	for _, f := range meta.Files {
		keys = append(keys, f.Key)
	}
	return keys, nil
}

func (r *r2Archive) layerKeys(l StateHistoryLayerRef) ([]string, error) {
	layer, err := r.layer(l)
	if err != nil {
		return nil, err
	}
	keys := []string{l.Descriptor.Key}
	for _, d := range layer.Domains {
		for _, p := range d.Packs {
			keys = append(keys, p.Key)
		}
		keys = append(keys, d.Index.Key, d.Filter.Key)
	}
	return keys, nil
}

func (r *r2Archive) layer(l StateHistoryLayerRef) (*stateLayer, error) {
	raw, err := r.src.get(l.Descriptor.Key)
	if err != nil {
		return nil, err
	}
	if sha256Hex(raw) != l.Descriptor.Sha256 {
		return nil, fmt.Errorf("%s does not match its reference", l.Descriptor.Key)
	}
	var layer stateLayer
	return &layer, json.Unmarshal(raw, &layer)
}

func hashIndexKeys(o HashIndexObject) []string {
	keys := []string{o.Transactions.Directory.Key, o.Blocks.Directory.Key}
	for _, p := range o.Packs {
		keys = append(keys, p.Key)
	}
	return keys
}

func logIndexKeys(o LogIndexObject) []string {
	keys := []string{o.Directory.Key}
	for _, p := range o.Packs {
		keys = append(keys, p.Key)
	}
	return keys
}

func witnessKeys(w WitnessRange) []string {
	keys := []string{w.Offsets.Key}
	for _, p := range w.Packs {
		keys = append(keys, p.Key)
	}
	return keys
}

// ---- garbage collection ----

type gcEntry struct {
	Key string    `json:"key"`
	Due time.Time `json:"due"`
}

type gcList struct {
	path    string
	Entries []gcEntry `json:"entries"`
}

func loadGC(path string) (*gcList, error) {
	g := &gcList{path: path}
	if err := readJSONFile(path, g); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return g, nil
}

func (g *gcList) save() error {
	data, _ := json.MarshalIndent(g, "", "  ")
	if err := os.WriteFile(g.path+".tmp", data, 0o644); err != nil {
		return err
	}
	return os.Rename(g.path+".tmp", g.path)
}

// schedule adds keys to delete 7 days from now: no request pins a generation that long.
func (g *gcList) schedule(keys []string) error {
	due := time.Now().Add(gcDelay)
	seen := map[string]bool{}
	for _, e := range g.Entries {
		seen[e.Key] = true
	}
	for _, k := range keys {
		if !seen[k] {
			g.Entries = append(g.Entries, gcEntry{Key: k, Due: due})
			seen[k] = true
		}
	}
	return g.save()
}

// collect deletes the objects that are due.
func (g *gcList) collect(r *r2Archive) error {
	now := time.Now()
	var keep []gcEntry
	var due []string
	for _, e := range g.Entries {
		if e.Due.After(now) {
			keep = append(keep, e)
		} else {
			due = append(due, e.Key)
		}
	}
	if len(due) == 0 {
		return nil
	}
	sort.Strings(due)
	for start := 0; start < len(due); start += 1000 {
		batch := due[start:min(start+1000, len(due))]
		objs := make([]types.ObjectIdentifier, len(batch))
		for i, k := range batch {
			objs[i] = types.ObjectIdentifier{Key: aws.String(k)}
		}
		out, err := r.client.DeleteObjects(context.Background(), &s3.DeleteObjectsInput{Bucket: &r.bucket,
			Delete: &types.Delete{Objects: objs, Quiet: aws.Bool(true)}})
		if err != nil {
			return fmt.Errorf("delete unreferenced objects: %w", err)
		}
		if len(out.Errors) > 0 {
			return fmt.Errorf("delete %s: %s", aws.ToString(out.Errors[0].Key), aws.ToString(out.Errors[0].Message))
		}
	}
	fmt.Fprintf(os.Stderr, "{\"gc_deleted\":%d}\n", len(due))
	g.Entries = keep
	return g.save()
}
