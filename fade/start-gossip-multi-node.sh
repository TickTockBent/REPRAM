#!/bin/bash

# Start multi-node setup with gossip-enabled cluster nodes
echo "Starting REPRAM Fade multi-node setup with GOSSIP replication..."
echo "This uses cluster nodes that replicate data between each other"
echo

cd "$(dirname "$0")"

# Check if we need to build
if [ ! -f "../bin/repram-cluster-node" ]; then
    echo "Building cluster node..."
    cd ..
    make build-cluster
    if [ $? -ne 0 ]; then
        echo "❌ Failed to build cluster node. Please check the build output above."
        exit 1
    fi
    cd fade
fi

# Kill any existing nodes
echo "Cleaning up any existing nodes..."
pkill -f repram-cluster-node 2>/dev/null || true
pkill -f fade-server 2>/dev/null || true
pkill -f server.go 2>/dev/null || true
sleep 2

# Function to wait for node to be ready
wait_for_node() {
    local port=$1
    local max_attempts=10
    local attempt=0
    
    while [ $attempt -lt $max_attempts ]; do
        if curl -s http://localhost:$port/health > /dev/null 2>&1; then
            return 0
        fi
        sleep 0.5
        attempt=$((attempt + 1))
    done
    return 1
}

# Start cluster nodes with gossip
echo "Starting gossip-enabled cluster nodes..."

# Start nodes in sequence with proper bootstrap
echo "Starting cluster node 1 on port 8080 (seed node)..."
REPRAM_NODE_ID=fade-node-1 \
NODE_ADDRESS=localhost \
REPRAM_PORT=8080 \
REPRAM_GOSSIP_PORT=7080 \
REPLICATION_FACTOR=3 \
../bin/repram-cluster-node > cluster-node1.log 2>&1 &
NODE1_PID=$!

# Wait for node 1 to be ready before starting others
sleep 2
if ! wait_for_node 8080; then
    echo "❌ Node 1 failed to start. Check cluster-node1.log for details"
    tail -10 cluster-node1.log
    kill $NODE1_PID 2>/dev/null || true
    exit 1
fi

echo "Starting cluster node 2 on port 8081 (bootstrapping from node 1)..."
REPRAM_NODE_ID=fade-node-2 \
NODE_ADDRESS=localhost \
REPRAM_PORT=8081 \
REPRAM_GOSSIP_PORT=7081 \
REPLICATION_FACTOR=3 \
REPRAM_BOOTSTRAP_PEERS=localhost:8080 \
../bin/repram-cluster-node > cluster-node2.log 2>&1 &
NODE2_PID=$!

echo "Starting cluster node 3 on port 8082 (bootstrapping from node 1)..."
REPRAM_NODE_ID=fade-node-3 \
NODE_ADDRESS=localhost \
REPRAM_PORT=8082 \
REPRAM_GOSSIP_PORT=7082 \
REPLICATION_FACTOR=3 \
REPRAM_BOOTSTRAP_PEERS=localhost:8080 \
../bin/repram-cluster-node > cluster-node3.log 2>&1 &
NODE3_PID=$!

# Wait for all nodes to be healthy
echo "Waiting for all nodes to start and bootstrap..."
sleep 2

# Check node 2
if wait_for_node 8081; then
    echo "✓ Node 2 started and bootstrapped successfully"
else
    echo "❌ Node 2 failed to start. Check cluster-node2.log for details"
    tail -10 cluster-node2.log
    kill $NODE1_PID $NODE2_PID $NODE3_PID 2>/dev/null || true
    exit 1
fi

# Check node 3
if wait_for_node 8082; then
    echo "✓ Node 3 started and bootstrapped successfully"
else
    echo "❌ Node 3 failed to start. Check cluster-node3.log for details"
    tail -10 cluster-node3.log
    kill $NODE1_PID $NODE2_PID $NODE3_PID 2>/dev/null || true
    exit 1
fi

# Give bootstrap time to complete
echo
echo "Waiting for bootstrap and gossip protocol to establish connections..."
sleep 3

# Double-check all nodes are healthy
echo
echo "Verifying all nodes are healthy..."
all_healthy=true
for port in 8080 8081 8082; do
    if curl -s http://localhost:$port/health > /dev/null; then
        echo "✓ Cluster node on port $port is healthy"
    else
        echo "✗ Cluster node on port $port is not responding"
        all_healthy=false
    fi
done

if [ "$all_healthy" = false ]; then
    echo "❌ Not all nodes are healthy. Aborting."
    kill $NODE1_PID $NODE2_PID $NODE3_PID 2>/dev/null || true
    exit 1
fi

# Check if port 3000 is already in use
if lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo
    echo "⚠️  Port 3000 is already in use. Checking if it's a Fade server..."
    if curl -s http://localhost:3000/api/health > /dev/null 2>&1; then
        echo "✓ Existing Fade web server is healthy on port 3000"
        WEB_PID=$(lsof -Pi :3000 -sTCP:LISTEN -t)
    else
        echo "❌ Port 3000 is in use by another process. Please free the port and try again."
        echo "   Run: lsof -i :3000"
        kill $NODE1_PID $NODE2_PID $NODE3_PID 2>/dev/null || true
        exit 1
    fi
else
    # Start the Fade web server
    echo
    echo "Starting Fade web server on port 3000..."
    go run server.go -nodes "http://localhost:8080,http://localhost:8081,http://localhost:8082" > web.log 2>&1 &
    WEB_PID=$!
    
    # Wait for web server to be ready
    if wait_for_node 3000; then
        echo "✓ Fade web server started successfully"
    else
        echo "❌ Fade web server failed to start. Check web.log for details"
        tail -10 web.log
        kill $NODE1_PID $NODE2_PID $NODE3_PID 2>/dev/null || true
        exit 1
    fi
fi

echo
echo "✓ Multi-node Fade setup with GOSSIP is ready!"
echo
echo "URLs:"
echo "  - Fade UI: http://localhost:3000"
echo "  - Cluster Node 1: http://localhost:8080 (gossip port: 7080)"
echo "  - Cluster Node 2: http://localhost:8081 (gossip port: 7081)"
echo "  - Cluster Node 3: http://localhost:8082 (gossip port: 7082)"
echo
echo "To test gossip replication:"
echo "  1. Open http://localhost:3000 in multiple browser windows"
echo "  2. Select different nodes in each window using the node selector"  
echo "  3. Send a message on one node"
echo "  4. Messages should appear on other nodes within 1-3 seconds"
echo "  5. Watch node indicators to see real-time replication"
echo
echo "Gossip protocol details:"
echo "  - Bootstrap: Nodes discover topology via HTTP endpoint"
echo "  - Replication: Data propagates immediately on write"
echo "  - Quorum: Write succeeds when majority (2/3) nodes confirm"
echo "  - Fault tolerance: Cluster survives single node failures"
echo
echo "To stop:"
echo "  ./stop-gossip-multi-node.sh"
echo
echo "Log files: cluster-node1.log, cluster-node2.log, cluster-node3.log, web.log"

# Save PIDs for cleanup
echo "$NODE1_PID $NODE2_PID $NODE3_PID $WEB_PID" > gossip-cluster.pids