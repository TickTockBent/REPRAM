#!/bin/bash

# Test script for 3-node gossip cluster
# This script starts 3 REPRAM cluster nodes and tests gossip replication

set -e

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
NODE1_HTTP_PORT=8081
NODE1_GOSSIP_PORT=9091
NODE2_HTTP_PORT=8082
NODE2_GOSSIP_PORT=9092
NODE3_HTTP_PORT=8083
NODE3_GOSSIP_PORT=9093

# PID file to track processes
PID_FILE="gossip-test.pids"

# Cleanup function
cleanup() {
    echo -e "${BLUE}Cleaning up...${NC}"
    # Kill any existing cluster-node processes
    pkill -f cluster-node 2>/dev/null || true
    
    if [ -f "$PID_FILE" ]; then
        while read pid; do
            if kill -0 "$pid" 2>/dev/null; then
                kill "$pid" 2>/dev/null || true
            fi
        done < "$PID_FILE"
        rm -f "$PID_FILE"
    fi
    # Cleanup log files
    rm -f node*.log
}

# Set trap to cleanup on exit
trap cleanup EXIT

# Function to wait for node to be ready
wait_for_node() {
    local port=$1
    local max_attempts=30
    local attempt=0
    
    echo -n "Waiting for node on port $port..."
    while [ $attempt -lt $max_attempts ]; do
        if curl -s "http://localhost:$port/health" > /dev/null 2>&1; then
            echo -e " ${GREEN}Ready!${NC}"
            return 0
        fi
        echo -n "."
        sleep 1
        attempt=$((attempt + 1))
    done
    echo -e " ${RED}Failed!${NC}"
    return 1
}

# Build the cluster node if needed
echo -e "${BLUE}Building cluster node...${NC}"
go build -o bin/cluster-node cmd/cluster-node/main.go

# Clear any existing PID file and processes
rm -f "$PID_FILE"
cleanup

# Start Node 1 (seed node)
echo -e "${BLUE}Starting Node 1 as seed node (HTTP: $NODE1_HTTP_PORT, Gossip: $NODE1_GOSSIP_PORT)...${NC}"
REPRAM_NODE_ID=node-1 \
NODE_ADDRESS=localhost \
REPRAM_PORT=$NODE1_HTTP_PORT \
REPRAM_GOSSIP_PORT=$NODE1_GOSSIP_PORT \
REPLICATION_FACTOR=3 \
./bin/cluster-node > node1.log 2>&1 &
echo $! >> "$PID_FILE"

# Wait for node 1 to be ready
wait_for_node $NODE1_HTTP_PORT

# Start Node 2 with Node 1's HTTP port for bootstrap
echo -e "${BLUE}Starting Node 2 (HTTP: $NODE2_HTTP_PORT, Gossip: $NODE2_GOSSIP_PORT)...${NC}"
echo "Bootstrapping from localhost:$NODE1_HTTP_PORT"
REPRAM_NODE_ID=node-2 \
NODE_ADDRESS=localhost \
REPRAM_PORT=$NODE2_HTTP_PORT \
REPRAM_GOSSIP_PORT=$NODE2_GOSSIP_PORT \
REPLICATION_FACTOR=3 \
REPRAM_BOOTSTRAP_PEERS="localhost:$NODE1_HTTP_PORT" \
./bin/cluster-node > node2.log 2>&1 &
echo $! >> "$PID_FILE"

# Wait for node 2 to be ready
wait_for_node $NODE2_HTTP_PORT

# Start Node 3 with Node 1's HTTP port for bootstrap
echo -e "${BLUE}Starting Node 3 (HTTP: $NODE3_HTTP_PORT, Gossip: $NODE3_GOSSIP_PORT)...${NC}"
echo "Bootstrapping from localhost:$NODE1_HTTP_PORT"
REPRAM_NODE_ID=node-3 \
NODE_ADDRESS=localhost \
REPRAM_PORT=$NODE3_HTTP_PORT \
REPRAM_GOSSIP_PORT=$NODE3_GOSSIP_PORT \
REPLICATION_FACTOR=3 \
REPRAM_BOOTSTRAP_PEERS="localhost:$NODE1_HTTP_PORT" \
./bin/cluster-node > node3.log 2>&1 &
echo $! >> "$PID_FILE"

# Wait for node 3 to be ready
wait_for_node $NODE3_HTTP_PORT

echo -e "${GREEN}All nodes started successfully!${NC}"
echo -e "${BLUE}Waiting for bootstrap to complete...${NC}"
sleep 3

# Test 1: Write to Node 1, read from all nodes
echo -e "\n${BLUE}Test 1: Write to Node 1, verify replication${NC}"
TEST_KEY="test-key-1"
TEST_DATA='{"message": "Hello from gossip test!"}'

echo "Writing to Node 1..."
curl -X PUT \
    -H "Content-Type: application/json" \
    -d "{\"data\": $(echo -n "$TEST_DATA" | base64 -w0 | jq -Rs .), \"ttl\": 300}" \
    "http://localhost:$NODE1_HTTP_PORT/data/$TEST_KEY"

echo -e "\n${BLUE}Waiting for gossip propagation...${NC}"
sleep 3

# Function to check if data exists on a node
check_data() {
    local port=$1
    local key=$2
    local node_name=$3
    
    echo -n "Checking $node_name (port $port)... "
    response=$(curl -s -w "\n%{http_code}" "http://localhost:$port/data/$key")
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n-1)
    
    if [ "$http_code" = "200" ]; then
        echo -e "${GREEN}Data found!${NC}"
        return 0
    else
        echo -e "${RED}Data not found (HTTP $http_code)${NC}"
        return 1
    fi
}

# Check all nodes
echo -e "\n${BLUE}Verifying replication...${NC}"
check_data $NODE1_HTTP_PORT $TEST_KEY "Node 1"
check_data $NODE2_HTTP_PORT $TEST_KEY "Node 2"
check_data $NODE3_HTTP_PORT $TEST_KEY "Node 3"

# Test 2: Write to Node 2, read from all nodes
echo -e "\n${BLUE}Test 2: Write to Node 2, verify replication${NC}"
TEST_KEY2="test-key-2"
TEST_DATA2='{"message": "Testing gossip from node 2"}'

echo "Writing to Node 2..."
curl -X PUT \
    -H "Content-Type: application/json" \
    -d "{\"data\": $(echo -n "$TEST_DATA2" | base64 -w0 | jq -Rs .), \"ttl\": 300}" \
    "http://localhost:$NODE2_HTTP_PORT/data/$TEST_KEY2"

echo -e "\n${BLUE}Waiting for gossip propagation...${NC}"
sleep 3

echo -e "\n${BLUE}Verifying replication...${NC}"
check_data $NODE1_HTTP_PORT $TEST_KEY2 "Node 1"
check_data $NODE2_HTTP_PORT $TEST_KEY2 "Node 2"
check_data $NODE3_HTTP_PORT $TEST_KEY2 "Node 3"

# Test 3: Simulate node failure and recovery
echo -e "\n${BLUE}Test 3: Node failure simulation${NC}"
echo "Stopping Node 3..."
NODE3_PID=$(tail -n1 "$PID_FILE")
kill $NODE3_PID 2>/dev/null || true

# Write while node 3 is down
TEST_KEY3="test-key-3"
TEST_DATA3='{"message": "Written while node 3 is down"}'

echo "Writing to Node 1 while Node 3 is down..."
curl -X PUT \
    -H "Content-Type: application/json" \
    -d "{\"data\": $(echo -n "$TEST_DATA3" | base64 -w0 | jq -Rs .), \"ttl\": 300}" \
    "http://localhost:$NODE1_HTTP_PORT/data/$TEST_KEY3"

sleep 2

echo -e "\n${BLUE}Verifying data on active nodes...${NC}"
check_data $NODE1_HTTP_PORT $TEST_KEY3 "Node 1"
check_data $NODE2_HTTP_PORT $TEST_KEY3 "Node 2"

# Restart Node 3
echo -e "\n${BLUE}Restarting Node 3...${NC}"
REPRAM_NODE_ID=node-3 \
NODE_ADDRESS=localhost \
REPRAM_PORT=$NODE3_HTTP_PORT \
REPRAM_GOSSIP_PORT=$NODE3_GOSSIP_PORT \
REPLICATION_FACTOR=3 \
REPRAM_BOOTSTRAP_PEERS="localhost:$NODE1_GOSSIP_PORT,localhost:$NODE2_GOSSIP_PORT" \
./bin/cluster-node > node3.log 2>&1 &
NEW_NODE3_PID=$!

# Update PID file
sed -i "s/$NODE3_PID/$NEW_NODE3_PID/" "$PID_FILE"

wait_for_node $NODE3_HTTP_PORT

echo -e "\n${BLUE}Checking if Node 3 can access previously written data...${NC}"
sleep 3
check_data $NODE3_HTTP_PORT $TEST_KEY "Node 3 - Key 1"
check_data $NODE3_HTTP_PORT $TEST_KEY2 "Node 3 - Key 2"
check_data $NODE3_HTTP_PORT $TEST_KEY3 "Node 3 - Key 3"

# Summary
echo -e "\n${GREEN}=== Test Summary ===${NC}"
echo "✓ 3-node cluster started successfully"
echo "✓ Data written to one node is replicated to others"
echo "✓ Cluster continues to function with one node down"
echo "✓ Restarted node can rejoin cluster"

echo -e "\n${BLUE}Check log files for detailed gossip activity:${NC}"
echo "  - node1.log"
echo "  - node2.log"
echo "  - node3.log"

echo -e "\n${BLUE}Nodes are still running. Press Ctrl+C to stop all nodes.${NC}"

# Keep script running
wait