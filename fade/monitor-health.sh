#!/bin/bash

# Health monitoring script for fade gossip nodes
# Shows real-time health status of all 3 nodes

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Node configuration
NODES=(
    "Node 1|8080|7080"
    "Node 2|8081|7081"
    "Node 3|8082|7082"
)

# Function to check node health
check_node_health() {
    local port=$1
    if curl -s "http://localhost:$port/health" >/dev/null 2>&1; then
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${RED}✗${NC}"
    fi
}

# Function to check if data exists on node
check_data_count() {
    local port=$1
    # Try to get a known test key to see if node has data
    # This is a simple check - in production you'd want a stats endpoint
    if curl -s "http://localhost:$port/data/test-ping" >/dev/null 2>&1; then
        echo -e "${GREEN}Has data${NC}"
    else
        echo -e "${YELLOW}No test data${NC}"
    fi
}

# Function to check process status
check_process() {
    local port=$1
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
        local pid=$(lsof -Pi :$port -sTCP:LISTEN -t 2>/dev/null | head -1)
        echo -e "${GREEN}PID: $pid${NC}"
    else
        echo -e "${RED}Not running${NC}"
    fi
}

# Clear screen for clean display
clear

echo -e "${BLUE}=== FADE Gossip Cluster Health Monitor ===${NC}"
echo -e "Press Ctrl+C to exit\n"

# Main monitoring loop
while true; do
    # Move cursor to home position (don't clear to reduce flicker)
    tput cup 3 0
    
    # Print header
    echo -e "${BLUE}Timestamp:${NC} $(date '+%Y-%m-%d %H:%M:%S')"
    echo
    echo -e "${BLUE}Node Status:${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    printf "%-10s %-15s %-15s %-15s %-15s\n" "Node" "HTTP Port" "Gossip Port" "Health" "Process"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    # Check each node
    for node_info in "${NODES[@]}"; do
        IFS='|' read -r name http_port gossip_port <<< "$node_info"
        
        health=$(check_node_health $http_port)
        process=$(check_process $http_port)
        
        printf "%-10s %-15s %-15s %-15s %-15s\n" \
            "$name" \
            "localhost:$http_port" \
            "localhost:$gossip_port" \
            "$health" \
            "$process"
    done
    
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    # Quick data replication test
    echo -e "\n${BLUE}Quick Replication Test:${NC}"
    echo "Writing test data to Node 1..."
    
    # Write a test key with timestamp
    test_key="test-ping-$(date +%s)"
    if curl -s -X PUT \
        -H "Content-Type: application/json" \
        -d "{\"data\": \"$(echo -n "ping at $(date)" | base64)\", \"ttl\": 60}" \
        "http://localhost:8080/data/$test_key" >/dev/null 2>&1; then
        
        echo -n "Checking replication: "
        sleep 1
        
        # Check if data replicated to other nodes
        replicated=0
        for port in 8081 8082; do
            if curl -s "http://localhost:$port/data/$test_key" >/dev/null 2>&1; then
                ((replicated++))
            fi
        done
        
        if [ $replicated -eq 2 ]; then
            echo -e "${GREEN}✓ Fully replicated (3/3 nodes)${NC}"
        elif [ $replicated -eq 1 ]; then
            echo -e "${YELLOW}⚠ Partially replicated (2/3 nodes)${NC}"
        else
            echo -e "${RED}✗ Not replicated (1/3 nodes)${NC}"
        fi
    else
        echo -e "${RED}✗ Failed to write test data${NC}"
    fi
    
    # Web server status
    echo -e "\n${BLUE}Web Server Status:${NC}"
    if curl -s "http://localhost:3000/api/health" >/dev/null 2>&1; then
        echo -e "Fade UI: ${GREEN}✓ Running on http://localhost:3000${NC}"
    else
        echo -e "Fade UI: ${RED}✗ Not running${NC}"
    fi
    
    # Show hint
    echo -e "\n${YELLOW}Refreshing every 5 seconds...${NC}"
    
    # Wait before next update
    sleep 5
done