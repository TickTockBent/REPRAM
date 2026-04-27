#!/usr/bin/env bash
# Capture a single-line burn-in snapshot per cycle. Run by cron every 30
# minutes during the 48h test. Output is appended to the log file
# specified in $SNAPSHOT_LOG (default: ~/.repram-burnin/snapshots.log).
#
# Each cycle emits one section per node and a header so the file can be
# scanned linearly or grepped by metric name (e.g. `grep "peers"`).

set -uo pipefail

LOG="${SNAPSHOT_LOG:-$HOME/.repram-burnin/snapshots.log}"
NODES=(10.0.20.72 10.0.10.81 10.0.10.104)
ts=$(date -Is)

mkdir -p "$(dirname "$LOG")"

{
    echo "===== $ts ====="
    for ip in "${NODES[@]}"; do
        # Single curl, parse out the metrics we care about. Uses -m 5 so a
        # hung node doesn't stall the whole cron run.
        m=$(curl -s -m 5 "http://${ip}:18080/v1/metrics" 2>/dev/null) || {
            echo "  $ip  UNREACHABLE"
            continue
        }
        peers=$(echo "$m" | awk '/^repram_peers_active /{print $2}')
        ping_failures=$(echo "$m" | awk '/^repram_ping_failures_total /{print $2}')
        evictions=$(echo "$m" | awk '/^repram_peer_evictions_total /{print $2}')
        joins=$(echo "$m" | awk '/^repram_peer_joins_total /{print $2}')
        rate_lim=$(echo "$m" | awk '/^repram_rate_limited_requests_total /{print $2}')
        omega_unix=$(echo "$m" | awk '/^repram_omega_last_refresh_unix_seconds /{print $2}')
        rss=$(echo "$m" | awk '/^process_resident_memory_bytes /{print $2}')
        go_heap=$(echo "$m" | awk '/^go_memstats_heap_inuse_bytes /{print $2}')
        go_routines=$(echo "$m" | awk '/^go_goroutines /{print $2}')
        evloop_lag_p99=$(echo "$m" | awk '/^nodejs_eventloop_lag_p99_seconds /{print $2}')
        ts_external=$(echo "$m" | awk '/^nodejs_external_memory_bytes /{print $2}')
        ts_heap_used=$(echo "$m" | awk '/^nodejs_heap_size_used_bytes /{print $2}')

        # Compute "seconds since last omega refresh" client-side so we don't
        # depend on a Prometheus query in cron.
        now=$(date +%s)
        if [[ -n "$omega_unix" && "$omega_unix" != "0" ]]; then
            omega_age=$(awk -v n="$now" -v o="$omega_unix" 'BEGIN{printf "%.0fs", n-o}')
        else
            omega_age="never"
        fi

        # Best-effort key count (large limit so prefix scan returns most/all).
        keys=$(curl -s -m 5 "http://${ip}:18080/v1/keys?prefix=bench&limit=10000" 2>/dev/null \
            | python3 -c "import json,sys
try:
    d=json.load(sys.stdin); print(len(d.get('keys',d)) if isinstance(d,(dict,list)) else 0)
except: print('?')" 2>/dev/null)

        # Prometheus emits these in scientific notation, so use awk for the
        # MB conversion rather than bash's integer-only arithmetic.
        to_mb() { awk -v n="$1" 'BEGIN{ if (n=="") {print "?"} else {printf "%.1fM", n/1024/1024} }'; }

        printf '  %-15s peers=%-3s pingfail=%-3s evict=%-3s joins=%-3s rl=%-3s omega_age=%-7s keys=%-6s' \
            "$ip" "${peers:-?}" "${ping_failures:-?}" "${evictions:-?}" "${joins:-?}" "${rate_lim:-?}" "$omega_age" "${keys:-?}"
        if [[ -n "$go_heap" ]]; then
            printf ' heap=%s goroutines=%s' "$(to_mb "$go_heap")" "${go_routines:-?}"
        fi
        if [[ -n "$rss" && -z "$go_heap" ]]; then
            printf ' rss=%s ext=%s v8heap=%s evloop_p99=%ss' \
                "$(to_mb "$rss")" "$(to_mb "${ts_external:-0}")" "$(to_mb "${ts_heap_used:-0}")" "${evloop_lag_p99:-?}"
        elif [[ -n "$rss" ]]; then
            printf ' rss=%s' "$(to_mb "$rss")"
        fi
        echo
    done
} >> "$LOG"
