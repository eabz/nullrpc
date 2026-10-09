package core

// Parallel R2 upload of the local archive tree. Every object except HEAD.json is immutable;
// existing objects with the same size are skipped, so an interrupted upload resumes.
// HEAD.json is written last with a conditional put.

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

func loadEnvFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		line := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(strings.TrimPrefix(s.Text(), "\ufeff")), "export "))
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			return fmt.Errorf("%s: expected KEY=VALUE, got %q", path, strings.SplitN(line, " ", 2)[0])
		}
		os.Setenv(strings.TrimSpace(k), strings.Trim(strings.TrimSpace(v), `"'`))
	}
	return s.Err()
}

// r2Client is the archive bucket: NULLRPC_R2_ENDPOINT, NULLRPC_R2_BUCKET,
// NULLRPC_R2_ACCESS_KEY_ID, NULLRPC_R2_SECRET_ACCESS_KEY.
func r2Client() (*s3.Client, string, error) { return s3ClientFor("NULLRPC_R2") }

func s3ClientFor(prefix string) (*s3.Client, string, error) {
	names := []string{prefix + "_ENDPOINT", prefix + "_BUCKET", prefix + "_ACCESS_KEY_ID", prefix + "_SECRET_ACCESS_KEY"}
	var missing []string
	for _, name := range names {
		if os.Getenv(name) == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return nil, "", fmt.Errorf("missing %s", strings.Join(missing, ", "))
	}
	endpoint, bucket := os.Getenv(names[0]), os.Getenv(names[1])
	key, secret := os.Getenv(names[2]), os.Getenv(names[3])
	if !strings.HasPrefix(endpoint, "https://") && !loopbackHTTP(endpoint) {
		return nil, "", fmt.Errorf("%s must be an https S3 endpoint", names[0])
	}
	client := s3.New(s3.Options{
		BaseEndpoint: aws.String(strings.TrimRight(endpoint, "/")),
		Region:       "auto",
		Credentials:  credentials.NewStaticCredentialsProvider(key, secret, ""),
		UsePathStyle: true,
		// R2 rejects the SDK's default checksum trailers.
		RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired,
		ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired,
	})
	return client, bucket, nil
}

// loopbackHTTP reports whether endpoint is plain http on this host (a local
// S3 server), never a remote bucket.
func loopbackHTTP(endpoint string) bool {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "http" {
		return false
	}
	switch u.Hostname() {
	case "127.0.0.1", "localhost", "::1":
		return true
	}
	return false
}

// uploadRetryDelay is the backoff step between attempts (a variable for tests).
var uploadRetryDelay = 2 * time.Second

// newUploader is the multipart uploader every stage uses.
func newUploader(client *s3.Client, partSize int64, partConcurrency int) *manager.Uploader {
	return manager.NewUploader(client, func(u *manager.Uploader) {
		u.PartSize = partSize
		u.Concurrency = partConcurrency
	})
}

// putFile uploads one immutable data object from path unless the bucket
// already holds an object of the same size under key (an earlier, resumed
// upload); one of a different size is an error. It reports whether it sent.
func putFile(ctx context.Context, client *s3.Client, uploader *manager.Uploader, bucket, key, path string, size int64) (bool, error) {
	if head, err := client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &bucket, Key: &key}); err == nil {
		if aws.ToInt64(head.ContentLength) != size {
			return false, fmt.Errorf("immutable object %s exists with a different size", key)
		}
		return false, nil
	}
	for attempt := 0; ; attempt++ {
		f, err := os.Open(path)
		if err != nil {
			return false, err
		}
		_, err = uploader.Upload(ctx, &s3.PutObjectInput{Bucket: &bucket, Key: &key, Body: f,
			ContentType: aws.String("application/octet-stream")})
		f.Close()
		if err == nil {
			return true, nil
		}
		if attempt == 4 {
			return false, fmt.Errorf("upload %s: %w", key, err)
		}
		time.Sleep(time.Duration(attempt+1) * uploadRetryDelay)
	}
}

// remoteSize returns the size of key in the bucket, and whether it exists.
func remoteSize(ctx context.Context, client *s3.Client, bucket, key string) (int64, bool, error) {
	for attempt := 0; ; attempt++ {
		head, err := client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &bucket, Key: &key})
		if err == nil {
			return aws.ToInt64(head.ContentLength), true, nil
		}
		var notFound *types.NotFound
		var noKey *types.NoSuchKey
		if errors.As(err, &notFound) || errors.As(err, &noKey) {
			return 0, false, nil
		}
		if attempt == 4 {
			return 0, false, fmt.Errorf("head %s: %w", key, err)
		}
		time.Sleep(time.Duration(attempt+1) * uploadRetryDelay)
	}
}

// upload sends every object of the local tree that R2 lacks, manifests after data, then
// HEAD.json with If-None-Match: *.
func upload(client *s3.Client, bucket string, archive localArchive, namespace string, parallel int, partSize int64, partConcurrency int, deleteAfter bool) error {
	ctx := context.Background()
	root := archive.path(namespace)
	type object struct {
		key  string
		path string
		size int64
	}
	var objects []object
	var total int64
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == ".tmp" || strings.HasSuffix(d.Name(), "-building") || strings.HasPrefix(d.Name(), ".") && p != root {
				return filepath.SkipDir
			}
			return nil
		}
		rel, _ := filepath.Rel(archive.root, p)
		key := filepath.ToSlash(rel)
		if key == namespace+"/HEAD.json" || strings.HasSuffix(key, ".tmp") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		objects = append(objects, object{key, p, info.Size()})
		total += info.Size()
		return nil
	})
	if err != nil {
		return err
	}
	// Manifests last among immutable objects, then HEAD.
	sort.SliceStable(objects, func(i, j int) bool {
		mi, mj := strings.Contains(objects[i].key, "/manifests/"), strings.Contains(objects[j].key, "/manifests/")
		if mi != mj {
			return !mi
		}
		return objects[i].size > objects[j].size
	})
	uploader := newUploader(client, partSize, partConcurrency)
	started := time.Now()
	var sent, skipped, doneBytes atomic.Int64
	var firstErr error
	var mu sync.Mutex
	work := make(chan object)
	var wg sync.WaitGroup
	for range parallel {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for o := range work {
				did, err := putFile(ctx, client, uploader, bucket, o.key, o.path, o.size)
				if err == nil && did {
					sent.Add(1)
				} else if err == nil {
					skipped.Add(1)
				}
				if err == nil && deleteAfter && !strings.Contains(o.key, "/manifests/") {
					err = os.Remove(o.path)
				}
				mu.Lock()
				if err != nil && firstErr == nil {
					firstErr = err
				}
				mu.Unlock()
				doneBytes.Add(o.size)
			}
		}()
	}
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	go func() {
		for range ticker.C {
			el := time.Since(started).Seconds()
			fmt.Fprintf(os.Stderr, "{\"uploaded_gb\":%.2f,\"total_gb\":%.2f,\"mb_per_s\":%.1f,\"objects_sent\":%d,\"objects_skipped\":%d}\n",
				float64(doneBytes.Load())/1e9, float64(total)/1e9, float64(doneBytes.Load())/el/1e6, sent.Load(), skipped.Load())
		}
	}()
	manifestsStart := len(objects)
	for i, o := range objects {
		if strings.Contains(o.key, "/manifests/") {
			manifestsStart = i
			break
		}
	}
	// Barrier: every data object is durable before any manifest is sent.
	for _, o := range objects[:manifestsStart] {
		work <- o
	}
	close(work)
	wg.Wait()
	if firstErr != nil {
		return firstErr
	}
	work = make(chan object)
	for range parallel {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for o := range work {
				data, err := os.ReadFile(o.path)
				if err == nil {
					err = putImmutable(ctx, client, bucket, o.key, data)
				}
				mu.Lock()
				if err != nil && firstErr == nil {
					firstErr = err
				}
				mu.Unlock()
			}
		}()
	}
	for _, o := range objects[manifestsStart:] {
		work <- o
	}
	close(work)
	wg.Wait()
	if firstErr != nil {
		return firstErr
	}
	head, err := os.ReadFile(archive.path(namespace + "/HEAD.json"))
	if err != nil {
		return fmt.Errorf("run publish first: %w", err)
	}
	headKey := namespace + "/HEAD.json"
	if err := putHead(ctx, client, bucket, headKey, head); err != nil {
		return err
	}
	fmt.Printf("{\"uploaded_gb\":%.2f,\"objects_sent\":%d,\"objects_skipped\":%d,\"seconds\":%.0f,\"head\":%q}\n",
		float64(total)/1e9, sent.Load(), skipped.Load(), time.Since(started).Seconds(), headKey)
	return nil
}

func putImmutable(ctx context.Context, client *s3.Client, bucket, key string, data []byte) error {
	_, err := client.PutObject(ctx, &s3.PutObjectInput{Bucket: &bucket, Key: &key,
		Body: strings.NewReader(string(data)), IfNoneMatch: aws.String("*")})
	if err == nil {
		return nil
	}
	// Already present: accept only identical bytes.
	out, gerr := client.GetObject(ctx, &s3.GetObjectInput{Bucket: &bucket, Key: &key})
	if gerr != nil {
		return fmt.Errorf("put %s: %w", key, err)
	}
	defer out.Body.Close()
	existing := make([]byte, 0, len(data))
	buf := make([]byte, 64<<10)
	for {
		n, rerr := out.Body.Read(buf)
		existing = append(existing, buf[:n]...)
		if rerr != nil {
			break
		}
	}
	if sha256Hex(existing) != sha256Hex(data) {
		return fmt.Errorf("immutable object collision at %s", key)
	}
	return nil
}

// putHead writes HEAD.json last with If-None-Match: *. A remote HEAD identical to the local
// one counts as published, so a run that stopped after writing it resumes cleanly; any other
// remote HEAD stops the run (the backfill writes generation 1 only).
func putHead(ctx context.Context, client *s3.Client, bucket, headKey string, head []byte) error {
	existing, err := client.GetObject(ctx, &s3.GetObjectInput{Bucket: &bucket, Key: &headKey})
	if err == nil {
		remote, rerr := io.ReadAll(existing.Body)
		existing.Body.Close()
		if rerr != nil {
			return rerr
		}
		if string(remote) == string(head) {
			fmt.Fprintf(os.Stderr, "%s is already published\n", headKey)
			return nil
		}
		return fmt.Errorf("%s already exists with other content; refusing to replace a published HEAD", headKey)
	}
	var missing *types.NoSuchKey
	if !errors.As(err, &missing) {
		return fmt.Errorf("read remote %s: %w", headKey, err)
	}
	put := &s3.PutObjectInput{Bucket: &bucket, Key: &headKey, Body: strings.NewReader(string(head)),
		ContentType: aws.String("application/json"), IfNoneMatch: aws.String("*")}
	if _, err := client.PutObject(ctx, put); err != nil {
		return fmt.Errorf("publish HEAD (conditional put fails if another writer published first): %w", err)
	}
	return nil
}
