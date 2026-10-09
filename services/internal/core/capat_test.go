package core

import "testing"

// A pointer past the daemon's head (the node finalized beyond it while the daemon catches up)
// is reported as the head, not dropped; at or below the head it is kept.
func TestCapAt(t *testing.T) {
	head := &BlockID{Number: 100, Hash: "0xhead"}
	if got := capAt(&BlockID{Number: 150, Hash: "0xfin"}, head); got == nil || *got != *head {
		t.Fatalf("pointer above the head: got %+v, want the head", got)
	}
	if got := capAt(&BlockID{Number: 90, Hash: "0xfin"}, head); got == nil || got.Number != 90 || got.Hash != "0xfin" {
		t.Fatalf("pointer below the head: got %+v, want it unchanged", got)
	}
	if capAt(nil, head) != nil || capAt(&BlockID{Number: 1}, nil) != nil {
		t.Fatal("a missing pointer or head must stay missing")
	}
	// The result is a copy: changing it must not change the head.
	got := capAt(&BlockID{Number: 150}, head)
	got.Number = 1
	if head.Number != 100 {
		t.Fatal("capAt returned the head itself")
	}
}
