#!/bin/bash

# Gossip message monitoring script for fade Docker Compose cluster
# Shows real-time gossip protocol activity from container logs

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

# Docker compose file to use
COMPOSE_FILE="docker-compose-flux-test.yml"

# Check if docker-compose is available
if ! command -v docker-compose &> /dev/null; then
    echo -e "${RED}Error: docker-compose not found${NC}"
    exit 1
fi

# Service names for cluster nodes
SERVICES=(
    "fade-node-1|Node 1|${GREEN}"
    "fade-node-2|Node 2|${BLUE}"
    "fade-node-3|Node 3|${MAGENTA}"
)

# Function to colorize message types
colorize_message() {
    local line="$1"
    local node_color="$2"
    
    # Color based on message type
    if echo "$line" | grep -q "Broadcasting PUT\|broadcast.*PUT"; then
        echo -e "${YELLOW}[PUT-BROADCAST]${NC} $line"
    elif echo "$line" | grep -q "Received PUT\|received.*PUT"; then
        echo -e "${GREEN}[PUT-RECEIVED]${NC} $line"
    elif echo "$line" | grep -q "Sending ACK\|ACK.*sent"; then
        echo -e "${CYAN}[ACK-SEND]${NC} $line"
    elif echo "$line" | grep -q "Bootstrap\|bootstrap"; then
        echo -e "${MAGENTA}[BOOTSTRAP]${NC} $line"
    elif echo "$line" | grep -q "SYNC\|sync"; then
        echo -e "${BLUE}[SYNC]${NC} $line"
    elif echo "$line" | grep -q "Notified\|notify"; then
        echo -e "${BLUE}[SYNC-NOTIFY]${NC} $line"
    elif echo "$line" | grep -q "Learned about\|discovered.*peer"; then
        echo -e "${BLUE}[PEER-DISCOVERY]${NC} $line"
    elif echo "$line" | grep -q "PING\|ping"; then
        echo -e "${node_color}[PING]${NC} $line"
    elif echo "$line" | grep -q "PONG\|pong"; then
        echo -e "${node_color}[PONG]${NC} $line"
    elif echo "$line" | grep -q "peers\|peer.*update"; then
        echo -e "${CYAN}[PEERS]${NC} $line"
    elif echo "$line" | grep -q "Transport\|transport"; then
        echo -e "${node_color}[TRANSPORT]${NC} $line"
    elif echo "$line" | grep -q "cluster.*node\|node.*join"; then
        echo -e "${MAGENTA}[CLUSTER]${NC} $line"
    elif echo "$line" | grep -q "replication\|replicate"; then
        echo -e "${YELLOW}[REPLICATION]${NC} $line"
    else
        echo "$line"
    fi
}

# Function to monitor a single service
monitor_service() {
    local service_name="$1"
    local node_name="$2"
    local node_color="$3"
    
    # Check if service is running
    local container_id=$(docker-compose -f "$COMPOSE_FILE" ps -q "$service_name" 2>/dev/null)
    if [ -z "$container_id" ]; then
        return
    fi
    
    # Follow logs and filter for gossip-related messages
    docker-compose -f "$COMPOSE_FILE" logs -f --tail=0 "$service_name" 2>/dev/null | while read line; do
        # Remove docker-compose prefix (service name and |)
        clean_line=$(echo "$line" | sed "s/^$service_name[[:space:]]*|[[:space:]]*//" )
        
        # Filter for gossip-related messages
        if echo "$clean_line" | grep -E "(gossip|Gossip|Bootstrap|bootstrap|SYNC|sync|Broadcasting|broadcast|Received|received|ACK|ack|peers|peer|PING|ping|PONG|pong|Transport|transport|Notified|notify|Learned|discovered|cluster|replication|replicate)" >/dev/null; then
            # Add timestamp and node identifier
            timestamp=$(date '+%H:%M:%S')
            formatted_line=$(colorize_message "$clean_line" "$node_color")
            echo -e "${node_color}[$timestamp $node_name]${NC} $formatted_line"
        fi
    done
}

clear

echo -e "${BLUE}=== FADE Docker Compose Gossip Monitor ===${NC}"
echo -e "Monitoring gossip messages from: $COMPOSE_FILE"
echo -e "Press Ctrl+C to exit\n"

echo -e "${YELLOW}Message Types:${NC}"
echo -e "  ${YELLOW}[PUT-BROADCAST]${NC} - Node broadcasting data to peers"
echo -e "  ${GREEN}[PUT-RECEIVED]${NC} - Node received replicated data"
echo -e "  ${CYAN}[ACK-SEND]${NC} - Node acknowledging data receipt"
echo -e "  ${MAGENTA}[BOOTSTRAP]${NC} - Node joining cluster"
echo -e "  ${BLUE}[SYNC]${NC} - Peer synchronization messages"
echo -e "  ${BLUE}[PEER-DISCOVERY]${NC} - New peer discovered"
echo -e "  ${MAGENTA}[CLUSTER]${NC} - Cluster formation messages"
echo -e "  ${YELLOW}[REPLICATION]${NC} - Data replication activity"
echo -e "  [PING/PONG] - Health check messages"
echo -e "\n${YELLOW}Waiting for gossip activity...${NC}\n"

# Check if any cluster services are running
services_running=false
for service_info in "${SERVICES[@]}"; do
    IFS='|' read -r service_name node_name node_color <<< "$service_info"
    container_id=$(docker-compose -f "$COMPOSE_FILE" ps -q "$service_name" 2>/dev/null)
    if [ -n "$container_id" ]; then
        services_running=true
        break
    fi
done

if [ "$services_running" = false ]; then
    echo -e "${RED}Error: No cluster services running!${NC}"
    echo "Start the cluster first:"
    echo "  docker-compose -f $COMPOSE_FILE up"
    exit 1
fi

# Show which services we're monitoring
echo -e "${BLUE}Monitoring services:${NC}"
for service_info in "${SERVICES[@]}"; do
    IFS='|' read -r service_name node_name node_color <<< "$service_info"
    container_id=$(docker-compose -f "$COMPOSE_FILE" ps -q "$service_name" 2>/dev/null)
    if [ -n "$container_id" ]; then
        echo -e "  ${node_color}$node_name${NC} ($service_name) - ✓ running"
    else
        echo -e "  ${node_color}$node_name${NC} ($service_name) - ✗ not running"
    fi
done

echo -e "\n${GREEN}Monitoring active. Gossip messages will appear below.${NC}"
echo -e "${YELLOW}Tip: Open the Fade UI and send messages to generate gossip traffic!${NC}"
echo -e "${CYAN}Access UI at: http://localhost:3000, http://localhost:3010, or http://localhost:3020${NC}\n"

# Start monitoring all services in parallel
for service_info in "${SERVICES[@]}"; do
    IFS='|' read -r service_name node_name node_color <<< "$service_info"
    monitor_service "$service_name" "$node_name" "$node_color" &
done

# Keep script running
wait