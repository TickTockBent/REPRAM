#!/bin/bash

# FADE Cluster Stress Test Script
# Tests rapid message injection and intentional rule violations

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

# Node configuration
NODES=("localhost:8080" "localhost:8081" "localhost:8082")
TTL=600  # 10 minutes

# Test data
ADJECTIVES=("quantum" "atomic" "digital" "cyber" "neural" "cosmic" "spectral" "temporal" "prismatic" "holographic")
NOUNS=("wave" "pulse" "signal" "burst" "flux" "matrix" "nexus" "grid" "core" "field")

# Function to generate random message
generate_message() {
    local adj=${ADJECTIVES[$RANDOM % ${#ADJECTIVES[@]}]}
    local noun=${NOUNS[$RANDOM % ${#NOUNS[@]}]}
    local num=$((RANDOM % 1000))
    echo "Stress test: $adj $noun #$num"
}

# Function to generate key
generate_key() {
    local prefix="$1"
    local timestamp=$(date +%s%N)
    local random=$((RANDOM % 10000))
    echo "${prefix}-${timestamp}-${random}"
}

# Function to send message to node
send_message() {
    local node="$1"
    local key="$2"
    local message="$3"
    local ttl="$4"
    
    local response=$(curl -s -w "%{http_code}" -X PUT \
        "http://$node/data/$key?ttl=$ttl" \
        -H "Content-Type: text/plain" \
        -d "$message" 2>/dev/null)
    
    local http_code="${response: -3}"
    echo "$http_code"
}

# Function to check if cluster is running
check_cluster() {
    local healthy=0
    echo -e "${BLUE}Checking cluster health...${NC}"
    
    for node in "${NODES[@]}"; do
        if curl -s "http://$node/health" >/dev/null 2>&1; then
            echo -e "  ${GREEN}✓${NC} $node"
            ((healthy++))
        else
            echo -e "  ${RED}✗${NC} $node"
        fi
    done
    
    if [ $healthy -eq 0 ]; then
        echo -e "${RED}Error: No nodes are running!${NC}"
        echo "Start the cluster with: ./start-gossip-multi-node.sh"
        return 1
    elif [ $healthy -lt 3 ]; then
        echo -e "${YELLOW}Warning: Only $healthy/3 nodes are running${NC}"
    else
        echo -e "${GREEN}All 3 nodes are healthy${NC}"
    fi
    
    return 0
}

# Function to run rapid injection test
rapid_injection_test() {
    echo -e "\n${BLUE}=== Rapid Injection Test (50 messages) ===${NC}"
    echo "Sending 50 messages rapidly to random nodes..."
    
    local success=0
    local failures=0
    local start_time=$(date +%s)
    
    for i in {1..50}; do
        local node=${NODES[$RANDOM % ${#NODES[@]}]}
        local key=$(generate_key "stress")
        local message=$(generate_message)
        
        printf "\r${CYAN}Sending message $i/50 to $node...${NC}"
        
        local result=$(send_message "$node" "$key" "$message" "$TTL")
        
        if [ "$result" = "201" ]; then
            ((success++))
        else
            ((failures++))
            echo -e "\n${RED}Failed message $i: HTTP $result${NC}"
        fi
        
        # Small delay to avoid overwhelming the nodes
        sleep 0.05
    done
    
    local end_time=$(date +%s)
    local duration=$((end_time - start_time))
    
    echo -e "\n\n${GREEN}Rapid injection complete:${NC}"
    echo -e "  ${GREEN}✓ Successful:${NC} $success/50"
    echo -e "  ${RED}✗ Failed:${NC} $failures/50"
    echo -e "  ${CYAN}Duration:${NC} ${duration}s"
    echo -e "  ${CYAN}Rate:${NC} $((50 / duration)) messages/second"
}

# Function to run conflict test
conflict_test() {
    echo -e "\n${BLUE}=== Conflict Test (Same Key, Different Content) ===${NC}"
    echo "Intentionally violating REPRAM rules by sending different content to the same key..."
    
    local conflict_key="conflict-test-$(date +%s)"
    local messages=(
        "🔴 RED version of the conflict message"
        "🟢 GREEN version of the conflict message" 
        "🔵 BLUE version of the conflict message"
        "🟡 YELLOW version of the conflict message"
        "🟣 PURPLE version of the conflict message"
    )
    
    echo -e "${YELLOW}Conflict key: $conflict_key${NC}"
    echo -e "${YELLOW}Sending 5 different messages with the same key to different nodes...${NC}"
    
    # Send different content to same key on different nodes simultaneously
    local pids=()
    
    for i in {0..4}; do
        local node=${NODES[$i % ${#NODES[@]}]}
        local message="${messages[$i]}"
        
        echo -e "  ${CYAN}Node $((i+1)):${NC} $node -> ${message:0:50}..."
        
        # Send in background for simultaneous requests
        (
            local result=$(send_message "$node" "$conflict_key" "$message" "$TTL")
            echo "$i:$result:$node"
        ) &
        pids+=($!)
        
        # Tiny delay to stagger requests slightly
        sleep 0.02
    done
    
    # Wait for all requests to complete
    echo -e "\n${YELLOW}Waiting for conflict requests to complete...${NC}"
    local results=()
    
    for pid in "${pids[@]}"; do
        wait $pid
        local result=$(jobs -p | grep $pid)
    done
    
    # Give gossip protocol time to propagate
    echo -e "${YELLOW}Waiting 3 seconds for gossip propagation...${NC}"
    sleep 3
    
    # Check what ended up being stored on each node
    echo -e "\n${BLUE}Checking final state on all nodes:${NC}"
    
    for i in "${!NODES[@]}"; do
        local node="${NODES[$i]}"
        echo -e "\n${CYAN}Node $((i+1)) ($node):${NC}"
        
        local response=$(curl -s "http://$node/data/$conflict_key" 2>/dev/null)
        if [ $? -eq 0 ] && [ -n "$response" ]; then
            echo -e "  ${GREEN}Data:${NC} $response"
        else
            echo -e "  ${RED}No data or error${NC}"
        fi
    done
    
    echo -e "\n${MAGENTA}Analysis:${NC}"
    echo -e "  This test shows how REPRAM handles write conflicts when the same key"
    echo -e "  receives different values on different nodes simultaneously."
    echo -e "  The final state depends on the gossip protocol's conflict resolution."
}

# Function to monitor gossip activity
monitor_suggestion() {
    echo -e "\n${BLUE}=== Monitoring Suggestion ===${NC}"
    echo -e "To watch gossip protocol activity during tests, run in another terminal:"
    echo -e "  ${CYAN}./monitor-gossip.sh${NC}"
    echo -e "\nTo watch real-time cluster health:"
    echo -e "  ${CYAN}./monitor-health.sh${NC}"
    echo -e "\nTo view messages in the web UI:"
    echo -e "  ${CYAN}http://localhost:3000${NC}"
}

# Function to show usage
show_usage() {
    echo -e "${BLUE}=== FADE Cluster Stress Test ===${NC}"
    echo
    echo "This script performs stress testing on the FADE cluster:"
    echo "  1. Rapid injection of 50 messages to random nodes"
    echo "  2. Conflict test with same key, different content"
    echo
    echo "Usage:"
    echo "  $0                    # Run both tests"
    echo "  $0 --rapid-only      # Run only rapid injection test"
    echo "  $0 --conflict-only   # Run only conflict test"
    echo "  $0 --help           # Show this help"
    echo
    echo "Prerequisites:"
    echo "  - FADE cluster must be running (./start-gossip-multi-node.sh)"
    echo "  - All 3 nodes should be healthy for best results"
}

# Main execution
main() {
    clear
    echo -e "${BLUE}=== FADE Cluster Stress Test ===${NC}"
    echo -e "Testing rapid injection and intentional rule violations"
    echo -e "$(date)"
    echo
    
    # Check cluster health
    if ! check_cluster; then
        exit 1
    fi
    
    # Show monitoring suggestion
    monitor_suggestion
    
    echo -e "\n${YELLOW}Press Enter to start stress testing, or Ctrl+C to cancel...${NC}"
    read
    
    # Run tests based on arguments
    case "${1:-}" in
        --rapid-only)
            rapid_injection_test
            ;;
        --conflict-only)
            conflict_test
            ;;
        --help|-h)
            show_usage
            exit 0
            ;;
        *)
            rapid_injection_test
            conflict_test
            ;;
    esac
    
    echo -e "\n${GREEN}=== Stress Test Complete ===${NC}"
    echo -e "Check the gossip logs and web UI to see the results!"
    echo -e "Log files: cluster-node1.log, cluster-node2.log, cluster-node3.log"
}

# Run main function
main "$@"