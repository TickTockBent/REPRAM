#!/bin/bash

# Start multi-node Fade cluster for testing gossip
echo "Starting REPRAM Fade multi-node cluster..."
echo

cd "$(dirname "$0")"

# Check if we need to build
if [ ! -f "../bin/repram-node-raw" ]; then
    echo "Building raw node..."
    cd ..
    make build-raw
    cd fade
fi

# Kill any existing nodes
echo "Cleaning up any existing nodes..."
pkill -f repram-node-raw 2>/dev/null || true
pkill -f fade-server 2>/dev/null || true
sleep 1

# Start the cluster nodes
echo "Starting Fade cluster nodes..."

# Node 1 (primary)
echo "Starting node 1 on port 8080..."
PORT=8080 \
../bin/repram-node-raw > node1.log 2>&1 &
NODE1_PID=$!
sleep 2

# Node 2
echo "Starting node 2 on port 8081..."
PORT=8081 \
../bin/repram-node-raw > node2.log 2>&1 &
NODE2_PID=$!
sleep 2

# Node 3
echo "Starting node 3 on port 8082..."
PORT=8082 \
../bin/repram-node-raw > node3.log 2>&1 &
NODE3_PID=$!
sleep 2

# Check health of all nodes
echo "Checking node health..."
for port in 8080 8081 8082; do
    if curl -s http://localhost:$port/health > /dev/null; then
        echo "✓ Node on port $port is healthy"
    else
        echo "✗ Node on port $port is not responding"
    fi
done

# Start the Fade web server
echo "Starting Fade web server on port 3000..."
go run server.go -nodes "http://localhost:8080,http://localhost:8081,http://localhost:8082" > web.log 2>&1 &
WEB_PID=$!
sleep 2

echo
echo "✓ Multi-node Fade setup is ready!"
echo
echo "URLs:"
echo "  - Fade UI: http://localhost:3000"
echo "  - Node 1 API: http://localhost:8080"
echo "  - Node 2 API: http://localhost:8081" 
echo "  - Node 3 API: http://localhost:8082"
echo
echo "Note: Raw nodes don't support gossip replication."
echo "Messages are stored independently on each node."
echo
echo "To stop the cluster:"
echo "  ./stop-multi-node.sh"
echo
echo "Log files: node1.log, node2.log, node3.log, web.log"

# Save PIDs for cleanup
echo "$NODE1_PID $NODE2_PID $NODE3_PID $WEB_PID" > cluster.pids