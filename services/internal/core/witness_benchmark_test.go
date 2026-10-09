package core

import (
	"math"
	"reflect"
	"testing"
)

func TestWitnessBenchmarkPreservesWorkAcrossWorkerCounts(t *testing.T) {
	// A short benchmark must keep the production overlay lifetime even when that
	// leaves workers idle. Otherwise a worker sweep also measures different caches.
	const from, to = 21_000_000, 21_009_999
	want := witnessJobs([][2]uint64{{from, from + 8191}, {from + 8192, to}}, witnessRun)
	for _, workers := range []int{1, 8, 64, 256} {
		got, err := witnessBenchmarkJobs(from, to, witnessRun, workers)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%d workers changed the production runs: got %+v, want %+v", workers, got, want)
		}
	}
}

func TestWitnessBenchmarkRunOverride(t *testing.T) {
	jobs, err := witnessBenchmarkJobs(100, 132, 16, 64)
	if err != nil {
		t.Fatal(err)
	}
	want := []witnessJob{{seg: 0, first: 100, last: 115}, {seg: 0, first: 116, last: 131}, {seg: 0, first: 132, last: 132}}
	if !reflect.DeepEqual(jobs, want) {
		t.Fatalf("explicit run size: got %+v, want %+v", jobs, want)
	}
}

func TestWitnessBenchmarkMaximumRange(t *testing.T) {
	// The highest accepted range still splits into valid, consecutive runs without
	// wrapping its block numbers or the loop increment after its final segment.
	const to = math.MaxUint64 - 8192
	jobs, err := witnessBenchmarkJobs(to-32, to, 16, 1)
	if err != nil {
		t.Fatal(err)
	}
	want := []witnessJob{{seg: 0, first: to - 32, last: to - 17}, {seg: 0, first: to - 16, last: to - 1}, {seg: 0, first: to, last: to}}
	if !reflect.DeepEqual(jobs, want) {
		t.Fatalf("maximum range: got %+v, want %+v", jobs, want)
	}
}

func TestWitnessBenchmarkRejectsInvalidOptions(t *testing.T) {
	for _, tc := range []struct {
		name          string
		from, to, run uint64
		workers       int
	}{
		{name: "reversed range", from: 20, to: 10, run: witnessRun, workers: 1},
		{name: "zero workers", from: 10, to: 20, run: witnessRun, workers: 0},
		{name: "negative workers", from: 10, to: 20, run: witnessRun, workers: -1},
		{name: "zero run", from: 10, to: 20, run: 0, workers: 1},
		{name: "run exceeds segment", from: 10, to: 20, run: 8193, workers: 1},
		{name: "range without arithmetic headroom", from: math.MaxUint64 - 8191, to: math.MaxUint64 - 8191, run: witnessRun, workers: 1},
		{name: "maximum uint64 block", from: math.MaxUint64, to: math.MaxUint64, run: witnessRun, workers: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			jobs, err := witnessBenchmarkJobs(tc.from, tc.to, tc.run, tc.workers)
			if err == nil || jobs != nil {
				t.Fatalf("invalid options produced jobs: %+v, err: %v", jobs, err)
			}
		})
	}
}
