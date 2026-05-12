package dashboard

import (
	"testing"
	"time"
)

func sampleResults() map[string]pollResult {
	return map[string]pollResult{
		"node-a": {
			addr: nodeAddr{ID: "node-a", Host: "10.0.0.1", HTTPPort: 18080, Enclave: "default"},
			status: statusResponse{
				NodeID:     "node-a",
				Enclave:    "default",
				Uptime:     "1h",
				Goroutines: 53,
			},
			peers: []peerEntry{
				{ID: "node-b", Address: "10.0.0.2", HTTPPort: 18080, Enclave: "default"},
			},
			metrics: NodeMetrics{PeerJoinsTotal: 5, PeerEvictionsTotal: 1, PingFailuresTotal: 3},
		},
		"node-b": {
			addr: nodeAddr{ID: "node-b", Host: "10.0.0.2", HTTPPort: 18080, Enclave: "default"},
			status: statusResponse{
				NodeID:     "node-b",
				Enclave:    "default",
				Uptime:     "30m",
				Goroutines: 47,
			},
			peers: []peerEntry{
				{ID: "node-a", Address: "10.0.0.1", HTTPPort: 18080, Enclave: "default"},
			},
			metrics: NodeMetrics{PeerJoinsTotal: 4},
		},
	}
}

func TestBuilderStripsAddressesAndDerivesIsRoot(t *testing.T) {
	b := NewBuilder(nil, nil)
	roots := map[string]bool{"10.0.0.1:18080": true}
	snap := b.Build(BuildInput{
		Results: sampleResults(),
		Roots:   roots,
		Now:     time.Now(),
	})

	if len(snap.Nodes) != 2 {
		t.Fatalf("expected 2 nodes, got %d", len(snap.Nodes))
	}
	// Canonicalize sorts alphabetically — node-a is first.
	if snap.Nodes[0].ID != "node-a" || !snap.Nodes[0].IsRoot {
		t.Errorf("node-a should be the root: %+v", snap.Nodes[0])
	}
	if snap.Nodes[1].ID != "node-b" || snap.Nodes[1].IsRoot {
		t.Errorf("node-b should not be root: %+v", snap.Nodes[1])
	}
	if snap.Stats.RootsReachable != 1 {
		t.Errorf("RootsReachable should be 1, got %d", snap.Stats.RootsReachable)
	}
	if snap.Nodes[0].UptimeSeconds != 3600 {
		t.Errorf("uptime parse failed: got %d", snap.Nodes[0].UptimeSeconds)
	}
}

func TestBuilderEdgesAreDirectionalAndPreserveAsymmetry(t *testing.T) {
	// Drop node-b's awareness of node-a, leaving an asymmetric edge.
	results := sampleResults()
	r := results["node-b"]
	r.peers = nil
	results["node-b"] = r

	b := NewBuilder(nil, nil)
	snap := b.Build(BuildInput{
		Results: results,
		Roots:   map[string]bool{},
		Now:     time.Now(),
	})

	var fromA, fromB int
	for _, e := range snap.Edges {
		if e.From == "node-a" && e.To == "node-b" {
			fromA++
		}
		if e.From == "node-b" && e.To == "node-a" {
			fromB++
		}
	}
	if fromA != 1 || fromB != 0 {
		t.Errorf("expected only the node-a→node-b edge to survive, got fromA=%d fromB=%d", fromA, fromB)
	}
}

func TestBuilderGoroutinesAreRoundedToNearestTen(t *testing.T) {
	b := NewBuilder(nil, nil)
	results := sampleResults()
	r := results["node-a"]
	r.status.Goroutines = 47 // expected to round to 50
	results["node-a"] = r
	snap := b.Build(BuildInput{Results: results, Roots: map[string]bool{}, Now: time.Now()})
	for _, n := range snap.Nodes {
		if n.ID == "node-a" && n.GoroutinesApprox != 50 {
			t.Errorf("expected goroutines_approx=50, got %d", n.GoroutinesApprox)
		}
	}
}

func TestBuilderSeedOverridePropagates(t *testing.T) {
	b := NewBuilder(nil, nil)
	snap := b.Build(BuildInput{
		Results:      sampleResults(),
		Roots:        map[string]bool{"10.0.0.1:18080": true},
		SeedOverride: true,
		Now:          time.Now(),
	})
	if !snap.SeedOverride {
		t.Error("SeedOverride should propagate to snapshot")
	}
}

func TestParseUptimeHandlesEmpty(t *testing.T) {
	if parseUptime("") != 0 {
		t.Error("empty uptime should parse to 0")
	}
	if parseUptime("not-a-duration") != 0 {
		t.Error("garbage uptime should parse to 0")
	}
	if got := parseUptime("2h30m"); got != 9000 {
		t.Errorf("2h30m should be 9000s, got %d", got)
	}
}

func TestRoundToNearest(t *testing.T) {
	cases := []struct{ in, bucket, want int }{
		{47, 10, 50},
		{44, 10, 40},
		{45, 10, 50}, // banker's-style rounds half-up here
		{0, 10, 0},
		{7, 1, 7},
	}
	for _, c := range cases {
		if got := roundToNearest(c.in, c.bucket); got != c.want {
			t.Errorf("roundToNearest(%d, %d) = %d, want %d", c.in, c.bucket, got, c.want)
		}
	}
}
