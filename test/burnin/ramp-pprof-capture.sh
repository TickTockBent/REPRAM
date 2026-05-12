#!/usr/bin/env bash
# Capture pprof snapshots at regular intervals during a ramp-to-failure run.
#
# Run alongside the k6 ramp test. Captures Go heap + goroutine profiles and
# TS heap stats every INTERVAL seconds. Output goes to a timestamped directory
# for post-run analysis.
#
# Usage:
#   ./test/burnin/ramp-pprof-capture.sh
#
# The goroutine profile is the key diagnostic: pileup on sync.Mutex means
# contention (pendingWrites, peer map); pileup on net.(*netFD).connect means
# connection pool exhaustion.

set -uo pipefail

GO_NODES=(10.0.20.72 10.0.10.81)
TS_NODE=10.0.10.104
PPROF_PORT=6060
INTERVAL="${CAPTURE_INTERVAL_SEC:-120}"

OUTDIR="${RAMP_CAPTURE_DIR:-$HOME/.repram-burnin/ramp-captures/$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUTDIR"

echo "$(date -Is) pprof capture started — interval ${INTERVAL}s, output: $OUTDIR"

trap 'echo "$(date -Is) pprof capture stopped"; exit 0' INT TERM

cycle=0
while :; do
    cycle=$((cycle + 1))
    ts=$(date +%s)

    for ip in "${GO_NODES[@]}"; do
        curl -s -m 10 "http://${ip}:${PPROF_PORT}/debug/pprof/heap" \
            > "$OUTDIR/heap-${ip}-${ts}.pprof" 2>/dev/null || true
        curl -s -m 10 "http://${ip}:${PPROF_PORT}/debug/pprof/goroutine" \
            > "$OUTDIR/goroutine-${ip}-${ts}.pprof" 2>/dev/null || true
    done

    curl -s -m 10 "http://${TS_NODE}:${PPROF_PORT}/debug/pprof/stats" \
        > "$OUTDIR/stats-ts-${ts}.json" 2>/dev/null || true

    echo "$(date -Is) cycle=$cycle captured ($(ls "$OUTDIR" | wc -l) files)"
    sleep "$INTERVAL"
done
