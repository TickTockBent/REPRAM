package dashboard

import (
	"github.com/prometheus/client_golang/prometheus"
)

// internalMetrics is the dashboard's self-observability surface. Exposed on
// a separate localhost-bound listener at /internal/metrics by default so a
// public Internet visitor never sees these — they exist for the operator
// running the dashboard, not for casual consumers of the public graph.
type internalMetrics struct {
	registry              *prometheus.Registry
	pollsTotal            prometheus.Counter
	pollsFailedTotal      prometheus.Counter
	nodesUnreachable      prometheus.Gauge
	snapshotAgeSeconds    prometheus.Gauge
	omegaRefreshUnix      prometheus.Gauge
	omegaExpiresUnix      prometheus.Gauge
	omegaRefreshFailures  prometheus.Counter
	geoLookupMissesTotal  prometheus.Counter
}

func newInternalMetrics() *internalMetrics {
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
		snapshotAgeSeconds: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "dashboard_snapshot_age_seconds",
			Help: "Seconds since the last successful poll cycle completed.",
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
	reg.MustRegister(
		m.pollsTotal,
		m.pollsFailedTotal,
		m.nodesUnreachable,
		m.snapshotAgeSeconds,
		m.omegaRefreshUnix,
		m.omegaExpiresUnix,
		m.omegaRefreshFailures,
		m.geoLookupMissesTotal,
	)
	return m
}
