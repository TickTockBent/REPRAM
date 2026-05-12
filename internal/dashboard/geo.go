package dashboard

import (
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"sync"
)

// Geo resolves IP addresses to a coarse region label (country ISO code).
// The lookup is deliberately country-granular: matches the design goal of
// "broad regional boundaries" and avoids leaking placement detail. When the
// database is absent or a lookup misses, Region returns "?".
//
// The implementation is intentionally pluggable so the binary builds and
// runs without a GeoLite2 database present — operators add the database via
// the Makefile target, and the dashboard hot-reloads it on SIGHUP.
type Geo struct {
	mu   sync.RWMutex
	impl geoLookup
}

type geoLookup interface {
	Country(net.IP) string
	Close() error
}

// NewGeo constructs a lookup. dbPath may be empty (no database loaded — all
// lookups return "?"). Loading errors are returned so the caller can decide
// whether to log-and-continue or fail; the dashboard chooses log-and-continue.
func NewGeo(dbPath string) (*Geo, error) {
	g := &Geo{impl: noopLookup{}}
	if dbPath == "" {
		return g, nil
	}
	impl, err := openMMDB(dbPath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return g, nil
		}
		return g, err
	}
	g.impl = impl
	return g, nil
}

// Region returns the ISO country code for ip, or "?" if no database is
// loaded, the lookup misses, or ip is nil. Never returns an error so a
// snapshot build cannot be blocked by geo trouble.
func (g *Geo) Region(ip net.IP) string {
	if ip == nil {
		return "?"
	}
	g.mu.RLock()
	impl := g.impl
	g.mu.RUnlock()
	code := impl.Country(ip)
	if code == "" {
		return "?"
	}
	return code
}

// Reload swaps in a freshly-opened database. Called from the SIGHUP handler
// to pick up an updated GeoLite2 file without restarting the dashboard.
// If the new database fails to open, the old one is retained and the error
// is returned so the caller can log it.
func (g *Geo) Reload(dbPath string) error {
	if dbPath == "" {
		g.mu.Lock()
		old := g.impl
		g.impl = noopLookup{}
		g.mu.Unlock()
		if old != nil {
			_ = old.Close()
		}
		return nil
	}
	impl, err := openMMDB(dbPath)
	if err != nil {
		return fmt.Errorf("reload geo db %s: %w", dbPath, err)
	}
	g.mu.Lock()
	old := g.impl
	g.impl = impl
	g.mu.Unlock()
	if old != nil {
		_ = old.Close()
	}
	return nil
}

// Close releases the underlying database handle. Safe to call multiple times.
func (g *Geo) Close() error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.impl == nil {
		return nil
	}
	err := g.impl.Close()
	g.impl = noopLookup{}
	return err
}

type noopLookup struct{}

func (noopLookup) Country(net.IP) string { return "" }
func (noopLookup) Close() error          { return nil }

// openMMDB is replaced at build time when the maxminddb dependency is
// vendored (see geo_mmdb.go behind a build tag). Until then this stub
// returns os.ErrNotExist so NewGeo treats "no db path" and "no impl"
// the same way: log-and-continue.
//
// This indirection keeps the dashboard buildable without an immediate
// hard dependency on github.com/oschwald/maxminddb-golang. Phase 2 of
// the implementation wires it up properly.
var openMMDB = func(path string) (geoLookup, error) {
	if _, err := os.Stat(path); err != nil {
		return nil, err
	}
	// File exists but no mmdb impl is compiled in. Surface that as a
	// distinct error so an operator who shipped a db file but built
	// without the geo tag isn't left guessing.
	return nil, errors.New("geo: mmdb support not compiled in (build with -tags geo)")
}
