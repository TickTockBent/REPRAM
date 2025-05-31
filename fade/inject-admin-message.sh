#!/bin/bash

# Admin message injection script for FADE cluster
# Injects messages directly into the cluster nodes

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Default values
DEFAULT_TTL=3600  # 1 hour
DEFAULT_NODE="localhost:8080"
ADMIN_CALLSIGN="ADMIN"
ADMIN_LOCATION="System"

# Function to generate admin key
generate_admin_key() {
    echo "admin-$(date +%s)-$(shuf -i 1000-9999 -n 1)"
}

# Function to check if cluster is running
check_cluster() {
    if ! curl -s "http://localhost:8080/health" >/dev/null 2>&1; then
        echo -e "${RED}Error: Fade cluster is not running on localhost:8080${NC}"
        echo "Start the cluster with: ./start-gossip-multi-node.sh"
        return 1
    fi
    return 0
}

# Function to inject message
inject_message() {
    local message="$1"
    local ttl="$2"
    local node="$3"
    
    # Generate admin key
    local key=$(generate_admin_key)
    
    # Format message with admin info
    local formatted_message="🔧 ${message}|${ADMIN_CALLSIGN}|${ADMIN_LOCATION}"
    
    echo -e "${BLUE}Injecting admin message:${NC}"
    echo -e "  ${CYAN}Key:${NC} $key"
    echo -e "  ${CYAN}Message:${NC} $message"
    echo -e "  ${CYAN}TTL:${NC} $ttl seconds"
    echo -e "  ${CYAN}Target:${NC} $node"
    echo
    
    # Send to cluster
    local response=$(curl -s -w "%{http_code}" -X PUT \
        "http://$node/data/$key?ttl=$ttl" \
        -H "Content-Type: text/plain" \
        -d "$formatted_message")
    
    local http_code="${response: -3}"
    local body="${response%???}"
    
    if [ "$http_code" = "201" ]; then
        echo -e "${GREEN}✓ Admin message injected successfully!${NC}"
        echo -e "${GREEN}✓ Message will replicate across all cluster nodes via gossip${NC}"
        echo -e "${YELLOW}→ View at: http://localhost:3000${NC}"
        return 0
    else
        echo -e "${RED}✗ Failed to inject message (HTTP $http_code)${NC}"
        if [ -n "$body" ]; then
            echo -e "${RED}Error: $body${NC}"
        fi
        return 1
    fi
}

# Function to show usage
show_usage() {
    echo -e "${BLUE}=== FADE Admin Message Injector ===${NC}"
    echo
    echo "Usage:"
    echo "  $0 \"message text\"                    # Inject with default TTL (1 hour)"
    echo "  $0 \"message text\" TTL               # Inject with custom TTL (seconds)"
    echo "  $0 \"message text\" TTL NODE          # Inject to specific node"
    echo
    echo "Examples:"
    echo "  $0 \"System maintenance in 10 minutes\""
    echo "  $0 \"Server restart scheduled\" 7200"
    echo "  $0 \"Welcome to FADE demo\" 3600 localhost:8081"
    echo
    echo "Options:"
    echo "  TTL     - Time to live in seconds (default: $DEFAULT_TTL)"
    echo "  NODE    - Target node (default: $DEFAULT_NODE)"
    echo
    echo "Admin messages are prefixed with 🔧 and tagged as ADMIN|System"
}

# Function to inject preset messages
inject_preset() {
    local preset="$1"
    
    case "$preset" in
        "welcome")
            inject_message "Welcome to the FADE ephemeral message board demo!" 7200 "$DEFAULT_NODE"
            ;;
        "maintenance")
            inject_message "System maintenance scheduled - messages may be temporarily unavailable" 1800 "$DEFAULT_NODE"
            ;;
        "demo")
            inject_message "This is a live demonstration of REPRAM's distributed gossip protocol" 3600 "$DEFAULT_NODE"
            ;;
        "test")
            inject_message "Testing admin message injection system" 300 "$DEFAULT_NODE"
            ;;
        *)
            echo -e "${RED}Unknown preset: $preset${NC}"
            echo "Available presets: welcome, maintenance, demo, test"
            return 1
            ;;
    esac
}

# Main script logic
main() {
    # Check if cluster is running
    if ! check_cluster; then
        exit 1
    fi
    
    # Parse arguments
    if [ $# -eq 0 ]; then
        show_usage
        exit 1
    fi
    
    # Check for preset messages
    if [ "$1" = "--preset" ] && [ $# -eq 2 ]; then
        inject_preset "$2"
        exit $?
    fi
    
    local message="$1"
    local ttl="${2:-$DEFAULT_TTL}"
    local node="${3:-$DEFAULT_NODE}"
    
    # Validate TTL
    if ! [[ "$ttl" =~ ^[0-9]+$ ]] || [ "$ttl" -lt 1 ]; then
        echo -e "${RED}Error: TTL must be a positive integer (seconds)${NC}"
        exit 1
    fi
    
    # Validate message
    if [ -z "$message" ]; then
        echo -e "${RED}Error: Message cannot be empty${NC}"
        exit 1
    fi
    
    # Inject the message
    inject_message "$message" "$ttl" "$node"
}

# Show help
if [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
    show_usage
    echo
    echo "Preset messages:"
    echo "  $0 --preset welcome      # Welcome message"
    echo "  $0 --preset maintenance  # Maintenance notification" 
    echo "  $0 --preset demo         # Demo explanation"
    echo "  $0 --preset test         # Test message"
    exit 0
fi

# Run main function
main "$@"