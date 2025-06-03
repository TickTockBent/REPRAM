#!/bin/sh
# Launcher script to run multiple REPRAM nodes in a single container
# This simulates Flux deployment where all instances share the same IP

echo "Starting multiple REPRAM nodes in single container..."
echo "This simulates Flux deployment behavior"
echo ""

# Configuration from environment or defaults
DISCOVERY_DOMAIN=${DISCOVERY_DOMAIN:-localhost}
BASE_PORT=${BASE_PORT:-8081}
MAX_PORTS=${MAX_PORTS:-5}
NODE_COUNT=${NODE_COUNT:-3}
REPLICATION_FACTOR=${REPLICATION_FACTOR:-3}

echo "Configuration:"
echo "  DISCOVERY_DOMAIN: $DISCOVERY_DOMAIN"
echo "  BASE_PORT: $BASE_PORT" 
echo "  MAX_PORTS: $MAX_PORTS"
echo "  NODE_COUNT: $NODE_COUNT"
echo ""

# Function to start a node
start_node() {
    local node_num=$1
    local node_id="flux-node-$node_num"
    
    echo "Starting $node_id..."
    
    # Set environment for this node
    export REPRAM_NODE_ID=$node_id
    export NODE_ADDRESS=localhost
    export USE_AUTO_DISCOVERY=true
    export DISCOVERY_DOMAIN=$DISCOVERY_DOMAIN
    export BASE_PORT=$BASE_PORT
    export MAX_PORTS=$MAX_PORTS
    export REPLICATION_FACTOR=$REPLICATION_FACTOR
    
    # Start node in background, redirect output to log file
    ./repram-cluster-node > /tmp/${node_id}.log 2>&1 &
    echo $! > /tmp/${node_id}.pid
    
    echo "$node_id started with PID $(cat /tmp/${node_id}.pid)"
}

# Cleanup function
cleanup() {
    echo ""
    echo "Shutting down nodes..."
    for i in $(seq 1 $NODE_COUNT); do
        if [ -f /tmp/flux-node-$i.pid ]; then
            PID=$(cat /tmp/flux-node-$i.pid)
            if kill -0 $PID 2>/dev/null; then
                kill $PID
                echo "Stopped flux-node-$i (PID $PID)"
            fi
            rm -f /tmp/flux-node-$i.pid
        fi
    done
    exit 0
}

# Set up signal handlers
trap cleanup INT TERM

# Start all nodes with staggered timing
for i in $(seq 1 $NODE_COUNT); do
    start_node $i
    # Small delay between starts to reduce port conflicts
    sleep 2
done

echo ""
echo "All nodes started. Waiting for them to discover each other..."
sleep 5

# Show which ports were claimed
echo ""
echo "Checking node status:"
for port in $(seq $BASE_PORT $((BASE_PORT + MAX_PORTS - 1))); do
    if curl -s http://localhost:$port/health >/dev/null 2>&1; then
        NODE_INFO=$(curl -s http://localhost:$port/health | grep -o '"node_id":"[^"]*"' | cut -d'"' -f4)
        echo "  Port $port: $NODE_INFO"
    fi
done

echo ""
echo "Nodes are running. Press Ctrl+C to stop all nodes."
echo ""
echo "To monitor nodes:"
echo "  tail -f /tmp/flux-node-*.log"
echo ""
echo "To test:"
echo "  curl http://localhost:$BASE_PORT/health"
echo "  curl http://localhost:$BASE_PORT/peers"
echo ""

# Keep script running
while true; do
    sleep 60
    # Optional: Add health check monitoring here
done