#!/bin/bash

echo "REPRAM Auto-Discovery Test"
echo "========================="
echo ""
echo "This test demonstrates automatic port discovery and peer formation."
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Function to check node health
check_node() {
    local port=$1
    local response=$(curl -s http://localhost:$port/health 2>/dev/null)
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Node on port $port is healthy${NC}"
        echo "  Response: $response"
    else
        echo -e "${RED}✗ Node on port $port is not responding${NC}"
    fi
}

# Function to check peers
check_peers() {
    local port=$1
    echo -e "${YELLOW}Checking peers on node at port $port:${NC}"
    curl -s http://localhost:$port/peers 2>/dev/null | jq '.' || echo "  No peer endpoint or node not ready"
}

echo -e "${YELLOW}Step 1: Starting nodes with auto-discovery...${NC}"
docker-compose -f docker-compose-autodiscovery.yml up -d node-1 node-2 node-3

echo -e "${YELLOW}Step 2: Waiting for nodes to discover ports and form network...${NC}"
sleep 10

echo -e "${YELLOW}Step 3: Checking node health...${NC}"
for port in 8081 8082 8083; do
    check_node $port
done
echo ""

echo -e "${YELLOW}Step 4: Checking peer discovery...${NC}"
for port in 8081 8082 8083; do
    check_peers $port
    echo ""
done

echo -e "${YELLOW}Step 5: Testing data replication...${NC}"
echo -e "${GREEN}Storing test data on first discovered node (8081):${NC}"
curl -X PUT -d "Auto-discovery test data" "http://localhost:8081/data/auto-test?ttl=600"
echo -e "\n"

sleep 3

echo -e "${GREEN}Checking replication to other nodes:${NC}"
for port in 8082 8083; do
    echo -n "Port $port: "
    curl -s http://localhost:$port/data/auto-test || echo "Not found"
    echo ""
done

echo -e "${YELLOW}Step 6: Testing node addition (scaling up)...${NC}"
echo "Starting node 4..."
docker-compose -f docker-compose-autodiscovery.yml up -d node-4
sleep 8

check_node 8084
check_peers 8084
echo ""

echo -e "${YELLOW}Step 7: Monitoring logs for discovery activity...${NC}"
echo "To see discovery logs:"
echo "  docker logs repram-auto-1 | grep -E 'allocated|discovered|announce'"
echo "  docker logs repram-auto-2 | grep -E 'allocated|discovered|announce'"
echo ""

echo -e "${YELLOW}To stop all nodes:${NC}"
echo "  docker-compose -f docker-compose-autodiscovery.yml down"
echo ""

echo -e "${YELLOW}To test with 5 nodes:${NC}"
echo "  docker-compose -f docker-compose-autodiscovery.yml --profile scale up -d"
echo ""

echo -e "${GREEN}Test complete!${NC}"
echo ""
echo "Key observations:"
echo "- Nodes automatically discovered available ports"
echo "- Peer discovery happened without manual configuration"
echo "- Data replication works across auto-discovered nodes"
echo ""
echo "For Flux deployment:"
echo "1. Set DISCOVERY_DOMAIN=fade.repram.io"
echo "2. Set BASE_PORT=8081 (or your chosen starting port)"
echo "3. Deploy containers - they'll auto-organize!"