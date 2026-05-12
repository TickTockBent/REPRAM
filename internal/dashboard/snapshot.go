package dashboard

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// SnapshotFileName is the on-disk name for the persisted snapshot. Stored
// next to the omega cache under the dashboard state dir so a restart serves
// the prior snapshot immediately instead of blanking for one poll cycle.
const SnapshotFileName = "snapshot.json"

// NodeMetrics is the per-node counter set lifted from /v1/metrics. Totals
// since the node booted — never rates. See the dashboard design (issue #16)
// for why the UI deliberately does not render rates even though they are
// trivially derivable.
type NodeMetrics struct {
	PeerJoinsTotal     uint64 `json:"peer_joins_total"`
	PeerEvictionsTotal uint64 `json:"peer_evictions_total"`
	PingFailuresTotal  uint64 `json:"ping_failures_total"`
}

// Node is the per-node snapshot record after stripping addresses. The
// dashboard process keeps the address-to-id mapping in memory only; what
// reaches /api/snapshot is the metadata projection below.
type Node struct {
	ID               string      `json:"id"`
	Enclave          string      `json:"enclave"`
	Region           string      `json:"region"`
	UptimeSeconds    int64       `json:"uptime_seconds"`
	HeapMB           float64     `json:"heap_mb"`
	GoroutinesApprox int         `json:"goroutines_approx"`
	IsRoot           bool        `json:"is_root"`
	Unreachable      bool        `json:"unreachable"`
	Metrics          NodeMetrics `json:"metrics"`
}

// Edge encodes a single directed peer-awareness relationship as observed at
// poll time. Symmetric pairs (both directions present) indicate fully-
// converged peer awareness; asymmetric pairs surface mid-sync convergence
// or partial partitions as a deliberately visible debug signal — see #36.
type Edge struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// Stats is the cluster-aggregate projection rendered in the header strip.
type Stats struct {
	Nodes               int        `json:"nodes"`
	Enclaves            int        `json:"enclaves"`
	RootsReachable      int        `json:"roots_reachable"`
	OldestUptimeSeconds int64      `json:"oldest_uptime_seconds"`
	OmegaRefreshedAt    *time.Time `json:"omega_refreshed_at,omitempty"`
	OmegaExpiresAt      *time.Time `json:"omega_expires_at,omitempty"`
}

// Snapshot is the full payload served from /api/snapshot. Addresses have
// already been stripped by the builder. Flags are documented inline on the
// fields below.
type Snapshot struct {
	GeneratedAt time.Time `json:"generated_at"`

	// Stale: snapshot is older than the poll interval (pre-first-poll
	// on startup, or all nodes were unreachable in the last cycle).
	Stale bool `json:"stale"`

	// LoadedFromDisk: snapshot was loaded from snapshot.json at startup
	// and no fresh poll has completed yet.
	LoadedFromDisk bool `json:"loaded_from_disk"`

	// RootsUnreachable: every root in the current omega cache failed
	// during the last poll cycle. The dashboard remains useful via
	// non-root peer queries; N consecutive cycles trigger a DNS refresh.
	RootsUnreachable bool `json:"roots_unreachable"`

	// OmegaRefreshFailed: the most recently triggered omega refresh
	// failed (DNS down, signature invalid, etc.). Distinct from
	// RootsUnreachable; the two can be true independently.
	OmegaRefreshFailed bool `json:"omega_refresh_failed"`

	// SeedOverride: dashboard booted from --seeds rather than the omega
	// trust chain. UI surfaces this as a "trust chain bypassed" banner.
	SeedOverride bool `json:"seed_override"`

	Stats Stats  `json:"stats"`
	Nodes []Node `json:"nodes"`
	Edges []Edge `json:"edges"`
}

// Canonicalize sorts nodes and edges into a deterministic order so callers
// (tests, diff tools, the frontend's render path) see stable output even
// when the underlying maps the builder iterates are unordered.
func (s *Snapshot) Canonicalize() {
	sort.Slice(s.Nodes, func(i, j int) bool { return s.Nodes[i].ID < s.Nodes[j].ID })
	sort.Slice(s.Edges, func(i, j int) bool {
		if s.Edges[i].From != s.Edges[j].From {
			return s.Edges[i].From < s.Edges[j].From
		}
		return s.Edges[i].To < s.Edges[j].To
	})
}

// LoadSnapshot reads a persisted snapshot from $dir/snapshot.json. Returns
// (nil, nil) when the file is absent — that is the normal first-run case.
// The returned snapshot has LoadedFromDisk and Stale set so the caller can
// serve it immediately while waiting for the first fresh poll.
func LoadSnapshot(dir string) (*Snapshot, error) {
	path := filepath.Join(dir, SnapshotFileName)
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("read snapshot %s: %w", path, err)
	}
	var s Snapshot
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, fmt.Errorf("parse snapshot %s: %w", path, err)
	}
	s.LoadedFromDisk = true
	s.Stale = true
	return &s, nil
}

// SaveSnapshot writes the snapshot atomically: write to a temp file in the
// same directory, fsync, rename into place. A power loss mid-write leaves
// the prior snapshot intact. 0644 perms because the contents are
// public-info-equivalent (they are what the dashboard serves anyway).
//
// Canonicalizes before writing so disk diffs and roundtrips are stable.
func SaveSnapshot(dir string, s *Snapshot) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir state dir %s: %w", dir, err)
	}
	s.Canonicalize()
	payload, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal snapshot: %w", err)
	}
	tmp, err := os.CreateTemp(dir, SnapshotFileName+".*.tmp")
	if err != nil {
		return fmt.Errorf("create temp snapshot file: %w", err)
	}
	tmpPath := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()
	if _, err := tmp.Write(payload); err != nil {
		tmp.Close()
		return fmt.Errorf("write temp snapshot: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("fsync temp snapshot: %w", err)
	}
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		return fmt.Errorf("chmod temp snapshot: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp snapshot: %w", err)
	}
	if err := os.Rename(tmpPath, filepath.Join(dir, SnapshotFileName)); err != nil {
		return fmt.Errorf("rename snapshot: %w", err)
	}
	cleanup = false
	return nil
}
