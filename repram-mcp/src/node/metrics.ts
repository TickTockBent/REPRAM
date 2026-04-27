/**
 * Prometheus metrics for the TS node. Mirrors the Go side's metric names so a
 * single Grafana dashboard works against either implementation.
 *
 * Production wiring (in index.ts):
 *   1. enableProcessMetrics() — once at boot
 *   2. clusterNode.gossip.enableMetrics(gossipMetrics)
 *   3. setOmegaLastRefreshNow() inside the omega refresher's onUpdate
 *   4. Route /v1/metrics to metricsHandler in server.ts
 */

import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Registry,
  type Metric,
} from "prom-client";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GossipMetrics } from "./gossip.js";

export const registry = new Registry();

// Default Node.js process metrics: process_resident_memory_bytes,
// nodejs_eventloop_lag_seconds, etc. Burn-in panel 1 (memory) and panel 2
// (event-loop lag, the TS analogue to goroutines) read these.
let defaultsEnabled = false;
export function enableProcessMetrics(): void {
  if (defaultsEnabled) return;
  collectDefaultMetrics({ register: registry });
  defaultsEnabled = true;
}

// Cluster metrics — names match internal/gossip/protocol.go so cross-impl
// dashboard queries don't need {impl=...} discrimination.
const peersActive = new Gauge({
  name: "repram_peers_active",
  help: "Current number of active peers in the gossip protocol",
  registers: [registry],
});

const peerEvictions = new Counter({
  name: "repram_peer_evictions_total",
  help: "Total number of peers evicted due to consecutive ping failures",
  registers: [registry],
});

const peerJoins = new Counter({
  name: "repram_peer_joins_total",
  help: "Total number of peers added (initial join or rejoin after eviction)",
  registers: [registry],
});

const pingFailures = new Counter({
  name: "repram_ping_failures_total",
  help: "Total number of failed ping attempts to peers",
  registers: [registry],
});

export const gossipMetrics: GossipMetrics = {
  onPeersActive: (count) => peersActive.set(count),
  onPeerJoin: () => peerJoins.inc(),
  onPeerEviction: () => peerEvictions.inc(),
  onPingFailure: () => pingFailures.inc(),
};

// Omega refresh freshness. Burn-in panel 6 plots
// time() - repram_omega_last_refresh_unix_seconds. Stays at 0 until the
// first successful refresh (private-network deployments never tick).
const omegaLastRefresh = new Gauge({
  name: "repram_omega_last_refresh_unix_seconds",
  help: "Unix timestamp of the most recent successful omega root-list refresh (0 = never).",
  registers: [registry],
});

export function setOmegaLastRefreshNow(): void {
  omegaLastRefresh.set(Math.floor(Date.now() / 1000));
}

// Test helper: lets unit tests reset registry-scoped state without leaking
// across cases.
export function resetForTest(): void {
  for (const m of [peersActive, peerEvictions, peerJoins, pingFailures, omegaLastRefresh] as Metric[]) {
    (m as { reset?: () => void }).reset?.();
  }
}

export async function metricsHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await registry.metrics();
    res.writeHead(200, { "Content-Type": registry.contentType });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(String(err));
  }
}
