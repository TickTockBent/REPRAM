#!/bin/bash

# Stop the simple multi-node Fade setup
echo "Stopping REPRAM Fade simple multi-node setup..."

cd "$(dirname "$0")"

# Kill by name first
pkill -f repram-node-raw 2>/dev/null || true
pkill -f fade-server 2>/dev/null || true
pkill -f server.go 2>/dev/null || true

# Kill by saved PIDs if available
if [ -f simple-cluster.pids ]; then
    while read -r pids; do
        for pid in $pids; do
            if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
                echo "Stopping process $pid..."
                kill "$pid" 2>/dev/null || true
            fi
        done
    done < simple-cluster.pids
    rm simple-cluster.pids
fi

sleep 2

# Cleanup log files
if [ "$1" = "--clean" ]; then
    echo "Cleaning up log files..."
    rm -f raw-node1.log raw-node2.log raw-node3.log web.log
fi

echo "✓ Simple multi-node setup stopped"