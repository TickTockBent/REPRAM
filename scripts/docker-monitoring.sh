#!/bin/bash

# REPRAM Docker Monitoring Script
# Real-time monitoring and metrics collection for Docker deployments

set -e

# Configuration
MONITORING_INTERVAL=5
DURATION=300  # 5 minutes default
OUTPUT_DIR="./monitoring-results"
CLUSTER_SIZE=3

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
    echo -e "${BLUE}[$(date +'%H:%M:%S')]${NC} $1"
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --duration|-d)
      DURATION="$2"
      shift 2
      ;;
    --interval|-i)
      MONITORING_INTERVAL="$2"
      shift 2
      ;;
    --cluster-size|-s)
      CLUSTER_SIZE="$2"
      shift 2
      ;;
    --help|-h)
      echo "REPRAM Docker Monitoring Script"
      echo ""
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --duration, -d     Monitoring duration in seconds (default: 300)"
      echo "  --interval, -i     Monitoring interval in seconds (default: 5)"
      echo "  --cluster-size, -s Cluster size to monitor (default: 3)"
      echo "  --help, -h         Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option $1"
      exit 1
      ;;
  esac
done

# Create output directory
mkdir -p "$OUTPUT_DIR"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
SESSION_DIR="$OUTPUT_DIR/monitoring_$TIMESTAMP"
mkdir -p "$SESSION_DIR"

log "Starting REPRAM cluster monitoring"
log "Duration: ${DURATION}s, Interval: ${MONITORING_INTERVAL}s"
log "Cluster size: $CLUSTER_SIZE nodes"
log "Output: $SESSION_DIR"

# Initialize CSV files
echo "timestamp,node,cpu_percent,memory_usage_mb,memory_percent,network_rx_mb,network_tx_mb" > "$SESSION_DIR/container_stats.csv"
echo "timestamp,node,total_requests,successful_requests,failed_requests,storage_items,storage_bytes,avg_latency_ms" > "$SESSION_DIR/app_metrics.csv"
echo "timestamp,overall_rps,cluster_storage_items,cluster_storage_mb,cluster_health_score" > "$SESSION_DIR/cluster_metrics.csv"

# Function to get container stats
get_container_stats() {
    local node_id=$1
    local container_name="repram-cluster-$node_id"
    
    # Get Docker stats
    docker stats --no-stream --format "table {{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}" "$container_name" 2>/dev/null | tail -n 1 | while read cpu mem_usage mem_perc net_io; do
        # Parse memory usage (remove units)
        mem_mb=$(echo "$mem_usage" | sed 's/MiB.*//' | sed 's/GiB/000/' | cut -d'/' -f1)
        
        # Parse network I/O
        net_rx=$(echo "$net_io" | cut -d'/' -f1 | sed 's/MB//' | sed 's/kB//' | sed 's/B//')
        net_tx=$(echo "$net_io" | cut -d'/' -f2 | sed 's/MB//' | sed 's/kB//' | sed 's/B//')
        
        # Clean percentages
        cpu_clean=$(echo "$cpu" | sed 's/%//')
        mem_perc_clean=$(echo "$mem_perc" | sed 's/%//')
        
        echo "$cpu_clean,$mem_mb,$mem_perc_clean,$net_rx,$net_tx"
    done
}

# Function to get application metrics
get_app_metrics() {
    local node_id=$1
    local port=$((8080 + node_id))
    
    # Get Prometheus metrics
    local metrics=$(curl -s "http://localhost:$port/metrics" 2>/dev/null || echo "")
    
    if [ -n "$metrics" ]; then
        # Extract key metrics
        local total_requests=$(echo "$metrics" | grep "repram_requests_total" | head -1 | awk '{print $2}' || echo "0")
        local storage_items=$(echo "$metrics" | grep "repram_storage_items" | awk '{print $2}' || echo "0")
        local storage_bytes=$(echo "$metrics" | grep "repram_storage_bytes" | awk '{print $2}' || echo "0")
        
        # Calculate derived metrics (simplified)
        local successful_requests=$(echo "$metrics" | grep 'repram_requests_total.*status="2' | awk '{sum += $2} END {print sum+0}')
        local failed_requests=$(echo "$total_requests - $successful_requests" | bc 2>/dev/null || echo "0")
        
        # Get average latency from histogram (approximate)
        local avg_latency=$(echo "$metrics" | grep "repram_request_duration_seconds_sum" | awk '{print $2}' || echo "0")
        
        echo "$total_requests,$successful_requests,$failed_requests,$storage_items,$storage_bytes,$avg_latency"
    else
        echo "0,0,0,0,0,0"
    fi
}

# Function to calculate cluster-wide metrics
calculate_cluster_metrics() {
    local timestamp=$1
    local total_rps=0
    local total_storage_items=0
    local total_storage_bytes=0
    local healthy_nodes=0
    
    for i in $(seq 0 $((CLUSTER_SIZE - 1))); do
        local port=$((8080 + i))
        if curl -s "http://localhost:$port/health" >/dev/null 2>&1; then
            healthy_nodes=$((healthy_nodes + 1))
            
            # Get node metrics for aggregation
            local metrics=$(curl -s "http://localhost:$port/metrics" 2>/dev/null || echo "")
            if [ -n "$metrics" ]; then
                local node_storage_items=$(echo "$metrics" | grep "repram_storage_items" | awk '{print $2}' || echo "0")
                local node_storage_bytes=$(echo "$metrics" | grep "repram_storage_bytes" | awk '{print $2}' || echo "0")
                
                total_storage_items=$((total_storage_items + node_storage_items))
                total_storage_bytes=$((total_storage_bytes + node_storage_bytes))
            fi
        fi
    done
    
    local health_score=$(echo "scale=2; $healthy_nodes / $CLUSTER_SIZE * 100" | bc 2>/dev/null || echo "0")
    local storage_mb=$(echo "scale=2; $total_storage_bytes / 1048576" | bc 2>/dev/null || echo "0")
    
    echo "$timestamp,$total_rps,$total_storage_items,$storage_mb,$health_score"
}

# Function to display real-time dashboard
display_dashboard() {
    clear
    echo "======================================"
    echo "     REPRAM Cluster Dashboard"
    echo "======================================"
    echo ""
    
    # Cluster overview
    local healthy_nodes=0
    for i in $(seq 0 $((CLUSTER_SIZE - 1))); do
        if curl -s "http://localhost:$((8080 + i))/health" >/dev/null 2>&1; then
            healthy_nodes=$((healthy_nodes + 1))
        fi
    done
    
    echo -e "${GREEN}Cluster Health:${NC} $healthy_nodes/$CLUSTER_SIZE nodes healthy"
    echo ""
    
    # Node status
    echo "Node Status:"
    printf "%-8s %-10s %-12s %-10s %-10s\n" "Node" "Status" "CPU%" "Memory" "Requests"
    printf "%-8s %-10s %-12s %-10s %-10s\n" "----" "------" "----" "------" "--------"
    
    for i in $(seq 0 $((CLUSTER_SIZE - 1))); do
        local port=$((8080 + i))
        local status="DOWN"
        local cpu="N/A"
        local memory="N/A"
        local requests="N/A"
        
        if curl -s "http://localhost:$port/health" >/dev/null 2>&1; then
            status="UP"
            
            # Get container stats
            local container_name="repram-cluster-$i"
            local stats=$(docker stats --no-stream --format "{{.CPUPerc}}\t{{.MemUsage}}" "$container_name" 2>/dev/null | tail -n 1 || echo "N/A	N/A")
            cpu=$(echo "$stats" | cut -f1)
            memory=$(echo "$stats" | cut -f2 | cut -d'/' -f1)
            
            # Get request count
            local metrics=$(curl -s "http://localhost:$port/metrics" 2>/dev/null || echo "")
            if [ -n "$metrics" ]; then
                requests=$(echo "$metrics" | grep "repram_requests_total" | head -1 | awk '{print $2}' || echo "0")
            fi
        fi
        
        printf "%-8s %-10s %-12s %-10s %-10s\n" "Node-$i" "$status" "$cpu" "$memory" "$requests"
    done
    
    echo ""
    echo "Monitoring session: $SESSION_DIR"
    echo "Press Ctrl+C to stop monitoring"
}

# Main monitoring loop
log "Starting monitoring loop..."

START_TIME=$(date +%s)
ITERATIONS=0

# Trap Ctrl+C to generate final report
trap 'log "Generating final report..."; generate_report; exit 0' INT

generate_report() {
    cat > "$SESSION_DIR/monitoring_report.md" << EOF
# REPRAM Cluster Monitoring Report

**Session:** $(date -d "@$START_TIME")  
**Duration:** $(($(date +%s) - START_TIME)) seconds  
**Cluster Size:** $CLUSTER_SIZE nodes  

## Summary

- **Total Iterations:** $ITERATIONS
- **Monitoring Interval:** ${MONITORING_INTERVAL}s
- **Data Files Generated:**
  - \`container_stats.csv\` - Docker container statistics
  - \`app_metrics.csv\` - Application-level metrics
  - \`cluster_metrics.csv\` - Cluster-wide aggregated metrics

## Key Metrics

### Container Performance
\`\`\`
$(head -5 "$SESSION_DIR/container_stats.csv")
...
\`\`\`

### Application Metrics
\`\`\`
$(head -5 "$SESSION_DIR/app_metrics.csv")
...
\`\`\`

### Cluster Health
\`\`\`
$(head -5 "$SESSION_DIR/cluster_metrics.csv")
...
\`\`\`

## Analysis

Use the CSV files to create visualizations and perform detailed analysis of:
- Resource utilization trends
- Request patterns and throughput
- Storage growth and cleanup efficiency
- Cluster health and availability

EOF

    log "Report generated: $SESSION_DIR/monitoring_report.md"
}

while [ $(($(date +%s) - START_TIME)) -lt $DURATION ]; do
    TIMESTAMP=$(date +%s)
    ITERATIONS=$((ITERATIONS + 1))
    
    # Collect metrics for each node
    for i in $(seq 0 $((CLUSTER_SIZE - 1))); do
        # Container stats
        container_stats=$(get_container_stats $i)
        echo "$TIMESTAMP,$i,$container_stats" >> "$SESSION_DIR/container_stats.csv"
        
        # Application metrics
        app_stats=$(get_app_metrics $i)
        echo "$TIMESTAMP,$i,$app_stats" >> "$SESSION_DIR/app_metrics.csv"
    done
    
    # Cluster-wide metrics
    cluster_stats=$(calculate_cluster_metrics $TIMESTAMP)
    echo "$cluster_stats" >> "$SESSION_DIR/cluster_metrics.csv"
    
    # Update dashboard
    display_dashboard
    
    # Wait for next iteration
    sleep $MONITORING_INTERVAL
done

log "Monitoring completed after $DURATION seconds"
generate_report