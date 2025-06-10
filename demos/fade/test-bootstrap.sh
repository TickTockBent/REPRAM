#!/bin/bash

echo "REPRAM Bootstrap Test"
echo "===================="
echo ""
echo "This test demonstrates nodes discovering each other through a known peer."
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Step 1: Starting home node...${NC}"
docker-compose -f docker-compose-home.yml up -d
sleep 5

echo -e "${YELLOW}Step 2: Checking home node health...${NC}"
curl -s http://localhost:8080/health || echo "Home node not ready yet"
echo ""

echo -e "${YELLOW}Step 3: Starting remote nodes (they will bootstrap from home node)...${NC}"
docker-compose -f docker-compose-remote.yml up -d
sleep 10

echo -e "${YELLOW}Step 4: Testing data propagation...${NC}"
echo ""

# Store data on home node
echo -e "${GREEN}Storing test data on home node:${NC}"
curl -X PUT -d "Hello from home node" "http://localhost:8080/data/test-key?ttl=600"
echo ""

sleep 3

# Check if data replicated to remote nodes
echo -e "${GREEN}Checking replication to remote nodes:${NC}"
echo -n "Remote node 1: "
curl -s http://localhost:8081/data/test-key || echo "Not found"
echo -n "Remote node 2: "
curl -s http://localhost:8082/data/test-key || echo "Not found"
echo -n "Remote node 3: "
curl -s http://localhost:8083/data/test-key || echo "Not found"
echo ""

echo -e "${YELLOW}Step 5: Checking network topology...${NC}"
echo "You can monitor gossip activity with:"
echo "  docker logs repram-home-node"
echo "  docker logs repram-remote-1"
echo ""

echo -e "${YELLOW}To stop all nodes:${NC}"
echo "  docker-compose -f docker-compose-home.yml down"
echo "  docker-compose -f docker-compose-remote.yml down"
echo ""

echo -e "${GREEN}Test complete!${NC}"
echo ""
echo "For Flux deployment:"
echo "1. Deploy your home node with a public IP/domain"
echo "2. Set REPRAM_BOOTSTRAP_PEERS=your-home-node.com:8080 for Flux nodes"
echo "3. Nodes will automatically discover each other through gossip"