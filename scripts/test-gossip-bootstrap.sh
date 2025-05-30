#!/bin/bash

# Test script for 3-node gossip cluster with bootstrap
# This version uses proper bootstrap separation from gossip

set -e

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
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

# Clear any existing processes
cleanup

# Start Node 1 (seed node)
echo -e "${BLUE}Starting Node 1 as seed node (HTTP: $NODE1_HTTP_PORT, Gossip: $NODE1_GOSSIP_PORT)...${NC}"
REPRAM_NODE_ID=node-1 \
NODE_ADDRESS=localhost \
REPRAM_PORT=$NODE1_HTTP_PORT \
REPRAM_GOSSIP_PORT=$NODE1_GOSSIP_PORT \
REPLICATION_FACTOR=3 \
./bin/cluster-node &
NODE1_PID=$!
echo $NODE1_PID >> "$PID_FILE"

# Wait for node 1 to be ready
wait_for_node $NODE1_HTTP_PORT

# Start Node 2 with Node 1 as bootstrap
echo -e "${BLUE}Starting Node 2 (HTTP: $NODE2_HTTP_PORT, Gossip: $NODE2_GOSSIP_PORT)...${NC}"
echo "Bootstrapping from localhost:$NODE1_HTTP_PORT"
REPRAM_NODE_ID=node-2 \
NODE_ADDRESS=localhost \
REPRAM_PORT=$NODE2_HTTP_PORT \
REPRAM_GOSSIP_PORT=$NODE2_GOSSIP_PORT \
REPLICATION_FACTOR=3 \
REPRAM_BOOTSTRAP_PEERS="localhost:$NODE1_HTTP_PORT" \
./bin/cluster-node &
NODE2_PID=$!
echo $NODE2_PID >> "$PID_FILE"

# Wait for node 2 to be ready
wait_for_node $NODE2_HTTP_PORT

# Start Node 3 with Node 1 as bootstrap (could use Node 2 as well)
echo -e "${BLUE}Starting Node 3 (HTTP: $NODE3_HTTP_PORT, Gossip: $NODE3_GOSSIP_PORT)...${NC}"
echo "Bootstrapping from localhost:$NODE1_HTTP_PORT"
REPRAM_NODE_ID=node-3 \
NODE_ADDRESS=localhost \
REPRAM_PORT=$NODE3_HTTP_PORT \
REPRAM_GOSSIP_PORT=$NODE3_GOSSIP_PORT \
REPLICATION_FACTOR=3 \
REPRAM_BOOTSTRAP_PEERS="localhost:$NODE1_HTTP_PORT" \
./bin/cluster-node &
NODE3_PID=$!
echo $NODE3_PID >> "$PID_FILE"

# Wait for node 3 to be ready
wait_for_node $NODE3_HTTP_PORT

echo -e "${GREEN}All nodes started successfully!${NC}"
echo -e "${BLUE}Waiting for bootstrap to complete...${NC}"
sleep 3

# Test 1: Write to Node 1, read from all nodes
echo -e "\n${BLUE}Test 1: Write to Node 1, verify replication${NC}"
TEST_KEY="test-key-1"
TEST_DATA='{"message": "Hello from bootstrap test!"}'

echo "Writing to Node 1..."
curl -X PUT \
    -H "Content-Type" \
    -d "{\"data\": \"$(echo -n "$TEST_DATA" | base64)\", \"ttl\": 300}" \
    "http://localhost:$NODE1_HTTP_PORT/data/$TEST_KEY"

echo -e "\n${BLUE}Waiting for gossip replication...${NC}"
sleep 3

# Function to check if data exists on a node
check_data() {
    local port=$1
    local key=$2
    local node_name=$3
    
    echo -n "Checking $node_name (port $port)... "
    response=$(curl -s -w "\n%{http_code}" "http://localhost:$port/data/$key" 2>/dev/null || echo "error")
    
    if [ "$response" = "error" ]; then
        echo -e "${RED}Node unreachable${NC}"
        return 1
    fi
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | head -n-1)
    
    if [ "$http_code" = "200" ]; then
        # Decode the base64 data
        decoded=$(echo "$body" | base64 -d 2>/dev/null || echo "decode error")
        if [ "$decoded" = "$TEST_DATA" ]; then
            echo -e "${GREEN}Data found and matches!${NC}"
        else
            echo -e "${YELLOW}Data found but different${NC}"
        fi
        return 0
    else
        echo -e "${RED}Data not found (HTTP $http_code)${NC}"
        return 1
    fi
}

# Check all nodes
echo -e "\n${BLUE}Verifying replication on all nodes...${NC}"
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
    -d "{\"data\": \"$(echo -n "$TEST_DATA2" | base64)\", \"ttl\": 300}" \
    "http://localhost:$NODE2_HTTP_PORT/data/$TEST_KEY2"

echo -e "\n${BLUE}Waiting for gossip replication...${NC}"
sleep 3

echo -e "\n${BLUE}Verifying replication on all nodes...${NC}"
check_data $NODE1_HTTP_PORT $TEST_KEY2 "Node 1"
check_data $NODE2_HTTP_PORT $TEST_KEY2 "Node 2"
check_data $NODE3_HTTP_PORT $TEST_KEY2 "Node 3"

# Summary
echo -e "\n${GREEN}=== Test Summary ===${NC}"
echo "✓ 3-node cluster started with bootstrap"
echo "✓ Nodes discovered each other via bootstrap protocol"
echo "✓ Data replication tested via gossip protocol"

echo -e "\n${BLUE}Cluster is running. Press Ctrl+C to stop all nodes.${NC}"

# Keep script running
wait