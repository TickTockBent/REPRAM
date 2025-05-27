#!/bin/bash

# REPRAM Cluster Debug Script
# Comprehensive debugging for cluster health issues

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
    echo -e "${BLUE}[DEBUG]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log "Starting REPRAM cluster health debugging..."

# Check Docker availability
log "Checking Docker environment..."
if ! command -v docker &> /dev/null; then
    error "Docker not found in PATH"
    exit 1
fi

if ! docker info > /dev/null 2>&1; then
    error "Docker daemon not running or not accessible"
    exit 1
fi

success "Docker is available and running"

# Check if REPRAM image exists
log "Checking REPRAM Docker image..."
if ! docker images | grep -q "repram.*latest"; then
    warning "REPRAM image not found, building now..."
    cd /home/ticktockbent/REPRAM
    make docker-build
    if [ $? -eq 0 ]; then
        success "REPRAM image built successfully"
    else
        error "Failed to build REPRAM image"
        exit 1
    fi
else
    success "REPRAM image found"
fi

# Check port availability
log "Checking port availability..."
PORTS=(8080 8081 8082 8083 8084 9090 9091 9092 9093 9094)
for port in "${PORTS[@]}"; do
    if netstat -tuln 2>/dev/null | grep -q ":$port "; then
        warning "Port $port is already in use"
        netstat -tuln | grep ":$port "
    else
        success "Port $port is available"
    fi
done

# Clean up any existing containers
log "Cleaning up existing containers..."
docker-compose down --remove-orphans > /dev/null 2>&1 || true
docker ps -a | grep repram | awk '{print $1}' | xargs -r docker rm -f > /dev/null 2>&1 || true
success "Cleaned up existing containers"

# Start a simple single node first
log "Testing single node startup..."
cat > docker-compose-debug.yml << EOF
version: '3.8'
services:
  repram-debug:
    image: repram:latest
    command: ["./repram-node"]
    ports:
      - "8080:8080"
    environment:
      - REPRAM_PORT=8080
      - REPRAM_LOG_LEVEL=debug
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:8080/health"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 10s
EOF

docker-compose -f docker-compose-debug.yml up -d

log "Waiting for single node to start..."
sleep 10

# Check single node health
if curl -s http://localhost:8080/health > /dev/null 2>&1; then
    success "Single node is healthy"
    SINGLE_NODE_OK=true
else
    error "Single node failed to start"
    SINGLE_NODE_OK=false
fi

# Get single node logs
log "Single node logs:"
docker logs $(docker ps -q -f "name=repram-debug") | tail -20

# Check what's inside the container
log "Checking container contents..."
docker exec $(docker ps -q -f "name=repram-debug") ls -la / || warning "Could not list container contents"
docker exec $(docker ps -q -f "name=repram-debug") ls -la /app || warning "Could not list /app contents"

# Test the endpoints manually
log "Testing endpoints manually..."
if [ "$SINGLE_NODE_OK" = true ]; then
    echo "Health endpoint:"
    curl -v http://localhost:8080/health 2>&1 || warning "Health endpoint failed"
    
    echo "Status endpoint:"
    curl -v http://localhost:8080/status 2>&1 || warning "Status endpoint failed"
    
    echo "Metrics endpoint:"
    curl -s http://localhost:8080/metrics | head -10 || warning "Metrics endpoint failed"
fi

# Clean up single node
docker-compose -f docker-compose-debug.yml down
rm -f docker-compose-debug.yml

if [ "$SINGLE_NODE_OK" = false ]; then
    error "Single node test failed. Check the logs above for errors."
    exit 1
fi

# Now test cluster node
log "Testing cluster node startup..."
cat > docker-compose-cluster-debug.yml << EOF
version: '3.8'
services:
  repram-cluster-debug:
    image: repram:latest
    command: ["./repram-cluster-node"]
    ports:
      - "8080:8080"
      - "9090:9090"
    environment:
      - REPRAM_PORT=8080
      - REPRAM_GOSSIP_PORT=9090
      - REPRAM_NODE_ID=debug-node
      - REPRAM_LOG_LEVEL=debug
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:8080/health"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 15s
EOF

docker-compose -f docker-compose-cluster-debug.yml up -d

log "Waiting for cluster node to start..."
sleep 15

# Check cluster node health
if curl -s http://localhost:8080/health > /dev/null 2>&1; then
    success "Cluster node is healthy"
    CLUSTER_NODE_OK=true
else
    error "Cluster node failed to start"
    CLUSTER_NODE_OK=false
fi

# Get cluster node logs
log "Cluster node logs:"
docker logs $(docker ps -q -f "name=repram-cluster-debug") | tail -20

# Clean up cluster node
docker-compose -f docker-compose-cluster-debug.yml down
rm -f docker-compose-cluster-debug.yml

if [ "$CLUSTER_NODE_OK" = false ]; then
    error "Cluster node test failed. Check the logs above for errors."
    exit 1
fi

# Test 2-node cluster
log "Testing 2-node cluster..."
cat > docker-compose-2node-debug.yml << EOF
version: '3.8'
services:
  repram-node-0:
    image: repram:latest
    command: ["./repram-cluster-node"]
    ports:
      - "8080:8080"
      - "9090:9090"
    environment:
      - REPRAM_PORT=8080
      - REPRAM_GOSSIP_PORT=9090
      - REPRAM_NODE_ID=node0
      - REPRAM_LOG_LEVEL=debug
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:8080/health"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 20s

  repram-node-1:
    image: repram:latest
    command: ["./repram-cluster-node"]
    ports:
      - "8081:8080"
      - "9091:9090"
    environment:
      - REPRAM_PORT=8080
      - REPRAM_GOSSIP_PORT=9090
      - REPRAM_NODE_ID=node1
      - REPRAM_BOOTSTRAP_PEERS=repram-node-0:9090
      - REPRAM_LOG_LEVEL=debug
    depends_on:
      - repram-node-0
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:8080/health"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 25s
EOF

docker-compose -f docker-compose-2node-debug.yml up -d

log "Waiting for 2-node cluster to start..."
sleep 30

# Check both nodes
NODE0_OK=false
NODE1_OK=false

if curl -s http://localhost:8080/health > /dev/null 2>&1; then
    success "Node 0 is healthy"
    NODE0_OK=true
else
    error "Node 0 is not healthy"
fi

if curl -s http://localhost:8081/health > /dev/null 2>&1; then
    success "Node 1 is healthy"
    NODE1_OK=true
else
    error "Node 1 is not healthy"
fi

# Get logs from both nodes
log "Node 0 logs:"
docker logs $(docker ps -q -f "name=repram-node-0") | tail -15

log "Node 1 logs:"
docker logs $(docker ps -q -f "name=repram-node-1") | tail -15

# Check network connectivity
log "Testing network connectivity..."
if [ "$NODE0_OK" = true ] && [ "$NODE1_OK" = true ]; then
    docker exec $(docker ps -q -f "name=repram-node-1") ping -c 3 repram-node-0 || warning "Ping failed between nodes"
    docker exec $(docker ps -q -f "name=repram-node-1") nc -z repram-node-0 9090 || warning "Port 9090 not reachable"
fi

# Clean up
docker-compose -f docker-compose-2node-debug.yml down
rm -f docker-compose-2node-debug.yml

# Summary
log "=== DEBUG SUMMARY ==="
if [ "$SINGLE_NODE_OK" = true ]; then
    success "Single node test: PASSED"
else
    error "Single node test: FAILED"
fi

if [ "$CLUSTER_NODE_OK" = true ]; then
    success "Cluster node test: PASSED"
else
    error "Cluster node test: FAILED"
fi

if [ "$NODE0_OK" = true ] && [ "$NODE1_OK" = true ]; then
    success "2-node cluster test: PASSED"
    success "Your REPRAM cluster should work correctly!"
    log "Try running: make docker-compose-cluster"
else
    error "2-node cluster test: FAILED"
    warning "Check the logs above for specific errors"
fi

log "Debug complete!"