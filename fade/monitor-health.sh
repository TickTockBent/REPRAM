#!/bin/bash

# Health monitoring script for fade Docker Compose cluster
# Shows real-time health status of all containers

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Docker compose file to use
COMPOSE_FILE="docker-compose-flux-test.yml"

# Check if docker-compose is available
if ! command -v docker-compose &> /dev/null; then
    echo -e "${RED}Error: docker-compose not found${NC}"
    exit 1
fi

# Function to check if container is running
check_container_health() {
    local service_name=$1
    local status=$(docker-compose -f "$COMPOSE_FILE" ps -q "$service_name" 2>/dev/null)
    
    if [ -n "$status" ]; then
        local health=$(docker inspect --format='{{.State.Health.Status}}' $(docker-compose -f "$COMPOSE_FILE" ps -q "$service_name" 2>/dev/null) 2>/dev/null)
        local running=$(docker inspect --format='{{.State.Running}}' $(docker-compose -f "$COMPOSE_FILE" ps -q "$service_name" 2>/dev/null) 2>/dev/null)
        
        if [ "$running" = "true" ]; then
            if [ "$health" = "healthy" ]; then
                echo -e "${GREEN}✓ healthy${NC}"
            elif [ "$health" = "unhealthy" ]; then
                echo -e "${RED}✗ unhealthy${NC}"
            elif [ "$health" = "starting" ]; then
                echo -e "${YELLOW}⚠ starting${NC}"
            else
                echo -e "${GREEN}✓ running${NC}"
            fi
        else
            echo -e "${RED}✗ stopped${NC}"
        fi
    else
        echo -e "${RED}✗ not found${NC}"
    fi
}

# Function to check HTTP endpoint
check_endpoint() {
    local url=$1
    if curl -s --connect-timeout 2 "$url" >/dev/null 2>&1; then
        echo -e "${GREEN}✓${NC}"
    else
        echo -e "${RED}✗${NC}"
    fi
}

# Function to get container logs count (errors)
get_error_count() {
    local service_name=$1
    local container_id=$(docker-compose -f "$COMPOSE_FILE" ps -q "$service_name" 2>/dev/null)
    if [ -n "$container_id" ]; then
        local errors=$(docker logs "$container_id" 2>&1 | grep -i "error\|fail\|fatal" | wc -l)
        if [ "$errors" -gt 0 ]; then
            echo -e "${RED}$errors errors${NC}"
        else
            echo -e "${GREEN}0 errors${NC}"
        fi
    else
        echo -e "${RED}N/A${NC}"
    fi
}

# Clear screen for clean display
clear

echo -e "${BLUE}=== FADE Docker Compose Health Monitor ===${NC}"
echo -e "Monitoring: $COMPOSE_FILE"
echo -e "Press Ctrl+C to exit\n"

# Main monitoring loop
while true; do
    # Clear screen for clean display
    clear
    
    echo -e "${BLUE}=== FADE Docker Compose Health Monitor ===${NC}"
    echo -e "Monitoring: $COMPOSE_FILE"
    echo -e "Press Ctrl+C to exit\n"
    
    # Print header
    echo -e "${BLUE}Timestamp:${NC} $(date '+%Y-%m-%d %H:%M:%S')"
    echo
    echo -e "${BLUE}Cluster Nodes:${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    printf "%-12s %-15s %-15s %-15s %-15s %-15s\n" "Service" "Container" "HTTP" "Gossip" "Endpoint" "Errors"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    # Check cluster nodes
    for i in 1 2 3; do
        service="fade-node-$i"
        port=$((8079 + i))
        gossip_port=$((9089 + i))
        
        container_status=$(check_container_health "$service")
        endpoint_status=$(check_endpoint "http://localhost:$port/health")
        error_count=$(get_error_count "$service")
        
        printf "%-12s %-15s %-15s %-15s %-15s %-15s\n" \
            "$service" \
            "$container_status" \
            "localhost:$port" \
            "localhost:$gossip_port" \
            "$endpoint_status" \
            "$error_count"
    done
    
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    echo -e "\n${BLUE}Fade Servers:${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    printf "%-12s %-15s %-15s %-15s %-15s\n" "Service" "Container" "Port" "Endpoint" "Errors"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    # Check fade servers
    ports=(3000 3010 3020)
    for i in 1 2 3; do
        service="fade-web-$i"
        port=${ports[$((i-1))]}
        
        container_status=$(check_container_health "$service")
        endpoint_status=$(check_endpoint "http://localhost:$port/health")
        error_count=$(get_error_count "$service")
        
        printf "%-12s %-15s %-15s %-15s %-15s\n" \
            "$service" \
            "$container_status" \
            "localhost:$port" \
            "$endpoint_status" \
            "$error_count"
    done
    
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    # Overall status
    echo -e "\n${BLUE}Overall Status:${NC}"
    
    # Count healthy services
    healthy_nodes=0
    healthy_web=0
    
    for i in 1 2 3; do
        if curl -s --connect-timeout 1 "http://localhost:$((8079 + i))/health" >/dev/null 2>&1; then
            healthy_nodes=$((healthy_nodes + 1))
        fi
        
        port=${ports[$((i-1))]}
        if curl -s --connect-timeout 1 "http://localhost:$port/health" >/dev/null 2>&1; then
            healthy_web=$((healthy_web + 1))
        fi
    done
    
    echo "Cluster Nodes: $healthy_nodes/3 healthy"
    echo "Fade Servers: $healthy_web/3 healthy"
    
    if [ $healthy_nodes -ge 2 ] && [ $healthy_web -ge 1 ]; then
        echo -e "${GREEN}✓ System operational${NC}"
    elif [ $healthy_nodes -ge 1 ] && [ $healthy_web -ge 1 ]; then
        echo -e "${YELLOW}⚠ Degraded but functional${NC}"
    else
        echo -e "${RED}✗ System down${NC}"
    fi
    
    # Quick actions
    echo -e "\n${BLUE}Quick Actions:${NC}"
    echo "View logs: docker-compose -f $COMPOSE_FILE logs [service-name]"
    echo "Restart:   docker-compose -f $COMPOSE_FILE restart [service-name]"
    echo "Stop all:  docker-compose -f $COMPOSE_FILE down"
    
    # Show stats
    echo -e "\n${YELLOW}Refreshing every 5 seconds... (Last: $(date '+%H:%M:%S'))${NC}"
    
    # Wait before next update
    sleep 5
done