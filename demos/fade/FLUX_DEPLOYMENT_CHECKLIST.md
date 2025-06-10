# Flux Deployment Checklist

## Pre-Deployment Checklist

- [ ] **Docker Image Built**
  ```bash
  docker build -f Dockerfile.flux-sim -t ticktockbent/repram-flux:latest .
  ```

- [ ] **Local Testing Passed**
  ```bash
  cd fade/
  ./test-flux-sim.sh
  # Verify: 3 nodes start, discover each other, replicate data
  ```

- [ ] **Docker Hub Push**
  ```bash
  docker login
  docker push ticktockbent/repram-flux:latest
  ```

## Flux Configuration

- [ ] **Application Name**: `fade-repram`
- [ ] **Domain**: `fade.repram.io`
- [ ] **Docker Image**: `ticktockbent/repram-flux:latest`
- [ ] **Instances**: 3 (minimum for Flux)
- [ ] **Container Ports**: `[8081, 8082, 8083, 8084, 8085, 8086, 8087, 8088, 8089, 8090]`

## Environment Variables for Flux

```bash
DISCOVERY_DOMAIN=fade.repram.io
BASE_PORT=8081
MAX_PORTS=10
NODE_COUNT=3
REPLICATION_FACTOR=3
```

## Post-Deployment Verification

- [ ] **Check Node Health**
  ```bash
  curl https://fade.repram.io:8081/health
  curl https://fade.repram.io:8082/health
  curl https://fade.repram.io:8083/health
  ```

- [ ] **Verify Peer Discovery**
  ```bash
  curl https://fade.repram.io:8081/peers
  # Should show 2 peers (ports of other nodes)
  ```

- [ ] **Test Data Replication**
  ```bash
  # Store data
  curl -X PUT -d "Hello Flux" https://fade.repram.io:8081/data/test?ttl=600
  
  # Verify on other nodes
  curl https://fade.repram.io:8082/data/test
  curl https://fade.repram.io:8083/data/test
  ```

- [ ] **Monitor Logs** (if Flux provides access)
  ```bash
  # Check for auto-discovery success
  grep "Successfully allocated ports" logs
  grep "Discovered.*active peers" logs
  ```

## Troubleshooting Commands

### If nodes aren't starting:
```bash
# Check each port
for p in {8081..8085}; do
  echo -n "Port $p: "
  curl -s https://fade.repram.io:$p/health || echo "Not responding"
done
```

### If discovery isn't working:
```bash
# Check if nodes can see the domain
curl https://fade.repram.io:8081/health
curl https://fade.repram.io:8082/health

# Verify peer counts
curl https://fade.repram.io:8081/peers | jq '.peers | length'
```

## Rollback Plan

If auto-discovery fails:
1. Switch back to traditional deployment with manual `REPRAM_BOOTSTRAP_PEERS`
2. Use the standard `cluster-node` image instead of `flux-sim`
3. Deploy each node as a separate Flux service

## Success Criteria

- [x] All 3 nodes report healthy status
- [x] Each node discovers 2 peers
- [x] Data stored on one node appears on all nodes
- [x] Nodes remain stable for 10+ minutes
- [ ] Fade UI can connect and display messages

## Notes for Deployment

1. **First deployment**: May take a few minutes for all nodes to discover each other
2. **Port allocation**: Nodes may not get sequential ports (8081, 8082, 8083) - this is normal
3. **Gossip delay**: Allow 5-10 seconds after startup for full peer discovery
4. **Health endpoint**: Use for Flux health checks if supported

## Contact for Issues

- GitHub Issues: https://github.com/yourusername/repram/issues
- Flux Support: For Flux-specific deployment issues

Good luck with the deployment! 🚀