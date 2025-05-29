#!/bin/bash

# Start simple multi-node setup using raw nodes (no gossip, for demonstration)
echo "Starting REPRAM Fade simple multi-node setup..."
echo "Note: This uses independent raw nodes without gossip for demo purposes"
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
pkill -f server.go 2>/dev/null || true
sleep 1

# Start multiple raw nodes on different ports
echo "Starting raw nodes..."

# Node 1
echo "Starting raw node 1 on port 8080..."
../bin/repram-node-raw -port 8080 > raw-node1.log 2>&1 &
NODE1_PID=$!
sleep 1

# Node 2  
echo "Starting raw node 2 on port 8081..."
../bin/repram-node-raw -port 8081 > raw-node2.log 2>&1 &
NODE2_PID=$!
sleep 1

# Node 3
echo "Starting raw node 3 on port 8082..."
../bin/repram-node-raw -port 8082 > raw-node3.log 2>&1 &
NODE3_PID=$!
sleep 2

# Check health of all nodes
echo "Checking node health..."
for port in 8080 8081 8082; do
    if curl -s http://localhost:$port/health > /dev/null; then
        echo "✓ Raw node on port $port is healthy"
    else
        echo "✗ Raw node on port $port is not responding"
    fi
done

# Start the Fade web server
echo "Starting Fade web server on port 3000..."
go run server.go -nodes "http://localhost:8080,http://localhost:8081,http://localhost:8082" > web.log 2>&1 &
WEB_PID=$!
sleep 2

# Test the web server
if curl -s http://localhost:3000/api/health > /dev/null; then
    echo "✓ Fade web server is healthy"
else
    echo "✗ Fade web server is not responding"
fi

echo
echo "✓ Simple multi-node Fade setup is ready!"
echo
echo "URLs:"
echo "  - Fade UI: http://localhost:3000"
echo "  - Raw Node 1: http://localhost:8080"
echo "  - Raw Node 2: http://localhost:8081" 
echo "  - Raw Node 3: http://localhost:8082"
echo
echo "To test multi-node behavior:"
echo "  1. Open http://localhost:3000 in multiple browser windows"
echo "  2. Send messages from different windows"  
echo "  3. Messages will be distributed across nodes via load balancer"
echo "  4. Each refresh may show different data as it hits different nodes"
echo "  5. This demonstrates eventual consistency behavior"
echo
echo "To test manual node switching:"
echo "  - Modify client.js to point to specific nodes"
echo "  - Send messages to specific nodes and observe distribution"
echo
echo "To stop:"
echo "  ./stop-simple-multi-node.sh"
echo
echo "Log files: raw-node1.log, raw-node2.log, raw-node3.log, web.log"

# Save PIDs for cleanup
echo "$NODE1_PID $NODE2_PID $NODE3_PID $WEB_PID" > simple-cluster.pids