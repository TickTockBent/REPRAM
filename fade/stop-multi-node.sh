#!/bin/bash

# Stop the multi-node Fade cluster
echo "Stopping REPRAM Fade multi-node cluster..."

cd "$(dirname "$0")"

# Kill by name first
pkill -f repram-node-raw 2>/dev/null || true
pkill -f fade-server 2>/dev/null || true

# Kill by saved PIDs if available
if [ -f cluster.pids ]; then
    while read -r pids; do
        for pid in $pids; do
            if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
                echo "Stopping process $pid..."
                kill "$pid" 2>/dev/null || true
            fi
        done
    done < cluster.pids
    rm cluster.pids
fi

sleep 2

# Cleanup log files
if [ "$1" = "--clean" ]; then
    echo "Cleaning up log files..."
    rm -f node1.log node2.log node3.log web.log
fi

echo "✓ Multi-node cluster stopped"