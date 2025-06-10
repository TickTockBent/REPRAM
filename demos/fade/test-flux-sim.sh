#!/bin/bash

echo "REPRAM Flux Simulation Test"
echo "==========================="
echo ""
echo "This test runs multiple REPRAM nodes in a single container,"
echo "simulating how Flux deploys multiple instances with shared IP."
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Function to wait for container to be healthy
wait_for_container() {
    local container=$1
    local max_wait=30
    local waited=0
    
    echo -n "Waiting for $container to be ready"
    while [ $waited -lt $max_wait ]; do
        if docker exec $container ls >/dev/null 2>&1; then
            echo -e " ${GREEN}✓${NC}"
            return 0
        fi
        echo -n "."
        sleep 1
        waited=$((waited + 1))
    done
    echo -e " ${RED}✗${NC}"
    return 1
}

echo -e "${YELLOW}Step 1: Building and starting Flux simulation container...${NC}"
docker-compose -f docker-compose-flux-sim.yml up -d flux-sim

if ! wait_for_container "repram-flux-sim"; then
    echo -e "${RED}Container failed to start!${NC}"
    docker logs repram-flux-sim
    exit 1
fi

echo -e "${YELLOW}Step 2: Waiting for nodes to auto-discover and claim ports...${NC}"
sleep 10

echo -e "${YELLOW}Step 3: Checking which nodes are running...${NC}"
ACTIVE_NODES=()
for port in 8081 8082 8083 8084 8085; do
    if curl -s http://localhost:$port/health >/dev/null 2>&1; then
        NODE_INFO=$(curl -s http://localhost:$port/health 2>/dev/null | jq -r '.node_id // "unknown"')
        echo -e "${GREEN}✓ Port $port: $NODE_INFO${NC}"
        ACTIVE_NODES+=($port)
    fi
done

if [ ${#ACTIVE_NODES[@]} -eq 0 ]; then
    echo -e "${RED}No nodes found! Checking container logs...${NC}"
    docker logs repram-flux-sim | tail -30
    exit 1
fi

echo ""
echo -e "${GREEN}Successfully started ${#ACTIVE_NODES[@]} nodes${NC}"

echo -e "${YELLOW}Step 4: Checking peer discovery...${NC}"
FIRST_PORT=${ACTIVE_NODES[0]}
echo "Querying node on port $FIRST_PORT for peer information:"
curl -s http://localhost:$FIRST_PORT/peers 2>/dev/null | jq '.' || echo "No peer data available"
echo ""

echo -e "${YELLOW}Step 5: Testing data replication...${NC}"
TEST_KEY="flux-sim-test-$(date +%s)"
TEST_DATA="Data from Flux simulation test"

echo -e "Storing data on port $FIRST_PORT:"
curl -X PUT -d "$TEST_DATA" "http://localhost:$FIRST_PORT/data/$TEST_KEY?ttl=600"
echo -e "\n"

sleep 3

echo -e "Verifying replication to other nodes:"
for port in "${ACTIVE_NODES[@]}"; do
    if [ $port -ne $FIRST_PORT ]; then
        echo -n "Port $port: "
        RESULT=$(curl -s http://localhost:$port/data/$TEST_KEY 2>/dev/null)
        if [ "$RESULT" = "$TEST_DATA" ]; then
            echo -e "${GREEN}✓ Replicated successfully${NC}"
        else
            echo -e "${RED}✗ Not replicated${NC}"
        fi
    fi
done

echo ""
echo -e "${YELLOW}Step 6: Viewing container logs...${NC}"
echo "Recent discovery activity:"
docker exec repram-flux-sim tail -n 20 /tmp/flux-node-1.log | grep -E 'allocated|discovered|Starting' || echo "No logs found"

echo ""
echo -e "${YELLOW}Step 7: Testing with Fade UI (optional)...${NC}"
echo "To start Fade server connected to these nodes:"
echo "  docker-compose -f docker-compose-flux-sim.yml --profile with-fade up -d"
echo ""

echo -e "${YELLOW}To monitor the nodes inside the container:${NC}"
echo "  docker exec repram-flux-sim tail -f /tmp/flux-node-*.log"
echo ""

echo -e "${YELLOW}To stop the simulation:${NC}"
echo "  docker-compose -f docker-compose-flux-sim.yml down"
echo ""

echo -e "${GREEN}Test complete!${NC}"
echo ""
echo "This simulation demonstrates:"
echo "- Multiple REPRAM instances in one container (like Flux)"
echo "- Automatic port discovery and allocation"
echo "- Peer discovery without manual configuration"
echo "- Data replication across all instances"
echo ""
echo "For actual Flux deployment:"
echo "1. Set DISCOVERY_DOMAIN=fade.repram.io"
echo "2. Ensure NODE_COUNT matches Flux instance count"
echo "3. All instances will auto-organize using the same mechanism"