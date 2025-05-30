#!/bin/bash

# Debug script to check peer discovery

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}Starting 3-node cluster with verbose output...${NC}"

# Kill any existing nodes
pkill -f cluster-node 2>/dev/null || true
sleep 1

# Start Node 1
echo -e "\n${BLUE}=== Starting Node 1 ===${NC}"
REPRAM_NODE_ID=node-1 \
NODE_ADDRESS=localhost \
REPRAM_PORT=8081 \
REPRAM_GOSSIP_PORT=9091 \
REPLICATION_FACTOR=3 \
./bin/cluster-node 2>&1 | sed 's/^/[NODE1] /' &

sleep 2

# Start Node 2
echo -e "\n${BLUE}=== Starting Node 2 ===${NC}"
REPRAM_NODE_ID=node-2 \
NODE_ADDRESS=localhost \
REPRAM_PORT=8082 \
REPRAM_GOSSIP_PORT=9092 \
REPLICATION_FACTOR=3 \
REPRAM_BOOTSTRAP_PEERS="localhost:8081" \
./bin/cluster-node 2>&1 | sed 's/^/[NODE2] /' &

sleep 3

# Start Node 3
echo -e "\n${BLUE}=== Starting Node 3 ===${NC}"
REPRAM_NODE_ID=node-3 \
NODE_ADDRESS=localhost \
REPRAM_PORT=8083 \
REPRAM_GOSSIP_PORT=9093 \
REPLICATION_FACTOR=3 \
REPRAM_BOOTSTRAP_PEERS="localhost:8081" \
./bin/cluster-node 2>&1 | sed 's/^/[NODE3] /' &

sleep 3

echo -e "\n${GREEN}=== Testing Peer Discovery ===${NC}"
echo -e "${YELLOW}Expected: Each node should know about all others${NC}"

# Write to Node 2 and see who gets it
echo -e "\n${BLUE}Writing to Node 2...${NC}"
curl -X PUT \
    -H "Content-Type: application/json" \
    -d '{"data": "VGVzdCBkYXRh", "ttl": 300}' \
    "http://localhost:8082/data/test-key" 2>&1 | sed 's/^/[CURL] /'

sleep 3

echo -e "\n${BLUE}Checking all nodes...${NC}"
for port in 8081 8082 8083; do
    echo -n "Node on port $port: "
    curl -s "http://localhost:$port/data/test-key" >/dev/null 2>&1 && echo -e "${GREEN}Has data${NC}" || echo -e "${YELLOW}No data${NC}"
done

echo -e "\n${BLUE}Press Ctrl+C to stop${NC}"
wait