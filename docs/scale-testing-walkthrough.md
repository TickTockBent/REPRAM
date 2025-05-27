# REPRAM Scale Testing Walkthrough

This guide provides step-by-step instructions for running comprehensive scale tests on REPRAM using Docker. Follow these instructions to validate performance, understand scaling characteristics, and prepare for production deployment.

## 🎯 Prerequisites

### System Requirements
- **Docker**: Version 20.10+ with Docker Compose
- **System Resources**: 8GB+ RAM, 4+ CPU cores recommended
- **Available Ports**: 8080-8090, 9090-9100 (for cluster communication)
- **Disk Space**: 2GB+ for images and test results

### Verify Prerequisites
```bash
# Check Docker version
docker --version
docker-compose --version

# Verify system resources
free -h
nproc

# Check port availability
netstat -tuln | grep -E "(808[0-9]|909[0-9])"
```

## 🚀 Step 1: Environment Setup

### 1.1 Clone and Build
```bash
# Navigate to REPRAM directory
cd REPRAM

# Build Docker image (this will take 3-5 minutes)
make docker-build

# Verify image was built
docker images | grep repram
```

### 1.2 Build Load Testing Tools
```bash
# Build the load testing framework
make load-test-build

# Verify load tester was built
ls -la test/load/load-tester
```

### 1.3 Clean Environment
```bash
# Stop any existing containers
docker-compose down --remove-orphans

# Clean up any previous test results
rm -rf test-results/ monitoring-results/

# Verify clean state
docker ps
```

## 📊 Step 2: Quick Validation Test

Start with a quick validation to ensure everything is working correctly.

### 2.1 Run Quick Test
```bash
# Run the quick validation test (takes ~3 minutes)
make docker-scale-test-quick
```

**What this does:**
- Creates a 3-node REPRAM cluster
- Runs 60 seconds of load testing with 25 concurrent workers
- Tests 1KB payloads with mixed PUT/GET operations
- Generates performance reports

### 2.2 Understanding Quick Test Output
```
=== REPRAM Docker Scale Test Session ===
Starting REPRAM Docker Scale Test Session
Results will be saved to: ./test-results/scale_test_20241127_143022

Building REPRAM Docker image...
Load tester built successfully
Running quick validation test...

Starting 3-node cluster...
Waiting for 3-node cluster to be healthy...
All 3 nodes are healthy

Running test: 3nodes_25conc_1024bytes
Progress: 60s elapsed, 2847 requests (2845 successful, 2 failed), 47.45 req/sec
Results: 47.45 req/sec, 99.93% success, 523847ns avg latency

Scale testing completed!
Results saved to: ./test-results/scale_test_20241127_143022
```

### 2.3 Review Quick Test Results
```bash
# View the latest test results
ls -la test-results/

# Check the summary
cat test-results/scale_test_*/summary.csv

# Read the detailed report
cat test-results/scale_test_*/report.md
```

**Expected Results:**
- **Throughput**: 40-60 req/sec for quick test
- **Success Rate**: >99%
- **Latency**: <1ms average

## 🔍 Step 3: Real-time Monitoring

Learn how to monitor cluster performance in real-time.

### 3.1 Start a Cluster for Monitoring
```bash
# Start a 3-node cluster manually
make docker-compose-cluster

# Wait for cluster to be ready (check all nodes respond)
for port in 8082 8083 8084; do
  curl -s http://localhost:$port/health && echo " - Node on port $port: OK"
done
```

### 3.2 Start Real-time Monitoring
```bash
# Open a new terminal and start monitoring
make docker-monitor
```

**What you'll see:**
```
======================================
     REPRAM Cluster Dashboard
======================================

Cluster Health: 3/3 nodes healthy

Node Status:
Node     Status     CPU%         Memory     Requests
----     ------     ----         ------     --------
Node-0   UP         5.2%        128MiB     0
Node-1   UP         4.8%        125MiB     0
Node-2   UP         5.1%        130MiB     0

Monitoring session: ./monitoring-results/monitoring_20241127_143500
Press Ctrl+C to stop monitoring
```

### 3.3 Generate Load While Monitoring
```bash
# In another terminal, run load against the cluster
./scripts/load-test.sh --url http://localhost:8082 --concurrency 50 --duration 120s
```

**Watch the monitoring dashboard update in real-time showing:**
- CPU usage increasing
- Memory consumption
- Request counts growing
- Network I/O activity

### 3.4 Stop Monitoring and Review
```bash
# Stop monitoring with Ctrl+C
# Review collected data
ls -la monitoring-results/monitoring_*/

# Check the monitoring report
cat monitoring-results/monitoring_*/monitoring_report.md
```

## 🧪 Step 4: Comprehensive Scale Testing

Run the full test matrix to understand scaling characteristics.

### 4.1 Full Scale Test
```bash
# Run comprehensive testing (takes 20-30 minutes)
make docker-scale-test-full
```

**What this tests:**
- **Cluster sizes**: 1, 3, 5, 7 nodes
- **Concurrency levels**: 10, 25, 50, 100 workers
- **Data sizes**: 1KB, 4KB, 16KB payloads
- **Total scenarios**: 48 different combinations

### 4.2 Monitor Progress
The test will show progress like:
```
Testing cluster size: 1 nodes
Starting 1-node cluster...
All 1 nodes are healthy
Progress: 1/48
Running test: 1nodes_10conc_1024bytes
Results: 89.2 req/sec, 100% success, 112043ns avg latency

Progress: 2/48
Running test: 1nodes_10conc_4096bytes
...

Testing cluster size: 3 nodes
Starting 3-node cluster...
Cooldown for 30 seconds...
```

### 4.3 Understanding Full Test Results
```bash
# View comprehensive results
ls test-results/scale_test_*/

# Check summary data
head -10 test-results/scale_test_*/summary.csv

# View the analysis report
cat test-results/scale_test_*/report.md
```

**Sample results analysis:**
```csv
cluster_size,concurrency,data_size,requests_per_sec,success_rate,avg_latency_ns
1,10,1024,89.23,100.00,112043
1,25,1024,156.45,99.98,159876
3,10,1024,267.89,100.00,37234
3,25,1024,387.12,99.99,64532
5,50,1024,634.67,99.95,78901
```

## 💪 Step 5: Stress Testing

Test the system under extreme conditions.

### 5.1 Run Stress Test
```bash
# Test with large payloads (takes ~10 minutes)
make docker-scale-test-stress
```

**What this tests:**
- **Large payloads**: 64KB, 256KB, 1MB data sizes
- **High concurrency**: 50 concurrent workers
- **Memory pressure**: Tests memory management
- **Network throughput**: Tests I/O limits

### 5.2 Monitor System During Stress Test
```bash
# In another terminal, monitor system resources
watch -n 2 "docker stats --no-stream"

# Check memory usage
watch -n 2 "free -h"
```

### 5.3 Analyze Stress Test Results
```bash
# Check for any failures or degradation
grep -E "(failed|error)" test-results/scale_test_*/stress_test_*.json

# Look at memory usage patterns
grep "memory" test-results/scale_test_*/stress_test_metrics.txt
```

## 🎯 Step 6: Custom Testing Scenarios

Create tests specific to your use case.

### 6.1 Custom Cluster Size Test
```bash
# Test a specific cluster configuration
./scripts/docker-scale-test.sh \
  --cluster-size 5 \
  --concurrency 75 \
  --duration 180s
```

### 6.2 Sustained Load Test
```bash
# Test steady load over longer period
./scripts/docker-scale-test.sh \
  --cluster-size 3 \
  --concurrency 30 \
  --duration 600s  # 10 minutes
```

### 6.3 Ramp-up Testing
```bash
# Test with gradually increasing load
for concurrency in 10 25 50 75 100 125; do
  echo "Testing with $concurrency workers..."
  ./scripts/docker-scale-test.sh \
    --cluster-size 3 \
    --concurrency $concurrency \
    --duration 60s
  echo "Cooldown..."
  sleep 30
done
```

## 📊 Step 7: Results Analysis

### 7.1 Compare Test Results
```bash
# Compare results across different test runs
ls -la test-results/

# Create a consolidated report
echo "cluster_size,concurrency,requests_per_sec,success_rate" > consolidated.csv
for dir in test-results/scale_test_*; do
  tail -n +2 "$dir/summary.csv" >> consolidated.csv
done

# View top performing configurations
sort -t, -k3 -nr consolidated.csv | head -10
```

### 7.2 Identify Optimal Configuration
Look for patterns in the results:

**Linear Scaling Indicators:**
```bash
# Check if throughput scales with cluster size
grep "3nodes.*25conc.*1024" test-results/*/summary.csv
grep "5nodes.*25conc.*1024" test-results/*/summary.csv
grep "7nodes.*25conc.*1024" test-results/*/summary.csv
```

**Performance Sweet Spots:**
```bash
# Find configurations with >99% success rate and high throughput
awk -F, '$5 >= 99 && $4 > 500 {print $0}' consolidated.csv
```

### 7.3 Resource Efficiency Analysis
```bash
# Check resource usage during peak performance
grep -A 5 -B 5 "Peak Throughput" test-results/*/report.md

# Analyze memory usage patterns
for dir in test-results/scale_test_*; do
  echo "=== $dir ==="
  grep "memory" "$dir"/*_metrics.txt | head -3
done
```

## 🚨 Step 8: Troubleshooting Common Issues

### 8.1 Cluster Startup Issues
```bash
# Check if all containers started
docker ps | grep repram

# Check container logs
docker logs repram-cluster-1

# Verify port availability
netstat -tuln | grep -E "(808[0-9]|909[0-9])"

# Check container health
for i in {0..2}; do
  curl -s http://localhost:$((8082+i))/health || echo "Node $i unhealthy"
done
```

### 8.2 Performance Issues
```bash
# Check system resources
top -b -n 1 | head -20

# Monitor Docker resource usage
docker stats --no-stream

# Check for rate limiting
curl http://localhost:8082/metrics | grep rate_limit

# Verify network connectivity between nodes
docker exec repram-cluster-1 ping repram-cluster-2
```

### 8.3 Test Failures
```bash
# Check for obvious errors in test output
grep -i error test-results/scale_test_*/

# Verify load tester is working
./test/load/load-tester -url=http://localhost:8082 -c=1 -d=10s

# Check cluster health during testing
curl http://localhost:8082/status | jq '.status'
```

## 📈 Step 9: Production Planning

Use your test results for production planning.

### 9.1 Capacity Planning
Based on your test results:

1. **Determine node count** for expected load
2. **Set resource limits** (CPU/memory) per container
3. **Plan network capacity** based on throughput tests
4. **Establish monitoring thresholds** from baseline metrics

### 9.2 Performance Baselines
```bash
# Create performance baseline document
echo "# REPRAM Performance Baseline" > performance-baseline.md
echo "## Test Date: $(date)" >> performance-baseline.md
echo "## Best Configurations:" >> performance-baseline.md

# Add top 5 performing configurations
sort -t, -k3 -nr consolidated.csv | head -5 >> performance-baseline.md
```

### 9.3 Monitoring Setup
Based on your monitoring data:

1. **Set CPU alerts** at 80% of peak observed
2. **Set memory alerts** at 90% of peak observed  
3. **Set latency alerts** at 2x baseline average
4. **Set throughput alerts** below 80% of expected

## 🎉 Completion Checklist

After completing the scale testing walkthrough:

- [ ] ✅ **Quick test passed** with >99% success rate
- [ ] ✅ **Real-time monitoring** data collected successfully
- [ ] ✅ **Full scale test** completed across all cluster sizes
- [ ] ✅ **Stress test** passed without failures
- [ ] ✅ **Custom scenarios** tested for your use case
- [ ] ✅ **Results analyzed** and optimal configuration identified
- [ ] ✅ **Performance baseline** established
- [ ] ✅ **Production capacity** planning completed

## 📞 Next Steps

1. **Deploy to staging** with identified optimal configuration
2. **Set up monitoring** with established thresholds
3. **Run production tests** with real traffic patterns
4. **Document procedures** for operational teams
5. **Schedule regular testing** for performance regression detection

Your REPRAM cluster is now ready for production deployment! 🚀

---

## 📚 Additional Resources

- [Docker Scale Testing Guide](docker-scale-testing.md) - Technical details
- [Deployment Guide](deployment-guide.md) - Production deployment
- [Development Plan](development-plan.md) - Project roadmap
- [Phase 3 Summary](phase3-summary.md) - Latest features