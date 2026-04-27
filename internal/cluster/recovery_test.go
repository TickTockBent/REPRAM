package cluster

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// TestCheckIsolationAndRecover_HappyPath drives the recovery cycle
// directly with a node that has 0 peers and a seedProvider pointing at
// a live cluster. After one cycle the isolated node should have
// rejoined (#85, F5).
func TestCheckIsolationAndRecover_HappyPath(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Build a 2-node base cluster (A bootstrapping from B).
	a := newTestNode(t, "node-a", "default", 2)
	b := newTestNode(t, "node-b", "default", 2)
	defer a.stop()
	defer b.stop()

	a.start(t, ctx, nil) // first node
	b.start(t, ctx, []string{a.addr()})

	if err := waitFor(ctx, 2*time.Second, func() bool {
		return len(a.node.protocol.GetPeers()) == 1 && len(b.node.protocol.GetPeers()) == 1
	}); err != nil {
		t.Fatalf("base cluster failed to converge: %v", err)
	}

	// Spin up an isolated node C with a seedProvider pointing at A.
	c := newTestNode(t, "node-c", "default", 2)
	defer c.stop()
	c.start(t, ctx, nil) // start as isolated first node
	if got := len(c.node.protocol.GetPeers()); got != 0 {
		t.Fatalf("setup error: expected isolated node-c to have 0 peers, got %d", got)
	}

	c.node.SetSeedProvider(func() []string { return []string{a.addr(), b.addr()} })

	// Drive one recovery cycle directly.
	if !c.node.CheckIsolationAndRecover(ctx) {
		t.Fatal("CheckIsolationAndRecover returned false; expected re-bootstrap to recover peers")
	}

	got := len(c.node.protocol.GetPeers())
	if got < 1 {
		t.Fatalf("expected node-c to discover at least 1 peer after recovery, got %d", got)
	}
}

// TestCheckIsolationAndRecover_NoOpWithPeers verifies the recovery
// cycle does nothing when peers exist — the seed provider should not
// be consulted (#85, F5).
func TestCheckIsolationAndRecover_NoOpWithPeers(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	a := newTestNode(t, "node-a", "default", 2)
	b := newTestNode(t, "node-b", "default", 2)
	defer a.stop()
	defer b.stop()

	a.start(t, ctx, nil)
	b.start(t, ctx, []string{a.addr()})

	if err := waitFor(ctx, 2*time.Second, func() bool {
		return len(b.node.protocol.GetPeers()) == 1
	}); err != nil {
		t.Fatalf("base cluster failed to converge: %v", err)
	}

	var calls int32
	b.node.SetSeedProvider(func() []string {
		atomic.AddInt32(&calls, 1)
		return []string{a.addr()}
	})

	if b.node.CheckIsolationAndRecover(ctx) {
		t.Fatal("recovery should be a no-op when peers exist")
	}
	if got := atomic.LoadInt32(&calls); got != 0 {
		t.Fatalf("seedProvider called %d times; expected 0 — recovery should short-circuit on peer count", got)
	}
}

// TestCheckIsolationAndRecover_NoSeedProvider verifies that recovery is
// disabled when no seed provider is wired. The recovery cycle returns
// false without attempting bootstrap.
func TestCheckIsolationAndRecover_NoSeedProvider(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	a := newTestNode(t, "node-a", "default", 2)
	defer a.stop()
	a.start(t, ctx, nil)

	// No SetSeedProvider call; provider is nil.
	if a.node.CheckIsolationAndRecover(ctx) {
		t.Fatal("recovery should return false when no seedProvider is set")
	}
}

// TestCheckIsolationAndRecover_EmptySeeds verifies the recovery cycle
// short-circuits when the seed provider returns an empty list. This
// happens transiently in the public-network case if the omega refresher
// hasn't loaded a list yet.
func TestCheckIsolationAndRecover_EmptySeeds(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()

	a := newTestNode(t, "node-a", "default", 2)
	defer a.stop()
	a.start(t, ctx, nil)

	a.node.SetSeedProvider(func() []string { return nil })
	if a.node.CheckIsolationAndRecover(ctx) {
		t.Fatal("recovery should return false when seedProvider returns empty")
	}
}

// waitFor polls until predicate returns true or the timeout elapses.
func waitFor(ctx context.Context, timeout time.Duration, predicate func() bool) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		if predicate() {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !predicate() {
		return context.DeadlineExceeded
	}
	return nil
}
