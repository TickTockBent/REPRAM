# Fade Flux Deployment Plan

## Overview
This document outlines the deployment strategy for the Fade demonstration application on Flux using the auto-discovery mechanism. **Tested and verified** with 3 nodes using automatic port allocation and peer discovery.

## Architecture Decisions

### Auto-Discovery Strategy
We use **automatic port discovery** instead of manual service coordination:

1. **Single Container**: Multiple REPRAM nodes run in one container (simulating Flux deployment)
2. **Automatic Port Allocation**: Nodes discover and claim available ports from a predefined range
3. **Self-Organizing Network**: Nodes automatically discover peers and form gossip networks
4. **Zero Configuration**: No manual bootstrap peer configuration needed

**Rationale**: 
- Works with Flux's single-domain deployment model
- Eliminates service discovery complexity
- Scales automatically without configuration changes
- Respects REPRAM's core principle of equal nodes

### Container Strategy

```
┌─────────────────────────────────────────┐
│         Flux Container                  │
│         fade.repram.io                  │
│                                         │
│  ┌─────────────┐   ┌─────────────┐      │
│  │ flux-node-1 │   │ flux-node-2 │      │
│  │ port: 8081  │   │ port: 8082  │      │
│  └──────┬──────┘   └──────┬──────┘      │
│         │                 │             │
│         └────────┬────────┘             │
│                  │                      │
│         ┌────────▼────────┐             │
│         │   flux-node-3   │             │
│         │   port: 8083    │             │
│         │   └─────────────┘             │
│                                         │
│  All nodes share fade.repram.io         │
│  and auto-discover ports 8081-8090      │
└─────────────────────────────────────────┘
```

### Image Naming Convention
```
# Docker Hub public repository
ticktockbent/repram-flux:latest

# For production with versioning
ticktockbent/repram-flux:v1.0.0
```

## Multi-Node Architecture

**Key Insight**: Flux deploys multiple instances in a single container, which is perfectly simulated by our multi-node launcher. This has been **tested and verified** to work correctly:

- **All nodes use auto-discovery** pointing to the same domain
- **Flux exposes multiple ports** on the same domain (fade.repram.io:8081, 8082, etc.)
- **Users get consistent experience** regardless of which port they access
- **Gossip protocol ensures data consistency** across all nodes
- **No coordination needed** between nodes - they're self-organizing

**Tested scenarios**:
✅ 3 nodes auto-discover ports and form network  
✅ Message written to port 8081 appears on all nodes  
✅ Data accessible via any port (8082, 8083, etc.)  
✅ Nodes handle startup timing and port conflicts gracefully  

## Docker Build Pipeline

### GitHub Actions Workflow
```yaml
name: Build and Push Docker Images

on:
  push:
    branches: [ main, fade-deployment ]
    paths:
      - 'cmd/**'
      - 'internal/**'
      - 'fade/**'
      - 'Dockerfile.flux-sim'

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3
        
      - name: Login to Docker Hub
        uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKERHUB_USERNAME }}
          password: ${{ secrets.DOCKERHUB_TOKEN }}
          
      - name: Build and push Flux image
        uses: docker/build-push-action@v5
        with:
          context: .
          file: ./Dockerfile.flux-sim
          push: true
          tags: |
            ticktockbent/repram-flux:latest
            ticktockbent/repram-flux:${{ github.sha }}
```

## Flux Configuration

### Application Configuration
```json
{
  "name": "fade-repram",
  "description": "REPRAM distributed ephemeral storage with auto-discovery",
  "docker_image": "ticktockbent/repram-flux:latest",
  "port": 8081,
  "containerPorts": [8081, 8082, 8083, 8084, 8085, 8086, 8087, 8088, 8089, 8090],
  "domains": ["fade.repram.io"],
  "environmentVariables": {
    "DISCOVERY_DOMAIN": "fade.repram.io",
    "BASE_PORT": "8081",
    "MAX_PORTS": "10",
    "NODE_COUNT": "3",
    "REPLICATION_FACTOR": "3"
  },
  "instances": 3,
  "containerData": "/tmp",
  "healthCheck": {
    "path": "/health",
    "port": 8081,
    "interval": 30
  }
}
```

### Environment Variables
```bash
# Required for auto-discovery
DISCOVERY_DOMAIN=fade.repram.io
BASE_PORT=8081
MAX_PORTS=10
NODE_COUNT=3
REPLICATION_FACTOR=3

# Optional tuning
REPRAM_CLEANUP_INTERVAL=30
REPRAM_RATE_LIMIT=100
```

## Testing Strategy

### Local Testing
```bash
# Test the exact deployment scenario
cd fade/
./test-flux-sim.sh

# Verify:
# - Multiple nodes start in single container
# - Nodes discover different ports automatically
# - Peer discovery works
# - Data replication functions
```

### Production Verification
```bash
# Health check all discovered nodes
for port in {8081..8085}; do
  curl https://fade.repram.io:$port/health 2>/dev/null && echo "Port $port active"
done

# Verify peer discovery
curl https://fade.repram.io:8081/peers

# Test data flow
curl -X PUT -d "test" https://fade.repram.io:8081/data/test?ttl=600
curl https://fade.repram.io:8082/data/test  # Should return "test"
```

## Deployment Process

### 1. Build and Push Image
```bash
docker build -f Dockerfile.flux-sim -t ticktockbent/repram-flux:latest .
docker push ticktockbent/repram-flux:latest
```

### 2. Deploy to Flux
- Configure Flux application with the JSON configuration above
- Ensure all ports 8081-8090 are exposed
- Set required environment variables

### 3. Monitor Deployment
```bash
# Check health endpoints
curl https://fade.repram.io:8081/health
curl https://fade.repram.io:8082/health
curl https://fade.repram.io:8083/health

# Verify network formation
curl https://fade.repram.io:8081/peers
```

## Monitoring & Operations

### Health Monitoring
Each node exposes:
- `GET /health` - Basic health status
- `GET /peers` - Known peer nodes
- `GET /status` - Detailed node information

### Logging
Container logs show:
- Port allocation decisions
- Peer discovery events
- Gossip network formation
- Data replication status

### Scaling
To scale the deployment:
1. Increase `NODE_COUNT` environment variable
2. Increase `MAX_PORTS` if needed
3. Ensure additional ports are exposed in Flux
4. Redeploy - new nodes auto-discover existing network

## Migration from Previous Approaches

### From Manual Bootstrap
1. Remove `REPRAM_BOOTSTRAP_PEERS` environment variables
2. Add auto-discovery environment variables
3. Use `ticktockbent/repram-flux` image instead of `repram-cluster-node`
4. Deploy and let nodes self-organize

### Benefits Over Kubernetes Approach
- **Simpler**: No StatefulSets, Services, or complex networking
- **Self-Contained**: Everything in one container
- **Flux Native**: Designed for Flux's deployment model
- **Zero Configuration**: No manual peer management
- **Automatically Scalable**: Just change `NODE_COUNT`

## Troubleshooting

### Nodes Not Starting
- Check container logs for port binding errors
- Verify `BASE_PORT` range is available
- Ensure `NODE_COUNT` matches Flux configuration

### Peer Discovery Issues
- Verify `DISCOVERY_DOMAIN` is correct
- Check if all ports are exposed by Flux
- Allow time for discovery (5-10 seconds after startup)

### Data Replication Problems
- Confirm gossip network formation via `/peers` endpoint
- Check node health status
- Verify TTL settings (minimum 300 seconds)

This deployment approach is **production-ready** and has been thoroughly tested with the auto-discovery mechanism. It provides a robust, self-organizing REPRAM network on Flux without complex configuration.