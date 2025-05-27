# REPRAM Docker Scale Testing Guide

This guide provides comprehensive instructions for scale testing REPRAM using Docker containers.

## 🚀 Quick Start

### Basic Scale Test
```bash
# Quick validation test (3 nodes, moderate load)
make docker-scale-test-quick
```

### Full Scale Test Matrix
```bash
# Complete test across all cluster sizes and load levels
make docker-scale-test-full
```

### Stress Testing
```bash
# Test with large payloads (up to 1MB)
make docker-scale-test-stress
```

## 📊 Scale Testing Framework

The Docker scale testing framework provides:

- **Dynamic cluster scaling** (1, 3, 5, 7 nodes)
- **Variable load testing** (10, 25, 50, 100 concurrent workers)
- **Payload size testing** (1KB, 4KB, 16KB, up to 1MB)
- **Automated metrics collection**
- **Comprehensive reporting**

### Test Scenarios

| Test Type | Purpose | Duration | Cluster Sizes | Concurrency |
|-----------|---------|----------|---------------|-------------|
| Quick | Fast validation | 60s | 3 nodes | 25 workers |
| Full | Complete matrix | ~30 mins | 1,3,5,7 nodes | 10,25,50,100 |
| Stress | Large payloads | ~10 mins | 3 nodes | 50 workers |
| Custom | Specific scenario | Configurable | Custom | Custom |

## 🔧 Advanced Usage

### Custom Cluster Size Test
```bash
# Test specific cluster configuration
./scripts/docker-scale-test.sh --cluster-size 5 --concurrency 100 --duration 120s
```

### Custom Test Parameters
```bash
# Full parameter control
./scripts/docker-scale-test.sh \
  --cluster-size 7 \
  --concurrency 200 \
  --duration 300s
```

### Available Options
```bash
./scripts/docker-scale-test.sh --help
```

## 📈 Real-time Monitoring

### Basic Monitoring
```bash
# Monitor cluster for 5 minutes
make docker-monitor
```

### Extended Monitoring
```bash
# Monitor cluster for 30 minutes
make docker-monitor-long
```

### Custom Monitoring Duration
```bash
# Monitor specific duration and interval
./scripts/docker-monitoring.sh --duration 600 --interval 10 --cluster-size 5
```

## 📊 Understanding Results

### Output Structure
```
test-results/
└── scale_test_20241127_143022/
    ├── summary.csv           # Performance summary
    ├── report.md            # Comprehensive report
    ├── 3nodes_25conc_1024bytes.json  # Individual test results
    ├── cluster_3_metrics.txt # Prometheus metrics
    └── ...
```

### Key Metrics

#### Performance Metrics
- **Requests/sec**: Throughput per scenario
- **Success Rate**: Percentage of successful requests
- **Average Latency**: Response time in nanoseconds
- **Peak Performance**: Maximum observed throughput

#### Resource Metrics
- **CPU Usage**: Per container and cluster-wide
- **Memory Usage**: RAM consumption patterns
- **Network I/O**: Data transfer rates
- **Storage Statistics**: Item count and size

### Sample Results Analysis

```csv
cluster_size,concurrency,data_size,requests_per_sec,success_rate,avg_latency_ns
1,10,1024,156.23,100.00,58432
3,25,1024,387.45,99.98,62187
5,50,1024,634.12,99.95,75432
7,100,1024,892.67,99.87,109876
```

**Analysis Points:**
- Linear scaling up to 5 nodes
- Latency increases with concurrency
- Success rate remains high (>99%)
- Optimal performance at 5-7 nodes for this workload

## 🎯 Testing Strategies

### 1. Validation Testing
**Purpose**: Verify basic functionality  
**Command**: `make docker-scale-test-quick`  
**Duration**: ~2 minutes  
**Use Case**: CI/CD pipelines, quick verification

### 2. Performance Baseline
**Purpose**: Establish performance characteristics  
**Command**: `./scripts/docker-scale-test.sh --cluster-size 3 --concurrency 50`  
**Duration**: ~2 minutes  
**Use Case**: Performance regression testing

### 3. Scalability Assessment
**Purpose**: Understand scaling behavior  
**Command**: `make docker-scale-test-full`  
**Duration**: ~30 minutes  
**Use Case**: Capacity planning, architecture decisions

### 4. Stress Testing
**Purpose**: Find breaking points  
**Command**: `make docker-scale-test-stress`  
**Duration**: ~10 minutes  
**Use Case**: Reliability testing, limit identification

### 5. Load Pattern Testing
**Purpose**: Simulate realistic workloads  
**Commands**:
```bash
# Simulate user growth pattern
for concurrency in 10 25 50 75 100; do
  ./scripts/docker-scale-test.sh --cluster-size 3 --concurrency $concurrency --duration 60s
  sleep 30
done
```

## 🔍 Monitoring During Tests

### Real-time Dashboard
The monitoring script provides a live dashboard:

```
======================================
     REPRAM Cluster Dashboard
======================================

Cluster Health: 3/3 nodes healthy

Node Status:
Node     Status     CPU%         Memory     Requests
----     ------     ----         ------     --------
Node-0   UP         15.3%        256MiB     1234
Node-1   UP         18.7%        278MiB     1156
Node-2   UP         16.9%        245MiB     1298
```

### Metrics Collection
- **Container Stats**: CPU, memory, network I/O
- **Application Metrics**: Request counts, latency, storage
- **Cluster Health**: Node availability, data distribution

### Log Analysis
```bash
# View detailed metrics during test
curl http://localhost:8080/metrics | grep repram_

# Check cluster health
for port in 8080 8081 8082; do
  curl -s http://localhost:$port/status | jq '.status,.uptime'
done
```

## 🚨 Troubleshooting

### Common Issues

#### 1. Cluster Startup Failures
**Symptoms**: Nodes fail health checks  
**Solutions**:
- Increase startup wait time
- Check Docker resources
- Verify port availability

#### 2. High Error Rates
**Symptoms**: Success rate < 95%  
**Solutions**:
- Reduce concurrency
- Check rate limiting settings
- Monitor resource usage

#### 3. Performance Degradation
**Symptoms**: Lower than expected throughput  
**Solutions**:
- Check CPU/memory limits
- Verify network connectivity
- Monitor container resources

### Debugging Commands
```bash
# Check container logs
docker logs repram-cluster-0

# Monitor resource usage
docker stats

# Check cluster connectivity
for i in {0..2}; do
  curl -s http://localhost:$((8080+i))/health
done

# View detailed metrics
curl http://localhost:8080/status | jq '.'
```

## 📋 Best Practices

### 1. Test Environment Setup
- **Clean Docker environment** before testing
- **Sufficient system resources** (8GB+ RAM recommended)
- **No competing workloads** during testing
- **Stable network conditions**

### 2. Test Execution
- **Run multiple iterations** for consistency
- **Monitor system resources** during tests
- **Document test conditions** and environment
- **Save results** for comparison

### 3. Result Analysis
- **Compare across scenarios** to identify patterns
- **Look for inflection points** in scaling
- **Consider resource efficiency**, not just raw performance
- **Test realistic workloads** for your use case

### 4. Continuous Testing
- **Integrate into CI/CD** pipelines
- **Set performance baselines** and alerts
- **Regular regression testing** with each release
- **Monitor production** metrics for validation

## 🎯 Performance Targets

### Expected Performance (per node)

| Metric | Target | Excellent |
|--------|--------|-----------|
| Throughput | 500+ req/sec | 1000+ req/sec |
| Latency | <100ms | <50ms |
| Success Rate | >99% | >99.9% |
| Memory Usage | <512MB | <256MB |

### Scaling Characteristics

| Cluster Size | Expected Scaling | Notes |
|--------------|------------------|-------|
| 1 → 3 nodes | 2.5-2.8x | Near-linear |
| 3 → 5 nodes | 1.6-1.8x | Good scaling |
| 5 → 7 nodes | 1.3-1.5x | Diminishing returns |
| 7+ nodes | <1.2x | Consider vertical scaling |

## 🚀 Production Readiness

Use scale testing to validate:

- **Capacity planning**: Determine node count for expected load
- **Resource allocation**: Set appropriate CPU/memory limits
- **Monitoring thresholds**: Establish alerting levels
- **Failure modes**: Understand degradation patterns
- **Recovery testing**: Validate cluster resilience

Scale testing is essential for production deployment confidence and operational planning.

---

**Ready to scale? Start with `make docker-scale-test-quick` and explore your REPRAM cluster's capabilities!** 🚀