package dashboard

import (
	"math"
	"net"
	"strconv"
	"time"
)

// Builder converts poll results into a Snapshot. The roots set comes from
// either the cached omega signed list or the operator --seeds flag; the
// builder doesn't care which, but the Snapshot's SeedOverride flag carries
// the distinction forward to the UI.
//
// The builder is stateless between calls — Build takes everything it needs
// as arguments. State that survives cycles (e.g. consecutive-miss counters
// for the unreachable-then-drop policy) lives in the orchestrator above.
type Builder struct {
	Geo *Geo
}

// NewBuilder constructs a builder. geo may be nil; in that case every node
// gets Region="?".
func NewBuilder(geo *Geo) *Builder {
	return &Builder{Geo: geo}
}

// BuildInput bundles everything Build needs that varies per cycle. Kept as
// a struct rather than positional args so future additions don't ripple
// through call sites.
type BuildInput struct {
	// Results from the poller, keyed by node ID.
	Results map[string]pollResult

	// Roots is the set of "host:port" advertised addresses the dashboard
	// considers roots — derived from the omega cache, or from --seeds
	// when running in seed-override mode.
	Roots map[string]bool

	// SeedOverride flips when the dashboard booted from --seeds instead
	// of the omega trust chain. Surfaced in the snapshot as a banner.
	SeedOverride bool

	// RootsUnreachable is set by the orchestrator after one full poll
	// cycle in which no root responded. The builder does not infer it;
	// the orchestrator owns the consecutive-miss accounting.
	RootsUnreachable bool

	// OmegaRefreshFailed tracks the outcome of the most recent omega
	// refresh attempt. Distinct from RootsUnreachable: a refresh can
	// fail (DNS down) while roots are still reachable on cached info.
	OmegaRefreshFailed bool

	// OmegaRefreshedAt is when the cached omega list was last
	// successfully fetched. Nil if running in seed-override mode.
	OmegaRefreshedAt *time.Time

	// OmegaExpiresAt is when the cached omega list's signature expires.
	// Nil if running in seed-override mode.
	OmegaExpiresAt *time.Time

	// Now is the build clock — injectable for tests. Use time.Now() in
	// production callers.
	Now time.Time
}

// Build produces a Snapshot from one cycle's poll results. Addresses are
// stripped here — once Build returns, no address information leaks into
// the snapshot's public projection.
func (b *Builder) Build(in BuildInput) *Snapshot {
	s := &Snapshot{
		GeneratedAt:        in.Now,
		RootsUnreachable:   in.RootsUnreachable,
		OmegaRefreshFailed: in.OmegaRefreshFailed,
		SeedOverride:       in.SeedOverride,
		Stats: Stats{
			OmegaRefreshedAt: in.OmegaRefreshedAt,
			OmegaExpiresAt:   in.OmegaExpiresAt,
		},
		Nodes: make([]Node, 0, len(in.Results)),
		Edges: make([]Edge, 0, len(in.Results)*2),
	}

	// First pass: build a host:port → node ID index so the BFS's peer
	// edges (which carry addresses) can be projected onto IDs in the
	// final snapshot.
	idByAddr := make(map[string]string, len(in.Results))
	for id, r := range in.Results {
		if r.addr.Host == "" || r.addr.HTTPPort == 0 {
			continue
		}
		idByAddr[r.addr.HostPort()] = id
	}

	enclaves := map[string]struct{}{}
	rootsReachable := 0
	var oldestUptime int64

	for id, r := range in.Results {
		uptimeSeconds := parseUptime(r.status.Uptime)
		heapMB := float64(r.status.Memory.Alloc) / (1024 * 1024)

		node := Node{
			ID:               id,
			Enclave:          r.addr.Enclave,
			Region:           "?",
			UptimeSeconds:    uptimeSeconds,
			HeapMB:           roundFloat(heapMB, 2),
			GoroutinesApprox: roundToNearest(r.status.Goroutines, 10),
			IsRoot:           in.Roots[r.addr.HostPort()],
			Unreachable:      r.unreachable,
			Metrics:          r.metrics,
		}

		if node.Enclave == "" && r.status.Enclave != "" {
			node.Enclave = r.status.Enclave
		}

		if b.Geo != nil && r.addr.Host != "" {
			if ip := net.ParseIP(r.addr.Host); ip != nil {
				node.Region = b.Geo.Region(ip)
			}
		}

		if node.Enclave != "" {
			enclaves[node.Enclave] = struct{}{}
		}

		if node.IsRoot && !node.Unreachable {
			rootsReachable++
		}

		if uptimeSeconds > oldestUptime {
			oldestUptime = uptimeSeconds
		}

		s.Nodes = append(s.Nodes, node)

		// Emit one directional edge per (this node, peer-it-lists).
		// We deliberately do NOT collapse symmetric pairs — the UI
		// renders symmetric edges solid and asymmetric ones dashed.
		// Asymmetry is a real debug signal during sync convergence.
		for _, peer := range r.peers {
			peerKey := net.JoinHostPort(peer.Address, strconv.Itoa(peer.HTTPPort))
			peerID := peer.ID
			if mapped, ok := idByAddr[peerKey]; ok {
				peerID = mapped
			}
			if peerID == "" || peerID == id {
				continue
			}
			s.Edges = append(s.Edges, Edge{From: id, To: peerID})
		}
	}

	s.Stats.Nodes = len(s.Nodes)
	s.Stats.Enclaves = len(enclaves)
	s.Stats.RootsReachable = rootsReachable
	s.Stats.OldestUptimeSeconds = oldestUptime

	s.Canonicalize()
	return s
}

// parseUptime accepts the time.Duration string format that /v1/status
// emits (e.g. "73h4m59.27s") and returns whole seconds. Unparseable input
// returns 0; the snapshot publishes a zero uptime rather than failing.
func parseUptime(s string) int64 {
	if s == "" {
		return 0
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0
	}
	return int64(d.Seconds())
}

func roundFloat(v float64, decimals int) float64 {
	shift := math.Pow(10, float64(decimals))
	return math.Round(v*shift) / shift
}

// roundToNearest implements the goroutines-rounded-to-nearest-10 guardrail.
// The absolute count rarely matters and the noise is real, so coarsening
// reduces the side-channel surface for negligible cost.
func roundToNearest(v, bucket int) int {
	if bucket <= 1 {
		return v
	}
	return ((v + bucket/2) / bucket) * bucket
}

