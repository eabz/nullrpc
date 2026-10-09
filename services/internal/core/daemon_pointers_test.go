package core

import (
	"encoding/json"
	"testing"
	"time"
)

func TestLivePointersDocument(t *testing.T) {
	d := &daemon{}
	head := BlockID{Number: 120, Hash: "0xaa"}
	safe := BlockID{Number: 100, Hash: "0xbb"}
	fin := BlockID{Number: 130, Hash: "0xcc"} // the node's finalized block can be above the live head while catching up
	p := BlockID{Number: 64, Hash: "0xdd"}
	d.liveHead.Store(&head)
	d.safe.Store(&safe)
	d.finalized.Store(&fin)
	d.promoted.Store(&p)
	d.generation.Store(7)
	at := time.Date(2026, 10, 9, 12, 0, 0, 500_000_000, time.UTC)
	data, err := json.Marshal(d.pointers(at))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"version":    float64(1),
		"head":       map[string]any{"number": float64(120), "hash": "0xaa"},
		"safe":       map[string]any{"number": float64(100), "hash": "0xbb"},
		// Finalized past the head (the daemon catching up): reported as the head.
		"finalized":  map[string]any{"number": float64(120), "hash": "0xaa"},
		"promoted":   map[string]any{"number": float64(64), "hash": "0xdd"},
		"generation": float64(7),
		"written_at": "2026-10-09T12:00:00.5Z",
	}
	if len(got) != len(want) {
		t.Fatalf("keys: got %v", got)
	}
	for k, v := range want {
		if g, _ := json.Marshal(got[k]); string(g) != string(must(json.Marshal(v))) {
			t.Errorf("%s: got %s, want %s", k, g, must(json.Marshal(v)))
		}
	}
	// The pointers go through as the Worker's LiveState reads them.
	var back livePointers
	if err := json.Unmarshal(data, &back); err != nil || *back.Head != head || back.Finalized == nil || *back.Finalized != head || *back.Promoted != p {
		t.Fatalf("round trip: %+v, %v", back, err)
	}
}

func TestPublishPointersWithoutR2(t *testing.T) {
	// Without a bucket (tests, dry runs) publishing is a no-op rather than a panic.
	d := &daemon{}
	d.publishPointers()
}

func must(b []byte, err error) []byte {
	if err != nil {
		panic(err)
	}
	return b
}
