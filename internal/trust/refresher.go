package trust

import (
	"context"
	"crypto/ed25519"
	"math/rand"
	"sync"
	"time"
)

// RefreshRotationFraction is the fraction of the remaining lifetime at which
// to wake and refresh. 0.9 means: sleep 90% of the way to expiration, so
// there's a 10% buffer to retry on failure before the list goes stale.
const RefreshRotationFraction = 0.9

// RefreshJitter is the symmetric ±jitter applied to the rotation deadline.
// Prevents synchronized thundering-herd refreshes across the network.
const RefreshJitter = 0.1

// RefreshBackoffMin is the initial retry delay after a failed refresh.
const RefreshBackoffMin = 30 * time.Second

// RefreshBackoffMax caps exponential backoff so a long outage doesn't leave
// the network with refresh delays of hours.
const RefreshBackoffMax = 10 * time.Minute

// Clock is a minimal clock abstraction so tests can drive refresh timing
// deterministically.
type Clock interface {
	Now() time.Time
	// After returns a channel that emits once after d. Tests can replace
	// this with a channel they control.
	After(d time.Duration) <-chan time.Time
}

// RealClock is time.Now()/time.After. Callers that don't need deterministic
// timing can pass this directly.
type RealClock struct{}

func (RealClock) Now() time.Time                         { return time.Now() }
func (RealClock) After(d time.Duration) <-chan time.Time { return time.After(d) }

// RefresherConfig bundles the knobs a Refresher needs. Fields left zero
// select sensible defaults.
type RefresherConfig struct {
	// Pubkey is the omega public key used to verify every new list.
	// Required.
	Pubkey ed25519.PublicKey

	// CacheDir is where the verified list is persisted. Defaults to
	// DefaultCacheDir().
	CacheDir string

	// DNS configures the resolver used to fetch new signed lists.
	DNS DNSConfig

	// OnUpdate is called with each newly-verified list. Use this to wire
	// root-status changes back into the cluster (node.SetRoot(...)).
	// Required.
	OnUpdate func(*SignedList)

	// OnError is called on every refresh failure. Optional; default is a
	// no-op. Use it to log or emit metrics.
	OnError func(error)

	// Clock overrides time.Now / time.After. Production callers leave
	// this nil to use RealClock.
	Clock Clock

	// Rand is the randomness source for jitter. Production callers leave
	// this nil — a package-default rand is used. Tests can inject a
	// deterministic rand for reproducibility.
	Rand *rand.Rand
}

// Refresher runs the background refresh loop defined in the 2.1 spec. One
// per node. Start it after the initial bootstrap succeeds; stop it during
// shutdown by cancelling the context passed to Run.
type Refresher struct {
	cfg RefresherConfig

	// current holds the list most recently verified. Guarded by mu.
	mu      sync.Mutex
	current *SignedList

	// triggerCh accepts manual refresh requests (peer-count drop,
	// bootstrap failure, etc.). Buffered so sends never block the caller.
	triggerCh chan struct{}
}

// NewRefresher constructs a Refresher with an initial list already
// verified by the caller. The initial list establishes the first deadline.
func NewRefresher(cfg RefresherConfig, initial *SignedList) *Refresher {
	if cfg.Clock == nil {
		cfg.Clock = RealClock{}
	}
	if cfg.CacheDir == "" {
		cfg.CacheDir = DefaultCacheDir()
	}
	if cfg.OnError == nil {
		cfg.OnError = func(error) {}
	}
	if cfg.Rand == nil {
		cfg.Rand = rand.New(rand.NewSource(time.Now().UnixNano()))
	}
	return &Refresher{
		cfg:       cfg,
		current:   initial,
		triggerCh: make(chan struct{}, 1),
	}
}

// Trigger requests an immediate refresh. Safe to call concurrently; extra
// triggers while a refresh is already pending are coalesced.
func (r *Refresher) Trigger() {
	select {
	case r.triggerCh <- struct{}{}:
	default:
	}
}

// Current returns the list most recently verified. Never nil after
// construction; the initial list is always available.
func (r *Refresher) Current() *SignedList {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.current
}

// Run blocks until ctx is cancelled, driving the refresh loop. It schedules
// the next refresh at (exp - now) * RotationFraction ± Jitter. On failure
// it retries with exponential backoff (RefreshBackoffMin..Max), retaining
// the previous list so the gate keeps working until the cached list itself
// expires.
func (r *Refresher) Run(ctx context.Context) {
	backoff := RefreshBackoffMin
	for {
		wait := r.nextDelay()
		select {
		case <-ctx.Done():
			return
		case <-r.cfg.Clock.After(wait):
		case <-r.triggerCh:
		}

		if err := r.refreshOnce(ctx); err != nil {
			r.cfg.OnError(err)
			// On failure, wait the backoff then retry. Do not
			// update r.current — the old list keeps serving until
			// its own exp passes.
			select {
			case <-ctx.Done():
				return
			case <-r.cfg.Clock.After(backoff):
			case <-r.triggerCh:
			}
			backoff *= 2
			if backoff > RefreshBackoffMax {
				backoff = RefreshBackoffMax
			}
			continue
		}
		backoff = RefreshBackoffMin
	}
}

// refreshOnce fetches, verifies, caches, and publishes a new list. On
// error the refresher's current list is untouched.
func (r *Refresher) refreshOnce(ctx context.Context) error {
	now := r.cfg.Clock.Now()
	list, err := FetchSigned(ctx, r.cfg.DNS, r.cfg.Pubkey, now)
	if err != nil {
		return err
	}

	if err := SaveCache(r.cfg.CacheDir, list); err != nil {
		// Cache failures are non-fatal: the verified list is still
		// good in memory, and we'll try again next cycle. Surface
		// via OnError so the operator knows the disk is unhappy.
		r.cfg.OnError(err)
	}

	r.mu.Lock()
	r.current = list
	r.mu.Unlock()

	r.cfg.OnUpdate(list)
	return nil
}

// nextDelay computes how long to sleep before the next scheduled refresh.
// Returns a zero duration when the current list is already expired (force
// immediate refresh) and RefreshBackoffMin if no current list exists
// (shouldn't happen in practice, but defensive).
func (r *Refresher) nextDelay() time.Duration {
	r.mu.Lock()
	current := r.current
	r.mu.Unlock()

	if current == nil {
		return RefreshBackoffMin
	}

	// Use the injectable clock for remaining-lifetime math so tests with
	// a fake clock behave deterministically.
	now := r.cfg.Clock.Now()
	remaining := time.Duration(current.Expires-now.Unix()) * time.Second
	if remaining <= 0 {
		return 0
	}

	target := time.Duration(float64(remaining) * RefreshRotationFraction)
	jitterSpan := time.Duration(float64(target) * RefreshJitter * 2) // ±jitter = 2× range
	if jitterSpan > 0 {
		target += time.Duration(r.cfg.Rand.Int63n(int64(jitterSpan))) - jitterSpan/2
	}
	if target < 0 {
		target = 0
	}
	return target
}
