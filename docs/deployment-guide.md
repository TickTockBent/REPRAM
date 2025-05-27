# REPRAM Deployment Guide

This guide covers deploying REPRAM in production environments with Docker, Kubernetes, and monitoring.

## Quick Start

### Docker Deployment

1. **Build the image:**
   ```bash
   make docker-build
   ```

2. **Run single node:**
   ```bash
   make docker-run
   ```

3. **Run cluster:**
   ```bash
   make docker-compose-cluster
   ```

### Kubernetes Deployment

1. **Deploy with kubectl:**
   ```bash
   kubectl apply -f k8s/namespace.yaml
   kubectl apply -f k8s/configmap.yaml
   kubectl apply -f k8s/cluster.yaml
   kubectl apply -f k8s/monitoring.yaml
   ```

2. **Deploy with Helm:**
   ```bash
   helm install repram ./helm/repram \
     --namespace repram \
     --create-namespace \
     --set mode=cluster \
     --set replicaCount=3
   ```

## Production Configuration

### Security Settings

- **Rate Limiting:** 100 req/sec per IP, burst of 200
- **Request Size Limit:** 10MB maximum
- **Security Headers:** Automatic application
- **Network Policies:** Pod-to-pod communication restrictions

### Resource Requirements

**Minimum per node:**
- CPU: 500m
- Memory: 512Mi

**Recommended per node:**
- CPU: 1000m  
- Memory: 1Gi

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REPRAM_PORT` | 8080 | HTTP API port |
| `REPRAM_GOSSIP_PORT` | 9090 | Cluster communication port |
| `REPRAM_LOG_LEVEL` | info | Logging level (debug, info, warn, error) |
| `REPRAM_RATE_LIMIT` | 100 | Requests per second per IP |
| `REPRAM_RATE_BURST` | 200 | Rate limit burst size |
| `REPRAM_MAX_REQUEST_SIZE` | 10485760 | Maximum request size (bytes) |

## Monitoring

### Prometheus Metrics

REPRAM exposes metrics at `/metrics`:

- `repram_requests_total` - Total HTTP requests by method/endpoint/status
- `repram_request_duration_seconds` - Request duration histogram
- `repram_storage_bytes` - Total storage size
- `repram_storage_items` - Number of stored items
- `repram_rate_limited_requests_total` - Rate-limited requests
- `repram_oversized_requests_total` - Rejected oversized requests
- `repram_suspicious_requests_total` - Blocked suspicious requests

### Health Endpoints

- `/health` - Basic health check
- `/status` - Detailed status with memory and uptime
- `/metrics` - Prometheus metrics

### Alerting Rules

```yaml
groups:
- name: repram
  rules:
  - alert: RepramNodeDown
    expr: up{job="repram"} == 0
    for: 1m
    labels:
      severity: critical
    annotations:
      summary: REPRAM node is down
      
  - alert: RepramHighErrorRate
    expr: rate(repram_requests_total{status!~"2.*"}[5m]) > 0.1
    for: 2m
    labels:
      severity: warning
    annotations:
      summary: High error rate in REPRAM
```

## Load Testing

### Quick Load Test
```bash
make load-test
```

### Ramp-up Test
```bash
make load-test-ramp
```

### Stress Test
```bash
make load-test-stress
```

### Custom Test
```bash
./scripts/load-test.sh --url http://repram.example.com --concurrency 50 --duration 120s
```

## Troubleshooting

### Common Issues

1. **High memory usage:**
   - Check storage metrics
   - Verify TTL cleanup is working
   - Monitor for memory leaks

2. **Rate limiting issues:**
   - Check rate limit configuration
   - Monitor rate limit metrics
   - Adjust limits if needed

3. **Cluster connectivity:**
   - Verify gossip port connectivity
   - Check bootstrap peer configuration
   - Monitor cluster health

### Debug Commands

```bash
# Check node health
curl http://localhost:8080/health

# Get detailed status
curl http://localhost:8080/status

# View metrics
curl http://localhost:8080/metrics

# Check cluster logs
kubectl logs -n repram deployment/repram-cluster -f
```

## Security Considerations

1. **Network Security:**
   - Use TLS termination at ingress
   - Implement network policies
   - Restrict gossip port access

2. **Access Control:**
   - Deploy behind authentication proxy
   - Use service mesh for mTLS
   - Monitor access patterns

3. **Data Protection:**
   - Client-side encryption is mandatory
   - Nodes store encrypted data only
   - TTL ensures data expiration

## Scaling

### Horizontal Scaling

```bash
# Scale with kubectl
kubectl scale statefulset repram-cluster --replicas=5

# Scale with Helm
helm upgrade repram ./helm/repram --set replicaCount=5
```

### Performance Tuning

1. **Memory optimization:**
   - Tune garbage collection
   - Monitor memory patterns
   - Adjust resource limits

2. **Network optimization:**
   - Tune connection pooling
   - Optimize gossip intervals
   - Use regional clusters

## Backup and Recovery

### Data Persistence

REPRAM is ephemeral by design, but for disaster recovery:

1. **Application-level backups:**
   - Implement client-side backup of critical data
   - Use external storage for persistent data
   - Maintain encryption keys separately

2. **Cluster recovery:**
   - Bootstrap new nodes with existing peers
   - Monitor cluster health during recovery
   - Validate data replication

## Maintenance

### Updates

1. **Rolling updates:**
   ```bash
   kubectl set image statefulset/repram-cluster repram=repram:new-version
   ```

2. **Health validation:**
   ```bash
   kubectl rollout status statefulset/repram-cluster
   ```

### Cleanup

1. **Manual cleanup:**
   ```bash
   # Force cleanup via API
   curl -X DELETE http://localhost:8080/admin/cleanup
   ```

2. **Scheduled cleanup:**
   - Runs automatically every 30 seconds
   - Configurable via environment variables
   - Monitor cleanup metrics