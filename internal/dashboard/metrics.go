package dashboard

import (
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// internalMetrics is the dashboard's self-observability surface. Exposed on
// a separate localhost-bound listener at /internal/metrics by default so a
// public Internet visitor never sees these — they exist for the operator
// running the dashboard, not for casual consumers of the public graph.
//
// dashboard_snapshot_age_seconds is intentionally a GaugeFunc: a gauge
// that "ages" between cycles cannot be poked once per success — it must
// be computed at scrape time from the most recent successful-poll
// timestamp. A 4-minute-old snapshot must report ~240, not 0.
type internalMetrics struct {
	registry             *prometheus.Registry
	pollsTotal           prometheus.Counter
	pollsFailedTotal     prometheus.Counter
	nodesUnreachable     prometheus.Gauge
	omegaRefreshUnix     prometheus.Gauge
	omegaExpiresUnix     prometheus.Gauge
	omegaRefreshFailures prometheus.Counter
	geoLookupMissesTotal prometheus.Counter
}

// newInternalMetrics constructs the dashboard's metric set. lastPollUnix
// is a callback that returns the Unix timestamp of the most recent
// successful poll cycle; it backs the snapshot_age_seconds GaugeFunc.
func newInternalMetrics(lastPollUnix func() int64) *internalMetrics {
	reg := prometheus.NewRegistry()
	m := &internalMetrics{
		registry: reg,
		pollsTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "dashboard_polls_total",
			Help: "Total topology poll cycles attempted since start.",
		}),
		pollsFailedTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "dashboard_polls_failed_total",
			Help: "Poll cycles where zero nodes responded.",
		}),
		nodesUnreachable: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "dashboard_nodes_unreachable",
			Help: "Nodes flagged unreachable in the current snapshot.",
		}),
		omegaRefreshUnix: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "dashboard_omega_refresh_unix_seconds",
			Help: "Unix timestamp of last successful omega refresh (0 = never / seed-override mode).",
		}),
		omegaExpiresUnix: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "dashboard_omega_expires_unix_seconds",
			Help: "Unix timestamp at which the cached omega list expires (0 = no cache / seed-override mode).",
		}),
		omegaRefreshFailures: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "dashboard_omega_refresh_failures_total",
			Help: "Failed omega refresh attempts since start.",
		}),
		geoLookupMissesTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "dashboard_geo_lookup_misses_total",
			Help: "IPs that did not resolve to a country during snapshot build.",
		}),
	}

	snapshotAge := prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "dashboard_snapshot_age_seconds",
		Help: "Seconds since the last successful poll cycle completed (computed at scrape time).",
	}, func() float64 {
		last := lastPollUnix()
		if last == 0 {
			return 0
		}
		return float64(time.Now().Unix() - last)
	})

	reg.MustRegister(
		m.pollsTotal,
		m.pollsFailedTotal,
		m.nodesUnreachable,
		snapshotAge,
		m.omegaRefreshUnix,
		m.omegaExpiresUnix,
		m.omegaRefreshFailures,
		m.geoLookupMissesTotal,
	)
	return m
}
