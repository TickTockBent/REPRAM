#!/bin/bash

# Monitor script for gossip cluster activity
# This script provides real-time monitoring of gossip messages and cluster health

set -e

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Default ports
NODE1_HTTP_PORT=${NODE1_HTTP_PORT:-8081}
NODE2_HTTP_PORT=${NODE2_HTTP_PORT:-8082}
NODE3_HTTP_PORT=${NODE3_HTTP_PORT:-8083}

# Function to check node health
check_node_health() {
    local port=$1
    local node_name=$2
    
    if curl -s "http://localhost:$port/health" > /dev/null 2>&1; then
        echo -e "${GREEN}✓${NC} $node_name (port $port)"
    else
        echo -e "${RED}✗${NC} $node_name (port $port)"
    fi
}

# Function to count keys on each node
count_keys() {
    local port=$1
    local node_name=$2
    
    # This is a placeholder - in a real implementation, we'd need an endpoint
    # that returns the number of keys stored
    echo "  $node_name: [keys count not implemented]"
}

# Function to tail logs and highlight gossip messages
monitor_logs() {
    echo -e "\n${BLUE}=== Gossip Message Monitor ===${NC}"
    echo "Tailing log files for gossip activity..."
    echo "Press Ctrl+C to stop monitoring"
    
    # Use tail with grep to highlight gossip-related messages
    tail -f node*.log 2>/dev/null | grep --line-buffered -E "(gossip|Gossip|PING|PONG|JOIN|PUT|ACK|broadcast|Broadcast)" | while read line; do
        if echo "$line" | grep -q "PING"; then
            echo -e "${YELLOW}[PING]${NC} $line"
        elif echo "$line" | grep -q "PONG"; then
            echo -e "${GREEN}[PONG]${NC} $line"
        elif echo "$line" | grep -q "JOIN"; then
            echo -e "${BLUE}[JOIN]${NC} $line"
        elif echo "$line" | grep -q "PUT"; then
            echo -e "${GREEN}[PUT]${NC} $line"
        elif echo "$line" | grep -q "ACK"; then
            echo -e "${GREEN}[ACK]${NC} $line"
        else
            echo "$line"
        fi
    done
}

# Function to test data consistency
test_consistency() {
    local key=$1
    echo -e "\n${BLUE}Testing consistency for key: $key${NC}"
    
    # Try to get the key from each node
    for port in $NODE1_HTTP_PORT $NODE2_HTTP_PORT $NODE3_HTTP_PORT; do
        node_num=$((port - 8080))
        echo -n "Node $node_num: "
        
        response=$(curl -s -w "\n%{http_code}" "http://localhost:$port/data/$key" 2>/dev/null || echo "error")
        if [ "$response" = "error" ]; then
            echo -e "${RED}Node unreachable${NC}"
        else
            http_code=$(echo "$response" | tail -n1)
            if [ "$http_code" = "200" ]; then
                echo -e "${GREEN}Data found${NC}"
            elif [ "$http_code" = "404" ]; then
                echo -e "${YELLOW}Not found${NC}"
            else
                echo -e "${RED}Error (HTTP $http_code)${NC}"
            fi
        fi
    done
}

# Main monitoring loop
clear
echo -e "${GREEN}=== REPRAM Gossip Cluster Monitor ===${NC}"

case "${1:-status}" in
    status)
        while true; do
            clear
            echo -e "${GREEN}=== REPRAM Gossip Cluster Status ===${NC}"
            echo -e "Time: $(date)"
            echo -e "\n${BLUE}Node Health:${NC}"
            check_node_health $NODE1_HTTP_PORT "Node 1"
            check_node_health $NODE2_HTTP_PORT "Node 2"
            check_node_health $NODE3_HTTP_PORT "Node 3"
            
            echo -e "\n${BLUE}Recent Gossip Activity:${NC}"
            # Show last 5 gossip messages from logs
            if [ -f "node1.log" ] || [ -f "node2.log" ] || [ -f "node3.log" ]; then
                tail -n 50 node*.log 2>/dev/null | grep -E "(PING|PONG|JOIN|PUT|ACK)" | tail -n 5 || echo "No recent gossip activity"
            else
                echo "No log files found"
            fi
            
            echo -e "\nPress Ctrl+C to exit, or wait for refresh..."
            sleep 5
        done
        ;;
        
    logs)
        monitor_logs
        ;;
        
    test)
        if [ -z "$2" ]; then
            echo "Usage: $0 test <key>"
            exit 1
        fi
        test_consistency "$2"
        ;;
        
    write)
        if [ -z "$2" ] || [ -z "$3" ]; then
            echo "Usage: $0 write <key> <value> [node_port]"
            exit 1
        fi
        key="$2"
        value="$3"
        port="${4:-$NODE1_HTTP_PORT}"
        
        echo -e "${BLUE}Writing key '$key' to port $port...${NC}"
        curl -X PUT \
            -H "Content-Type: application/json" \
            -d "{\"data\": $(echo -n "$value" | base64 -w0 | jq -Rs .), \"ttl\": 300}" \
            "http://localhost:$port/data/$key"
        echo
        
        echo -e "\n${BLUE}Waiting for replication...${NC}"
        sleep 2
        
        test_consistency "$key"
        ;;
        
    *)
        echo "Usage: $0 {status|logs|test <key>|write <key> <value> [port]}"
        echo ""
        echo "Commands:"
        echo "  status         - Show cluster status (default)"
        echo "  logs           - Monitor gossip messages in real-time"
        echo "  test <key>     - Test data consistency for a key"
        echo "  write <key> <value> [port] - Write data and verify replication"
        exit 1
        ;;
esac