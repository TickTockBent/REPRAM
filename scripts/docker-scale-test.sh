#!/bin/bash

# REPRAM Docker Scale Testing Framework
# Comprehensive testing with dynamic cluster scaling and performance analysis

set -e

# Configuration
CLUSTER_SIZES=(1 3 5 7)
CONCURRENCY_LEVELS=(10 25 50 100)
TEST_DURATION="60s"
DATA_SIZES=(1024 4096 16384)
COOLDOWN_TIME=30
RESULTS_DIR="./test-results"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Utility functions
log() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Parse command line arguments
FULL_SCALE_TEST=false
QUICK_TEST=false
STRESS_TEST=false
CUSTOM_CLUSTER_SIZE=""
CUSTOM_CONCURRENCY=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --full)
      FULL_SCALE_TEST=true
      shift
      ;;
    --quick)
      QUICK_TEST=true
      shift
      ;;
    --stress)
      STRESS_TEST=true
      shift
      ;;
    --cluster-size)
      CUSTOM_CLUSTER_SIZE="$2"
      shift 2
      ;;
    --concurrency)
      CUSTOM_CONCURRENCY="$2"
      shift 2
      ;;
    --duration)
      TEST_DURATION="$2"
      shift 2
      ;;
    --help|-h)
      echo "REPRAM Docker Scale Testing Framework"
      echo ""
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --full                Run full scale test matrix"
      echo "  --quick              Run quick validation test"
      echo "  --stress             Run stress test with large payloads"
      echo "  --cluster-size N     Test specific cluster size"
      echo "  --concurrency N      Test specific concurrency level"
      echo "  --duration TIME      Test duration (default: 60s)"
      echo "  --help, -h           Show this help message"
      echo ""
      echo "Examples:"
      echo "  $0 --quick                                    # Quick validation"
      echo "  $0 --cluster-size 5 --concurrency 100       # Specific test"
      echo "  $0 --full                                    # Complete test matrix"
      echo "  $0 --stress                                  # Stress test"
      exit 0
      ;;
    *)
      error "Unknown option $1"
      exit 1
      ;;
  esac
done

# Ensure Docker and Docker Compose are available
if ! command -v docker &> /dev/null; then
    error "Docker is not installed or not in PATH"
    exit 1
fi

if ! command -v docker-compose &> /dev/null; then
    error "Docker Compose is not installed or not in PATH"
    exit 1
fi

# Create results directory
mkdir -p "$RESULTS_DIR"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
TEST_SESSION_DIR="$RESULTS_DIR/scale_test_$TIMESTAMP"
mkdir -p "$TEST_SESSION_DIR"

log "Starting REPRAM Docker Scale Test Session"
log "Results will be saved to: $TEST_SESSION_DIR"

# Build Docker image if it doesn't exist
if ! docker images | grep -q "repram.*latest"; then
    log "Building REPRAM Docker image..."
    make docker-build
    success "Docker image built successfully"
fi

# Build load tester
if [ ! -f "test/load/load-tester" ]; then
    log "Building load tester..."
    make load-test-build
    success "Load tester built successfully"
fi

# Function to create dynamic docker-compose for cluster size
create_cluster_compose() {
    local cluster_size=$1
    local compose_file="docker-compose-scale-$cluster_size.yml"
    
    cat > "$compose_file" << EOF
version: '3.8'

services:
EOF

    # Add nodes
    for i in $(seq 0 $((cluster_size - 1))); do
        local bootstrap_peers=""
        if [ $i -gt 0 ]; then
            for j in $(seq 0 $((i - 1))); do
                bootstrap_peers="${bootstrap_peers}repram-cluster-$j:9090"
                if [ $j -lt $((i - 1)) ]; then
                    bootstrap_peers="${bootstrap_peers},"
                fi
            done
        fi

        cat >> "$compose_file" << EOF
  repram-cluster-$i:
    image: repram:latest
    command: ["./repram-cluster-node"]
    ports:
      - "$((8080 + i)):8080"
      - "$((9090 + i)):9090"
    environment:
      - REPRAM_PORT=8080
      - REPRAM_GOSSIP_PORT=9090
      - REPRAM_NODE_ID=node$i
      - REPRAM_LOG_LEVEL=info
EOF

        if [ -n "$bootstrap_peers" ]; then
            cat >> "$compose_file" << EOF
      - REPRAM_BOOTSTRAP_PEERS=$bootstrap_peers
EOF
        fi

        if [ $i -gt 0 ]; then
            cat >> "$compose_file" << EOF
    depends_on:
EOF
            for j in $(seq 0 $((i - 1))); do
                cat >> "$compose_file" << EOF
      - repram-cluster-$j
EOF
            done
        fi

        cat >> "$compose_file" << EOF
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:8080/health"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 20s

EOF
    done

    cat >> "$compose_file" << EOF
networks:
  default:
    driver: bridge
EOF

    echo "$compose_file"
}

# Function to wait for cluster to be healthy
wait_for_cluster() {
    local cluster_size=$1
    local max_wait=120
    local wait_time=0
    
    log "Waiting for $cluster_size-node cluster to be healthy..."
    
    while [ $wait_time -lt $max_wait ]; do
        local healthy_nodes=0
        
        for i in $(seq 0 $((cluster_size - 1))); do
            if curl -s "http://localhost:$((8080 + i))/health" > /dev/null 2>&1; then
                healthy_nodes=$((healthy_nodes + 1))
            fi
        done
        
        if [ $healthy_nodes -eq $cluster_size ]; then
            success "All $cluster_size nodes are healthy"
            return 0
        fi
        
        log "Healthy nodes: $healthy_nodes/$cluster_size (waiting...)"
        sleep 5
        wait_time=$((wait_time + 5))
    done
    
    error "Cluster failed to become healthy within $max_wait seconds"
    return 1
}

# Function to run load test against cluster
run_load_test() {
    local cluster_size=$1
    local concurrency=$2
    local data_size=$3
    local test_name="${cluster_size}nodes_${concurrency}conc_${data_size}bytes"
    local target_url="http://localhost:8080"
    
    log "Running test: $test_name"
    
    # Test against first node (load balancer would distribute in production)
    local output_file="$TEST_SESSION_DIR/${test_name}.json"
    
    ./test/load/load-tester \
        -url="$target_url" \
        -c="$concurrency" \
        -d="$TEST_DURATION" \
        -size="$data_size" \
        -prefix="scale-test-$test_name" > "$output_file" 2>&1
    
    # Extract key metrics from the output
    local requests_per_sec=$(grep '"requests_per_second"' "$output_file" | sed 's/.*: *\([0-9.]*\).*/\1/')
    local success_rate=$(grep '"success_rate"' "$output_file" | sed 's/.*: *\([0-9.]*\).*/\1/')
    local avg_latency=$(grep '"avg_latency_ms"' "$output_file" | sed 's/.*: *\([0-9]*\).*/\1/')
    
    log "Results: ${requests_per_sec} req/sec, ${success_rate}% success, ${avg_latency}ns avg latency"
    
    # Store summary
    echo "$cluster_size,$concurrency,$data_size,$requests_per_sec,$success_rate,$avg_latency" >> "$TEST_SESSION_DIR/summary.csv"
}

# Function to collect cluster metrics
collect_cluster_metrics() {
    local cluster_size=$1
    local test_name=$2
    local metrics_file="$TEST_SESSION_DIR/${test_name}_metrics.txt"
    
    log "Collecting cluster metrics..."
    
    for i in $(seq 0 $((cluster_size - 1))); do
        echo "=== Node $i Metrics ===" >> "$metrics_file"
        curl -s "http://localhost:$((8080 + i))/metrics" >> "$metrics_file" 2>&1 || true
        echo "" >> "$metrics_file"
        
        echo "=== Node $i Status ===" >> "$metrics_file"
        curl -s "http://localhost:$((8080 + i))/status" >> "$metrics_file" 2>&1 || true
        echo -e "\n\n" >> "$metrics_file"
    done
}

# Function to stop and cleanup cluster
cleanup_cluster() {
    local compose_file=$1
    
    log "Cleaning up cluster..."
    docker-compose -f "$compose_file" down --remove-orphans > /dev/null 2>&1 || true
    
    # Wait for cleanup
    sleep 5
    
    # Remove compose file
    rm -f "$compose_file"
}

# Initialize summary CSV
echo "cluster_size,concurrency,data_size,requests_per_sec,success_rate,avg_latency_ns" > "$TEST_SESSION_DIR/summary.csv"

# Test execution logic
if [ "$QUICK_TEST" = true ]; then
    log "Running quick validation test..."
    
    # Single quick test: 3 nodes, moderate load
    cluster_size=3
    concurrency=25
    data_size=1024
    
    compose_file=$(create_cluster_compose $cluster_size)
    
    log "Starting $cluster_size-node cluster..."
    docker-compose -f "$compose_file" up -d
    
    if wait_for_cluster $cluster_size; then
        run_load_test $cluster_size $concurrency $data_size
        collect_cluster_metrics $cluster_size "quick_test"
    else
        error "Quick test failed - cluster not healthy"
    fi
    
    cleanup_cluster "$compose_file"
    
elif [ "$STRESS_TEST" = true ]; then
    log "Running stress test with large payloads..."
    
    cluster_size=3
    concurrency=50
    
    compose_file=$(create_cluster_compose $cluster_size)
    
    log "Starting $cluster_size-node cluster for stress testing..."
    docker-compose -f "$compose_file" up -d
    
    if wait_for_cluster $cluster_size; then
        for data_size in 65536 262144 1048576; do  # 64KB, 256KB, 1MB
            log "Stress testing with ${data_size} byte payloads..."
            run_load_test $cluster_size $concurrency $data_size
            sleep 10  # Short cooldown between tests
        done
        collect_cluster_metrics $cluster_size "stress_test"
    else
        error "Stress test failed - cluster not healthy"
    fi
    
    cleanup_cluster "$compose_file"
    
elif [ -n "$CUSTOM_CLUSTER_SIZE" ] && [ -n "$CUSTOM_CONCURRENCY" ]; then
    log "Running custom test: $CUSTOM_CLUSTER_SIZE nodes, $CUSTOM_CONCURRENCY concurrency"
    
    compose_file=$(create_cluster_compose $CUSTOM_CLUSTER_SIZE)
    
    log "Starting $CUSTOM_CLUSTER_SIZE-node cluster..."
    docker-compose -f "$compose_file" up -d
    
    if wait_for_cluster $CUSTOM_CLUSTER_SIZE; then
        run_load_test $CUSTOM_CLUSTER_SIZE $CUSTOM_CONCURRENCY 1024
        collect_cluster_metrics $CUSTOM_CLUSTER_SIZE "custom_test"
    else
        error "Custom test failed - cluster not healthy"
    fi
    
    cleanup_cluster "$compose_file"
    
elif [ "$FULL_SCALE_TEST" = true ]; then
    log "Running full scale test matrix..."
    log "This will test all combinations of cluster sizes and concurrency levels"
    log "Estimated duration: $((${#CLUSTER_SIZES[@]} * ${#CONCURRENCY_LEVELS[@]} * ${#DATA_SIZES[@]} * 90 / 60)) minutes"
    
    total_tests=$((${#CLUSTER_SIZES[@]} * ${#CONCURRENCY_LEVELS[@]} * ${#DATA_SIZES[@]}))
    current_test=0
    
    for cluster_size in "${CLUSTER_SIZES[@]}"; do
        log "Testing cluster size: $cluster_size nodes"
        
        compose_file=$(create_cluster_compose $cluster_size)
        
        log "Starting $cluster_size-node cluster..."
        docker-compose -f "$compose_file" up -d
        
        if wait_for_cluster $cluster_size; then
            for concurrency in "${CONCURRENCY_LEVELS[@]}"; do
                for data_size in "${DATA_SIZES[@]}"; do
                    current_test=$((current_test + 1))
                    log "Progress: $current_test/$total_tests"
                    
                    run_load_test $cluster_size $concurrency $data_size
                    
                    # Short cooldown between tests
                    sleep 10
                done
            done
            
            collect_cluster_metrics $cluster_size "cluster_${cluster_size}"
        else
            error "Failed to start $cluster_size-node cluster"
        fi
        
        cleanup_cluster "$compose_file"
        
        # Cooldown between cluster size changes
        if [ $cluster_size != "${CLUSTER_SIZES[-1]}" ]; then
            log "Cooldown for $COOLDOWN_TIME seconds..."
            sleep $COOLDOWN_TIME
        fi
    done
    
else
    error "No test type specified. Use --help for usage information."
    exit 1
fi

# Generate test report
log "Generating test report..."

cat > "$TEST_SESSION_DIR/report.md" << EOF
# REPRAM Scale Test Report

**Test Session:** $TIMESTAMP  
**Test Duration per scenario:** $TEST_DURATION  

## Test Configuration

- **Cluster Sizes Tested:** ${CLUSTER_SIZES[*]}
- **Concurrency Levels:** ${CONCURRENCY_LEVELS[*]}
- **Data Sizes:** ${DATA_SIZES[*]} bytes
- **Total Scenarios:** $(wc -l < "$TEST_SESSION_DIR/summary.csv" | tr -d ' ')

## Summary Results

\`\`\`
$(cat "$TEST_SESSION_DIR/summary.csv")
\`\`\`

## Key Findings

### Performance Characteristics
- **Peak Throughput:** $(awk -F, 'NR>1 {if ($4 > max) max = $4} END {print max " req/sec"}' "$TEST_SESSION_DIR/summary.csv")
- **Best Success Rate:** $(awk -F, 'NR>1 {if ($5 > max) max = $5} END {print max "%"}' "$TEST_SESSION_DIR/summary.csv")
- **Lowest Latency:** $(awk -F, 'NR>1 {if (min == "" || $6 < min) min = $6} END {print min " ns"}' "$TEST_SESSION_DIR/summary.csv")

### Scaling Analysis
- **Linear Scaling:** $([ ${#CLUSTER_SIZES[@]} -gt 1 ] && echo "Tested across ${#CLUSTER_SIZES[@]} cluster sizes" || echo "Single cluster size tested")
- **Concurrency Handling:** $([ ${#CONCURRENCY_LEVELS[@]} -gt 1 ] && echo "Tested up to ${CONCURRENCY_LEVELS[-1]} concurrent workers" || echo "Single concurrency level tested")

## Files Generated

- \`summary.csv\` - Raw performance data
- \`report.md\` - This report
- \`*_metrics.txt\` - Detailed Prometheus metrics per test
- \`*.json\` - Individual test outputs with full details

## Recommendations

1. **Optimal Cluster Size:** Based on throughput vs resource usage
2. **Concurrency Limits:** Monitor success rates above certain thresholds
3. **Payload Considerations:** Balance between throughput and latency for different data sizes

EOF

success "Scale testing completed!"
log "Results saved to: $TEST_SESSION_DIR"
log "View summary: cat $TEST_SESSION_DIR/summary.csv"
log "View report: cat $TEST_SESSION_DIR/report.md"

# Display quick summary
echo ""
echo "=== QUICK SUMMARY ==="
echo "Total tests run: $(wc -l < "$TEST_SESSION_DIR/summary.csv" | tr -d ' ')"
echo "Peak performance: $(awk -F, 'NR>1 {if ($4 > max) {max = $4; line = $0}} END {print max " req/sec (" line ")"}' "$TEST_SESSION_DIR/summary.csv")"
echo "Results directory: $TEST_SESSION_DIR"