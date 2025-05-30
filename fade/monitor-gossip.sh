#!/bin/bash

# Gossip message monitoring script for fade nodes
# Shows real-time gossip protocol activity

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

# Log files
LOG_FILES=(
    "cluster-node1.log|Node 1|${GREEN}"
    "cluster-node2.log|Node 2|${BLUE}"
    "cluster-node3.log|Node 3|${MAGENTA}"
)

# Function to colorize message types
colorize_message() {
    local line="$1"
    local node_color="$2"
    
    # Color based on message type
    if echo "$line" | grep -q "Broadcasting PUT"; then
        echo -e "${YELLOW}[PUT-BROADCAST]${NC} $line"
    elif echo "$line" | grep -q "Received PUT"; then
        echo -e "${GREEN}[PUT-RECEIVED]${NC} $line"
    elif echo "$line" | grep -q "Sending ACK"; then
        echo -e "${CYAN}[ACK-SEND]${NC} $line"
    elif echo "$line" | grep -q "Bootstrap"; then
        echo -e "${MAGENTA}[BOOTSTRAP]${NC} $line"
    elif echo "$line" | grep -q "SYNC"; then
        echo -e "${BLUE}[SYNC]${NC} $line"
    elif echo "$line" | grep -q "Notified"; then
        echo -e "${BLUE}[SYNC-NOTIFY]${NC} $line"
    elif echo "$line" | grep -q "Learned about"; then
        echo -e "${BLUE}[PEER-DISCOVERY]${NC} $line"
    elif echo "$line" | grep -q "PING"; then
        echo -e "${node_color}[PING]${NC} $line"
    elif echo "$line" | grep -q "PONG"; then
        echo -e "${node_color}[PONG]${NC} $line"
    elif echo "$line" | grep -q "peers"; then
        echo -e "${CYAN}[PEERS]${NC} $line"
    elif echo "$line" | grep -q "Transport"; then
        echo -e "${node_color}[TRANSPORT]${NC} $line"
    else
        echo "$line"
    fi
}

# Function to monitor a single log file
monitor_log() {
    local log_file="$1"
    local node_name="$2"
    local node_color="$3"
    
    if [ -f "$log_file" ]; then
        tail -f "$log_file" 2>/dev/null | while read line; do
            # Filter for gossip-related messages
            if echo "$line" | grep -E "(gossip|Gossip|Bootstrap|SYNC|Broadcasting|Received|ACK|peers|PING|PONG|Transport|Notified|Learned)" >/dev/null; then
                # Add timestamp and node identifier
                timestamp=$(date '+%H:%M:%S')
                formatted_line=$(colorize_message "$line" "$node_color")
                echo -e "${node_color}[$timestamp $node_name]${NC} $formatted_line"
            fi
        done
    fi
}

clear

echo -e "${BLUE}=== FADE Gossip Protocol Monitor ===${NC}"
echo -e "Monitoring gossip messages across all nodes"
echo -e "Press Ctrl+C to exit\n"

echo -e "${YELLOW}Message Types:${NC}"
echo -e "  ${YELLOW}[PUT-BROADCAST]${NC} - Node broadcasting data to peers"
echo -e "  ${GREEN}[PUT-RECEIVED]${NC} - Node received replicated data"
echo -e "  ${CYAN}[ACK-SEND]${NC} - Node acknowledging data receipt"
echo -e "  ${MAGENTA}[BOOTSTRAP]${NC} - Node joining cluster"
echo -e "  ${BLUE}[SYNC]${NC} - Peer synchronization messages"
echo -e "  ${BLUE}[PEER-DISCOVERY]${NC} - New peer discovered"
echo -e "  [PING/PONG] - Health check messages"
echo -e "\n${YELLOW}Waiting for gossip activity...${NC}\n"

# Check if log files exist
logs_exist=false
for log_info in "${LOG_FILES[@]}"; do
    IFS='|' read -r log_file node_name node_color <<< "$log_info"
    if [ -f "$log_file" ]; then
        logs_exist=true
        break
    fi
done

if [ "$logs_exist" = false ]; then
    echo -e "${RED}Error: No log files found!${NC}"
    echo "Make sure the gossip cluster is running:"
    echo "  ./start-gossip-multi-node.sh"
    exit 1
fi

# Start monitoring all log files in parallel
for log_info in "${LOG_FILES[@]}"; do
    IFS='|' read -r log_file node_name node_color <<< "$log_info"
    monitor_log "$log_file" "$node_name" "$node_color" &
done

# Show activity indicator
echo -e "\n${GREEN}Monitoring active. Gossip messages will appear above.${NC}"
echo -e "${YELLOW}Tip: Open another terminal and use the Fade UI to generate traffic!${NC}\n"

# Keep script running
wait