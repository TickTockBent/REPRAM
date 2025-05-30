#!/bin/bash

# Simple debug script to test gossip with visible output

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}Building cluster node...${NC}"
go build -o bin/cluster-node cmd/cluster-node/main.go

# Kill any existing nodes
pkill -f cluster-node 2>/dev/null || true

echo -e "${BLUE}Starting Node 1 (port 8081, gossip 9091)...${NC}"
REPRAM_NODE_ID=node-1 \
NODE_ADDRESS=localhost \
REPRAM_PORT=8081 \
REPRAM_GOSSIP_PORT=9091 \
REPLICATION_FACTOR=3 \
./bin/cluster-node &
NODE1_PID=$!

sleep 2

echo -e "${BLUE}Starting Node 2 (port 8082, gossip 9092) with Node 1 as bootstrap...${NC}"
REPRAM_NODE_ID=node-2 \
NODE_ADDRESS=localhost \
REPRAM_PORT=8082 \
REPRAM_GOSSIP_PORT=9092 \
REPLICATION_FACTOR=3 \
REPRAM_BOOTSTRAP_PEERS="localhost:9091" \
./bin/cluster-node &
NODE2_PID=$!

sleep 2

echo -e "${GREEN}Both nodes started. Writing data to Node 1...${NC}"
curl -X PUT \
    -H "Content-Type: application/json" \
    -d '{"data": "SGVsbG8gZnJvbSBnb3NzaXAgdGVzdCE=", "ttl": 300}' \
    "http://localhost:8081/data/test-key"

echo -e "\n${BLUE}Waiting for gossip propagation...${NC}"
sleep 5

echo -e "\n${BLUE}Checking Node 1...${NC}"
curl -s "http://localhost:8081/data/test-key" || echo "Not found on Node 1"

echo -e "\n${BLUE}Checking Node 2...${NC}"
curl -s "http://localhost:8082/data/test-key" || echo "Not found on Node 2"

echo -e "\n${GREEN}Press Ctrl+C to stop nodes${NC}"
wait