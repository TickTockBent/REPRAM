#!/bin/bash

# REPRAM Load Testing Script
# This script runs comprehensive load tests against REPRAM nodes

set -e

# Default values
URL="http://localhost:8080"
CONCURRENCY=10
DURATION="60s"
DATA_SIZE=1024
TEST_TYPE="single"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --url)
      URL="$2"
      shift 2
      ;;
    --concurrency|-c)
      CONCURRENCY="$2"
      shift 2
      ;;
    --duration|-d)
      DURATION="$2"
      shift 2
      ;;
    --size|-s)
      DATA_SIZE="$2"
      shift 2
      ;;
    --type|-t)
      TEST_TYPE="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 [OPTIONS]"
      echo "Options:"
      echo "  --url URL          REPRAM node URL (default: http://localhost:8080)"
      echo "  --concurrency, -c  Number of concurrent workers (default: 10)"
      echo "  --duration, -d     Test duration (default: 60s)"
      echo "  --size, -s         Data size in bytes (default: 1024)"
      echo "  --type, -t         Test type: single, ramp, stress (default: single)"
      echo "  --help, -h         Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option $1"
      exit 1
      ;;
  esac
done

echo "=== REPRAM Load Testing ==="
echo "Target: $URL"
echo "Test Type: $TEST_TYPE"
echo "Concurrency: $CONCURRENCY"
echo "Duration: $DURATION"
echo "Data Size: $DATA_SIZE bytes"
echo ""

# Build load tester if needed
if [ ! -f "test/load/load-tester" ]; then
  echo "Building load tester..."
  cd test/load
  go build -o load-tester .
  cd ../..
fi

# Check if target is available
echo "Checking target availability..."
if ! curl -s "$URL/health" > /dev/null; then
  echo "Error: Cannot reach $URL/health"
  echo "Make sure REPRAM node is running"
  exit 1
fi

echo "Target is available!"
echo ""

# Run tests based on type
case $TEST_TYPE in
  single)
    echo "Running single load test..."
    ./test/load/load-tester -url="$URL" -c="$CONCURRENCY" -d="$DURATION" -size="$DATA_SIZE" -prefix="single-test"
    ;;
    
  ramp)
    echo "Running ramp-up load test..."
    for c in 1 5 10 20 50; do
      echo ""
      echo "=== Testing with $c concurrent workers ==="
      ./test/load/load-tester -url="$URL" -c="$c" -d="30s" -size="$DATA_SIZE" -prefix="ramp-test-$c"
      sleep 5
    done
    ;;
    
  stress)
    echo "Running stress test with increasing data sizes..."
    for size in 1024 4096 16384 65536 262144; do
      echo ""
      echo "=== Testing with ${size} byte payloads ==="
      ./test/load/load-tester -url="$URL" -c="$CONCURRENCY" -d="30s" -size="$size" -prefix="stress-test-$size"
      sleep 5
    done
    ;;
    
  *)
    echo "Unknown test type: $TEST_TYPE"
    echo "Valid types: single, ramp, stress"
    exit 1
    ;;
esac

echo ""
echo "=== Load testing completed ==="