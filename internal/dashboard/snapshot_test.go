package dashboard

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSnapshotRoundtripPreservesFields(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 5, 12, 19, 0, 0, 0, time.UTC)
	original := &Snapshot{
		GeneratedAt:        now,
		Stale:              false,
		RootsUnreachable:   true,
		OmegaRefreshFailed: false,
		SeedOverride:       false,
		Stats: Stats{
			Nodes:               2,
			Enclaves:            1,
			RootsReachable:      0,
			OldestUptimeSeconds: 100,
		},
		Nodes: []Node{
			{ID: "node-b", Enclave: "default", Region: "US", UptimeSeconds: 50, HeapMB: 12.5},
			{ID: "node-a", Enclave: "default", Region: "US", UptimeSeconds: 100, IsRoot: true},
		},
		Edges: []Edge{
			{From: "node-a", To: "node-b"},
			{From: "node-b", To: "node-a"},
		},
	}

	if err := SaveSnapshot(dir, original); err != nil {
		t.Fatalf("save: %v", err)
	}

	loaded, err := LoadSnapshot(dir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if loaded == nil {
		t.Fatal("load returned nil after save")
	}
	if !loaded.LoadedFromDisk {
		t.Error("LoadedFromDisk should be set on load")
	}
	if !loaded.Stale {
		t.Error("Stale should be set on load (a disk-loaded snapshot is always stale)")
	}
	if loaded.RootsUnreachable != true {
		t.Error("RootsUnreachable lost through roundtrip")
	}
	if len(loaded.Nodes) != 2 || loaded.Nodes[0].ID != "node-a" {
		t.Errorf("canonical sort not preserved: %+v", loaded.Nodes)
	}
}

func TestLoadSnapshotAbsentReturnsNilNil(t *testing.T) {
	dir := t.TempDir()
	s, err := LoadSnapshot(dir)
	if err != nil {
		t.Fatalf("unexpected error on absent snapshot: %v", err)
	}
	if s != nil {
		t.Fatal("expected nil snapshot on absent file")
	}
}

func TestSaveSnapshotAtomicLeavesPriorIntactOnFailure(t *testing.T) {
	// Simulate a partial write by creating a snapshot, then attempting a
	// second save with a path conflict. The first one must remain intact.
	dir := t.TempDir()
	first := &Snapshot{
		GeneratedAt: time.Now(),
		Stats:       Stats{Nodes: 1},
		Nodes:       []Node{{ID: "alpha"}},
	}
	if err := SaveSnapshot(dir, first); err != nil {
		t.Fatalf("first save: %v", err)
	}
	// Take the directory off-writable to force a SaveSnapshot failure.
	// (This won't simulate a torn write per se, but verifies the
	// existing file is still parseable after a failed save.)
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Skipf("could not chmod test dir: %v", err)
	}
	defer os.Chmod(dir, 0o755)

	second := &Snapshot{GeneratedAt: time.Now(), Nodes: []Node{{ID: "beta"}}}
	_ = SaveSnapshot(dir, second) // expected to fail; we don't assert how

	loaded, err := LoadSnapshot(dir)
	if err != nil {
		t.Fatalf("load after failed save: %v", err)
	}
	if loaded == nil || len(loaded.Nodes) != 1 || loaded.Nodes[0].ID != "alpha" {
		t.Errorf("prior snapshot was lost: %+v", loaded)
	}
	_ = filepath.Glob // keep import
}
