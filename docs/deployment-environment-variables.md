# Deployment Environment Variables

This document outlines the environment variable configuration strategy for deploying Fade in containerized environments without service discovery.

## Container Images

### 1. Cluster Node Container: `ticktockbent/repram-cluster-node`

**Required Environment Variables:**

```bash
# Node Identity
REPRAM_NODE_ID=fade-node-1              # Unique identifier for this node
NODE_ADDRESS=fade-node-1.example.com    # Externally reachable address

# Port Configuration
REPRAM_PORT=8080                        # HTTP API port
REPRAM_GOSSIP_PORT=9090                 # Gossip protocol port

# Cluster Configuration
REPLICATION_FACTOR=3                    # Number of replicas for each message
REPRAM_BOOTSTRAP_PEERS=fade-node-1.example.com:8080,fade-node-2.example.com:8080  # Bootstrap nodes (comma-separated)
```

**Optional Environment Variables:**

```bash
# Performance Tuning
REPRAM_MAX_REQUEST_SIZE=10485760        # Max request size in bytes (10MB)
REPRAM_RATE_LIMIT=100                   # Rate limit per IP
REPRAM_RATE_BURST=200                   # Rate limit burst
REPRAM_CLEANUP_INTERVAL=30              # TTL cleanup interval in seconds

# Gossip Protocol
QUORUM_SIZE=2                           # Minimum nodes for consensus
GOSSIP_INTERVAL=1                       # Gossip sync interval in seconds
HEARTBEAT_INTERVAL=5                    # Health check interval in seconds

# Logging
REPRAM_LOG_LEVEL=info                   # Log level: debug, info, warn, error
```

### 2. Fade Server Container: `ticktockbent/fade-server`

**Required Environment Variables:**

```bash
# Node Discovery
FADE_NODES=http://fade-node-1.example.com:8080,http://fade-node-2.example.com:8080,http://fade-node-3.example.com:8080

# Server Configuration
PORT=3000                               # Web server port
```

**Optional Environment Variables:**

```bash
# Load Balancing
FADE_HEALTH_CHECK_INTERVAL=10           # Health check interval in seconds
FADE_REQUEST_TIMEOUT=30                 # Request timeout in seconds
FADE_RETRY_ATTEMPTS=3                   # Number of retry attempts per request

# CORS Configuration
FADE_CORS_ORIGINS=*                     # Allowed origins for CORS
FADE_CORS_METHODS=GET,POST,PUT,DELETE   # Allowed HTTP methods

# Logging
FADE_LOG_LEVEL=info                     # Log level
```

## Bootstrap Strategy

### Seed Node Pattern
The first node starts without bootstrap peers and becomes the seed:

```bash
# Node 1 (Seed)
REPRAM_NODE_ID=fade-node-1
NODE_ADDRESS=fade-node-1.example.com
REPRAM_BOOTSTRAP_PEERS=""               # Empty for seed node

# Node 2 (Bootstrap from seed)
REPRAM_NODE_ID=fade-node-2
NODE_ADDRESS=fade-node-2.example.com
REPRAM_BOOTSTRAP_PEERS=fade-node-1.example.com:8080

# Node 3 (Bootstrap from seed)
REPRAM_NODE_ID=fade-node-3
NODE_ADDRESS=fade-node-3.example.com
REPRAM_BOOTSTRAP_PEERS=fade-node-1.example.com:8080
```

### Multi-Seed Pattern (More Resilient)
Multiple nodes can act as bootstrap seeds:

```bash
# All nodes bootstrap from multiple peers
REPRAM_BOOTSTRAP_PEERS=fade-node-1.example.com:8080,fade-node-2.example.com:8080
```

## Deployment Scenarios

### 1. Docker Compose (Local Development)
```yaml
environment:
  - REPRAM_NODE_ID=fade-node-1
  - NODE_ADDRESS=fade-node-1
  - REPRAM_BOOTSTRAP_PEERS=fade-node-2:8080,fade-node-3:8080
```

### 2. Flux/Nomad Deployment
```bash
# Pre-configured node addresses
REPRAM_NODE_ID=${NODE_NAME}
NODE_ADDRESS=${PUBLIC_IP}:8080
REPRAM_BOOTSTRAP_PEERS=10.0.1.10:8080,10.0.1.11:8080,10.0.1.12:8080
```

### 3. Static Cloud Deployment
```bash
# Using cloud load balancer IPs
NODE_ADDRESS=fade-lb.amazonaws.com
REPRAM_BOOTSTRAP_PEERS=fade-1.amazonaws.com:8080,fade-2.amazonaws.com:8080
```

## Health Check Configuration

Both containers expose health endpoints:

- **Cluster Node**: `GET /health` on port 8080
- **Fade Server**: `GET /health` on port 3000

Health check example:
```bash
curl -f http://localhost:8080/health || exit 1
```

## Troubleshooting

### Common Issues

1. **Bootstrap Failure**
   - Check `REPRAM_BOOTSTRAP_PEERS` addresses are reachable
   - Ensure seed node is running before other nodes
   - Verify network connectivity on both HTTP and gossip ports

2. **Split Brain**
   - Occurs when nodes can't reach each other
   - Check `QUORUM_SIZE` vs. number of reachable nodes
   - Restart nodes with correct bootstrap configuration

3. **Port Conflicts**
   - Ensure `REPRAM_PORT` and `REPRAM_GOSSIP_PORT` don't conflict
   - Check firewall rules for gossip ports

### Debug Commands

```bash
# Check node health
curl http://node:8080/health

# Check fade server connectivity to nodes
curl http://fade-server:3000/api/health

# View cluster status (if endpoint exists)
curl http://node:8080/cluster/status
```

## Security Considerations

- **No Authentication**: Current implementation has no auth
- **Network Security**: Restrict gossip ports to cluster-only networks
- **TLS**: Consider adding TLS for production deployments
- **Firewall Rules**: 
  - HTTP ports (8080): Open to load balancer/ingress
  - Gossip ports (9090): Cluster-internal only
  - Fade server (3000): Open to users

## Example Deployment Configurations

### 3-Node Production Setup
```bash
# deployment.env
REPRAM_NODE_1_ADDR=10.0.1.10:8080
REPRAM_NODE_2_ADDR=10.0.1.11:8080
REPRAM_NODE_3_ADDR=10.0.1.12:8080

# Node 1
REPRAM_NODE_ID=prod-fade-1
NODE_ADDRESS=10.0.1.10
REPRAM_BOOTSTRAP_PEERS=10.0.1.11:8080,10.0.1.12:8080

# Node 2
REPRAM_NODE_ID=prod-fade-2
NODE_ADDRESS=10.0.1.11
REPRAM_BOOTSTRAP_PEERS=10.0.1.10:8080,10.0.1.12:8080

# Node 3
REPRAM_NODE_ID=prod-fade-3
NODE_ADDRESS=10.0.1.12
REPRAM_BOOTSTRAP_PEERS=10.0.1.10:8080,10.0.1.11:8080

# Fade Server
FADE_NODES=http://10.0.1.10:8080,http://10.0.1.11:8080,http://10.0.1.12:8080
```

This configuration ensures that if any single node fails, the remaining nodes can maintain quorum and continue operating.