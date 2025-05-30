#!/bin/bash

# Start multi-node Fade cluster for testing gossip
echo "Starting REPRAM Fade multi-node cluster..."
echo

cd "$(dirname "$0")"

# Check if we need to build
if [ ! -f "../bin/repram-fade-cluster-node" ]; then
    echo "Building fade cluster node..."
    cd ..
    make build-fade-cluster
    cd fade
fi

# Kill any existing nodes
echo "Cleaning up any existing nodes..."
pkill -f repram-fade-cluster-node 2>/dev/null || true
pkill -f fade-server 2>/dev/null || true
sleep 1

# Start the cluster nodes
echo "Starting Fade cluster nodes..."

# Node 1 (primary, no bootstrap)
echo "Starting node 1 on ports 8080 (HTTP) and 9090 (gossip)..."
REPRAM_PORT=8080 \
REPRAM_GOSSIP_PORT=9090 \
REPRAM_NODE_ID=fade-node-1 \
NODE_ADDRESS=localhost \
REPLICATION_FACTOR=1 \
../bin/repram-fade-cluster-node > node1.log 2>&1 &
NODE1_PID=$!
sleep 3

# Node 2 (bootstraps from node 1)
echo "Starting node 2 on ports 8081 (HTTP) and 9091 (gossip)..."
REPRAM_PORT=8081 \
REPRAM_GOSSIP_PORT=9091 \
REPRAM_NODE_ID=fade-node-2 \
NODE_ADDRESS=localhost \
REPLICATION_FACTOR=1 \
REPRAM_BOOTSTRAP_PEERS=localhost:9090 \
../bin/repram-fade-cluster-node > node2.log 2>&1 &
NODE2_PID=$!
sleep 3

# Node 3 (bootstraps from both)
echo "Starting node 3 on ports 8082 (HTTP) and 9092 (gossip)..."
REPRAM_PORT=8082 \
REPRAM_GOSSIP_PORT=9092 \
REPRAM_NODE_ID=fade-node-3 \
NODE_ADDRESS=localhost \
REPLICATION_FACTOR=1 \
REPRAM_BOOTSTRAP_PEERS=localhost:9090,localhost:9091 \
../bin/repram-fade-cluster-node > node3.log 2>&1 &
NODE3_PID=$!
sleep 5

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
echo "✓ Multi-node Fade cluster is ready!"
echo
echo "URLs:"
echo "  - Fade UI: http://localhost:3000"
echo "  - Node 1 API: http://localhost:8080"
echo "  - Node 2 API: http://localhost:8081" 
echo "  - Node 3 API: http://localhost:8082"
echo
echo "To test gossip:"
echo "  1. Open http://localhost:3000 in multiple browser windows"
echo "  2. Send messages from different windows"
echo "  3. Watch messages appear in all windows (gossip replication)"
echo
echo "To stop the cluster:"
echo "  ./stop-multi-node.sh"
echo
echo "Log files: node1.log, node2.log, node3.log, web.log"

# Save PIDs for cleanup
echo "$NODE1_PID $NODE2_PID $NODE3_PID $WEB_PID" > cluster.pids