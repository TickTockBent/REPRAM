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
    if [ $? -ne 0 ]; then
        echo "❌ Failed to build raw node. Please check the build output above."
        exit 1
    fi
    cd fade
fi

# Kill any existing nodes
echo "Cleaning up any existing nodes..."
pkill -f repram-node-raw 2>/dev/null || true
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

# Start multiple raw nodes on different ports
echo "Starting raw nodes..."

# Node 1
echo "Starting raw node 1 on port 8080..."
PORT=8080 ../bin/repram-node-raw > raw-node1.log 2>&1 &
NODE1_PID=$!
if wait_for_node 8080; then
    echo "✓ Node 1 started successfully"
else
    echo "❌ Node 1 failed to start. Check raw-node1.log for details"
    tail -10 raw-node1.log
    exit 1
fi

# Node 2  
echo "Starting raw node 2 on port 8081..."
PORT=8081 ../bin/repram-node-raw > raw-node2.log 2>&1 &
NODE2_PID=$!
if wait_for_node 8081; then
    echo "✓ Node 2 started successfully"
else
    echo "❌ Node 2 failed to start. Check raw-node2.log for details"
    tail -10 raw-node2.log
    kill $NODE1_PID 2>/dev/null || true
    exit 1
fi

# Node 3
echo "Starting raw node 3 on port 8082..."
PORT=8082 ../bin/repram-node-raw > raw-node3.log 2>&1 &
NODE3_PID=$!
if wait_for_node 8082; then
    echo "✓ Node 3 started successfully"
else
    echo "❌ Node 3 failed to start. Check raw-node3.log for details"
    tail -10 raw-node3.log
    kill $NODE1_PID $NODE2_PID 2>/dev/null || true
    exit 1
fi

# Double-check all nodes are healthy
echo
echo "Verifying all nodes are healthy..."
all_healthy=true
for port in 8080 8081 8082; do
    if curl -s http://localhost:$port/health > /dev/null; then
        echo "✓ Raw node on port $port is healthy"
    else
        echo "✗ Raw node on port $port is not responding"
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