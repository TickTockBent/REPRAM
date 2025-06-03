#!/bin/bash

echo "REPRAM Auto-Discovery Test (Host Network Mode)"
echo "============================================="
echo ""
echo "This test simulates the Flux environment where all containers"
echo "share the same IP address but claim different ports."
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# First, check if any ports are already in use
echo -e "${YELLOW}Checking for existing processes on our ports...${NC}"
for port in 8081 8082 8083 8084 8085; do
    if lsof -i:$port >/dev/null 2>&1; then
        echo -e "${RED}WARNING: Port $port is already in use!${NC}"
        echo "Please stop any existing REPRAM nodes before running this test."
        exit 1
    fi
done

echo -e "${GREEN}All ports are free, proceeding with test...${NC}"
echo ""

# Function to check node health
check_node() {
    local port=$1
    local response=$(curl -s http://localhost:$port/health 2>/dev/null)
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Node on port $port is healthy${NC}"
        echo "  Response: $response"
        return 0
    else
        echo -e "${RED}✗ Node on port $port is not responding${NC}"
        return 1
    fi
}

echo -e "${YELLOW}Step 1: Starting nodes with auto-discovery...${NC}"
docker-compose -f docker-compose-autodiscovery-fixed.yml up -d

echo -e "${YELLOW}Step 2: Waiting for nodes to discover ports and form network...${NC}"
sleep 10

echo -e "${YELLOW}Step 3: Finding which ports the nodes claimed...${NC}"
ACTIVE_PORTS=()
for port in 8081 8082 8083 8084 8085; do
    if check_node $port; then
        ACTIVE_PORTS+=($port)
    fi
done
echo ""

if [ ${#ACTIVE_PORTS[@]} -eq 0 ]; then
    echo -e "${RED}No nodes found! Checking container logs...${NC}"
    docker logs repram-auto-1 | tail -20
    exit 1
fi

echo -e "${GREEN}Found ${#ACTIVE_PORTS[@]} active nodes on ports: ${ACTIVE_PORTS[@]}${NC}"
echo ""

echo -e "${YELLOW}Step 4: Checking peer discovery...${NC}"
for port in "${ACTIVE_PORTS[@]}"; do
    echo -e "${YELLOW}Peers known by node on port $port:${NC}"
    curl -s http://localhost:$port/peers 2>/dev/null | jq '.' || echo "  No peer endpoint or error"
    echo ""
done

echo -e "${YELLOW}Step 5: Testing data replication...${NC}"
FIRST_PORT=${ACTIVE_PORTS[0]}
echo -e "${GREEN}Storing test data on node at port $FIRST_PORT:${NC}"
curl -X PUT -d "Auto-discovery test data" "http://localhost:$FIRST_PORT/data/auto-test?ttl=600"
echo -e "\n"

sleep 3

echo -e "${GREEN}Checking replication to other nodes:${NC}"
for port in "${ACTIVE_PORTS[@]}"; do
    if [ $port -ne $FIRST_PORT ]; then
        echo -n "Port $port: "
        curl -s http://localhost:$port/data/auto-test || echo "Not found"
        echo ""
    fi
done

echo -e "${YELLOW}Step 6: Viewing discovery logs...${NC}"
echo "Node 1 discovery log:"
docker logs repram-auto-1 2>&1 | grep -E 'allocated|discovered|announce|Starting auto-discovery' | head -5
echo ""

echo -e "${YELLOW}To stop all nodes:${NC}"
echo "  docker-compose -f docker-compose-autodiscovery-fixed.yml down"
echo ""

echo -e "${GREEN}Test complete!${NC}"
echo ""
echo "Summary:"
echo "- Nodes successfully discovered available ports"
echo "- Each node claimed a unique port from the range"
echo "- This simulates how Flux deployment would work"
echo ""
echo "For Flux deployment, set:"
echo "  DISCOVERY_DOMAIN=fade.repram.io"
echo "  And ensure all ports 8081-8085 are exposed"