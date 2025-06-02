# REPRAM Flux Auto-Discovery Deployment Guide

## Overview

This document describes how to deploy REPRAM to Flux using automatic port discovery. This approach allows multiple REPRAM instances to run in a single container (as Flux deploys them) and automatically organize themselves into a distributed network without manual configuration.

## How It Works

1. **Single Container, Multiple Instances**: Flux deploys one container that runs multiple REPRAM nodes
2. **Automatic Port Discovery**: Each node automatically finds an available port from a predefined range
3. **Peer Discovery**: Nodes scan the port range to discover other active nodes
4. **Self-Organizing Network**: Nodes form a gossip network automatically

## Architecture

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
│         └─────────────────┘             │
│                                         │
│  All nodes share localhost              │
│  and auto-discover each other           │
└─────────────────────────────────────────┘
```

## Container Configuration

### Dockerfile (Dockerfile.flux-sim)

The container includes:
- The REPRAM cluster node binary
- A multi-node launcher script
- Runtime dependencies (curl, bash)

### Multi-Node Launcher Script

The `multi-node-launcher.sh` script:
1. Reads configuration from environment variables
2. Starts multiple REPRAM nodes with staggered timing
3. Each node automatically discovers an available port
4. Monitors node health and handles shutdown gracefully

## Environment Variables

```bash
# Required for Flux deployment
DISCOVERY_DOMAIN=fade.repram.io    # Your Flux domain
BASE_PORT=8081                     # First port to try
MAX_PORTS=10                       # Size of port range (8081-8090)
NODE_COUNT=3                       # Number of instances to run
REPLICATION_FACTOR=3               # Gossip replication factor

# Optional
USE_AUTO_DISCOVERY=true            # Enable auto-discovery (set automatically)
NODE_ADDRESS=localhost             # Address for gossip (set automatically)
```

## Flux Deployment Steps

### 1. Build and Push Docker Image

```bash
# Build the Flux simulation image
docker build -f Dockerfile.flux-sim -t yourdockerhub/repram-flux:latest .

# Push to Docker Hub
docker push yourdockerhub/repram-flux:latest
```

### 2. Flux Application Configuration

Create your Flux application with these settings:

```json
{
  "name": "fade-repram",
  "description": "REPRAM distributed ephemeral storage",
  "docker_image": "yourdockerhub/repram-flux:latest",
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
  "containerData": "/tmp"
}
```

### 3. Port Exposure

Ensure Flux exposes all ports in your range:
- HTTP API ports: 8081-8090
- Gossip ports: 9081-9090 (BASE_PORT + 1000)

## Testing Before Deployment

### Local Test with Docker Compose

```bash
cd fade/
docker-compose -f docker-compose-flux-sim.yml up -d
./test-flux-sim.sh
```

### Verify Auto-Discovery

```bash
# Check which nodes are active
for port in {8081..8085}; do
  curl -s http://localhost:$port/health 2>/dev/null && echo "Node active on port $port"
done

# Check peer discovery
curl http://localhost:8081/peers

# Test data replication
curl -X PUT -d "test data" http://localhost:8081/data/test?ttl=600
curl http://localhost:8082/data/test  # Should return "test data"
```

## Monitoring in Production

### Health Checks

Each node exposes a health endpoint:
```bash
curl https://fade.repram.io:8081/health
```

Response:
```json
{
  "status": "healthy",
  "node_id": "flux-node-1",
  "discovery_enabled": true,
  "active_peers": 2
}
```

### View Active Nodes

From any node, query the peer list:
```bash
curl https://fade.repram.io:8081/peers
```

### Container Logs

Inside the Flux container:
```bash
# View all node logs
tail -f /tmp/flux-node-*.log

# View specific node
tail -f /tmp/flux-node-1.log
```

## Troubleshooting

### No Nodes Starting

1. Check container logs for port binding errors
2. Verify BASE_PORT range is available
3. Ensure NODE_COUNT matches Flux instance setting

### Nodes Not Discovering Each Other

1. Verify DISCOVERY_DOMAIN is correct
2. Check firewall rules for internal port access
3. Increase MAX_PORTS if NODE_COUNT is high

### Port Conflicts

If nodes report port conflicts:
1. Increase stagger delay in launcher script
2. Expand port range (increase MAX_PORTS)
3. Check for other services using the ports

## Fade Server Integration

The Fade server can either:

### Option 1: Static Configuration (Simple)
```bash
FADE_NODES=http://fade.repram.io:8081,http://fade.repram.io:8082,http://fade.repram.io:8083
```

### Option 2: Dynamic Discovery (Advanced)
Implement port scanning in Fade server to discover active nodes:
```javascript
// Scan port range to find active nodes
for (let port = 8081; port <= 8085; port++) {
  try {
    const response = await fetch(`http://fade.repram.io:${port}/health`);
    if (response.ok) {
      activeNodes.push(`http://fade.repram.io:${port}`);
    }
  } catch (e) {
    // Port not active
  }
}
```

## Key Advantages

1. **Zero Configuration**: No manual bootstrap peer configuration
2. **Self-Organizing**: Nodes automatically form the network
3. **Fault Tolerant**: Nodes can restart and reclaim ports
4. **Scalable**: Just increase NODE_COUNT and MAX_PORTS
5. **Flux Compatible**: Designed for Flux's deployment model

## Migration from Static Configuration

If migrating from hardcoded bootstrap peers:

1. Remove `REPRAM_BOOTSTRAP_PEERS` environment variable
2. Add auto-discovery environment variables
3. Ensure all nodes use the same `DISCOVERY_DOMAIN`
4. Deploy and let nodes self-organize

## Security Considerations

1. **Internal Only**: Port scanning should only work within Flux network
2. **Rate Limiting**: Nodes have built-in rate limiting on discovery endpoints
3. **UUID Validation**: Nodes use UUIDs to prevent spoofing
4. **Conflict Resolution**: Deterministic resolution prevents split-brain

## Summary

This auto-discovery approach allows REPRAM to deploy on Flux without any manual network configuration. Nodes automatically:
- Find available ports
- Discover peer nodes  
- Form gossip networks
- Replicate data

Perfect for Flux's multi-instance, single-container deployment model!