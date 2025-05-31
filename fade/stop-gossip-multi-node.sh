#!/bin/bash

echo "Stopping REPRAM Fade gossip multi-node setup..."

cd "$(dirname "$0")"

if [ -f gossip-cluster.pids ]; then
    echo "Reading PIDs from gossip-cluster.pids..."
    while read -r pids; do
        for pid in $pids; do
            if kill -0 "$pid" 2>/dev/null; then
                echo "Stopping process $pid..."
                kill "$pid" 2>/dev/null || true
            fi
        done
    done < gossip-cluster.pids
    rm gossip-cluster.pids
else
    echo "No gossip-cluster.pids file found, searching for processes..."
    pkill -f cluster-node 2>/dev/null || true
    pkill -f server.go 2>/dev/null || true
fi

# Also clean up fade server if it's ours
if lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
    WEB_PID=$(lsof -Pi :3000 -sTCP:LISTEN -t)
    echo "Stopping Fade web server (PID: $WEB_PID)..."
    kill "$WEB_PID" 2>/dev/null || true
fi

echo "Gossip cluster stopped."
echo
echo "Log files are preserved in:"
echo "  - cluster-node1.log"
echo "  - cluster-node2.log"
echo "  - cluster-node3.log"
echo "  - web.log"