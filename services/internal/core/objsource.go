package core

// Read access to a published archive's objects: a local tree or the bucket
// (range reads), for extend mode. Reads of layer pages are cached.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type objectSource interface {
	// get returns a whole object; errNoObject when absent.
	get(key string) ([]byte, error)
	// getRange returns length bytes at offset.
	getRange(key string, offset, length uint64) ([]byte, error)
}

var errNoObject = errors.New("object not found")

type localSource struct{ archive localArchive }

func (s localSource) get(key string) ([]byte, error) {
	data, err := os.ReadFile(s.archive.path(key))
	if errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("%s: %w", key, errNoObject)
	}
	return data, err
}

func (s localSource) getRange(key string, offset, length uint64) ([]byte, error) {
	f, err := os.Open(s.archive.path(key))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	buf := make([]byte, length)
	if _, err := f.ReadAt(buf, int64(offset)); err != nil && !(errors.Is(err, io.EOF) && length == 0) {
		return nil, fmt.Errorf("%s@%d: %w", key, offset, err)
	}
	return buf, nil
}

type s3Source struct {
	client *s3.Client
	bucket string
}

func (s s3Source) get(key string) ([]byte, error) {
	data, _, err := s.getWithETag(key)
	return data, err
}

// getWithETag also returns the object's ETag (for a conditional HEAD update).
func (s s3Source) getWithETag(key string) ([]byte, string, error) {
	var lastErr error
	for attempt := range 5 {
		out, err := s.client.GetObject(context.Background(), &s3.GetObjectInput{Bucket: &s.bucket, Key: &key})
		if err != nil {
			var missing *types.NoSuchKey
			if errors.As(err, &missing) {
				return nil, "", fmt.Errorf("%s: %w", key, errNoObject)
			}
			lastErr = err
			sleepRetry(attempt)
			continue
		}
		data, err := io.ReadAll(out.Body)
		out.Body.Close()
		if err != nil {
			lastErr = err
			sleepRetry(attempt)
			continue
		}
		return data, aws.ToString(out.ETag), nil
	}
	return nil, "", fmt.Errorf("get %s: %w", key, lastErr)
}

func (s s3Source) getRange(key string, offset, length uint64) ([]byte, error) {
	if length == 0 {
		return nil, nil
	}
	rng := fmt.Sprintf("bytes=%d-%d", offset, offset+length-1)
	var lastErr error
	for attempt := range 5 {
		out, err := s.client.GetObject(context.Background(), &s3.GetObjectInput{Bucket: &s.bucket, Key: &key, Range: &rng})
		if err != nil {
			lastErr = err
			sleepRetry(attempt)
			continue
		}
		data, err := io.ReadAll(out.Body)
		out.Body.Close()
		if err == nil && uint64(len(data)) != length {
			err = fmt.Errorf("short range read (%d of %d bytes)", len(data), length)
		}
		if err != nil {
			lastErr = err
			sleepRetry(attempt)
			continue
		}
		return data, nil
	}
	return nil, fmt.Errorf("get %s %s: %w", key, rng, lastErr)
}

func sleepRetry(attempt int) {
	if attempt < 4 {
		time.Sleep(time.Duration(attempt+1) * uploadRetryDelay)
	}
}

// frameCache keeps decompressed frames (index and data pages) by
// key@offset, up to a byte budget (cleared wholesale when full).
type frameCache struct {
	mu    sync.Mutex
	m     map[string][]byte
	bytes int
	limit int
}

func newFrameCache(limit int) *frameCache {
	return &frameCache{m: map[string][]byte{}, limit: limit}
}

func (c *frameCache) get(id string) ([]byte, bool) {
	if c == nil {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.m[id]
	return v, ok
}

func (c *frameCache) put(id string, v []byte) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.bytes+len(v) > c.limit {
		c.m, c.bytes = map[string][]byte{}, 0
	}
	c.m[id] = v
	c.bytes += len(v)
}
