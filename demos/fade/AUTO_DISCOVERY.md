# REPRAM Auto-Discovery Implementation

## Overview

REPRAM nodes can now automatically discover available ports and form a peer-to-peer network without manual configuration. This feature is designed specifically for deployment on platforms like Flux where all containers share the same domain but need to claim different ports.

## How It Works

1. **Port Allocation**: Each node tries to claim a port from a predefined range (e.g., 8081-8085)
2. **Conflict Detection**: Nodes detect if another node already claimed a port
3. **Peer Discovery**: Nodes scan the port range to find active peers
4. **Bootstrap Integration**: Discovered peers are used as bootstrap nodes for gossip

## Configuration

Enable auto-discovery with these environment variables:

```bash
USE_AUTO_DISCOVERY=true      # Enable auto-discovery mode
DISCOVERY_DOMAIN=localhost   # Domain shared by all nodes (fade.repram.io in Flux)
BASE_PORT=8081              # Starting port number
MAX_PORTS=5                 # Maximum number of ports to try
```

## Port Mapping

- **HTTP Port**: The discovered port (e.g., 8081)
- **Gossip Port**: HTTP port + 1000 (e.g., 9081)

## Testing Locally

### Basic Test (3 nodes)
```bash
cd fade/
docker-compose -f docker-compose-autodiscovery.yml up -d
./test-autodiscovery.sh
```

### Host Network Test (simulates Flux)
```bash
docker-compose -f docker-compose-autodiscovery-host.yml up -d
```

### Manual Testing
```bash
# Check node health
curl http://localhost:8081/health

# View discovered peers
curl http://localhost:8081/peers

# Store data
curl -X PUT -d "test data" http://localhost:8081/data/mykey?ttl=600

# Verify replication
curl http://localhost:8082/data/mykey
curl http://localhost:8083/data/mykey
```

## Flux Deployment

For Flux deployment, configure your application with:

```yaml
environment:
  - USE_AUTO_DISCOVERY=true
  - DISCOVERY_DOMAIN=fade.repram.io
  - BASE_PORT=8081
  - MAX_PORTS=5
  - REPLICATION_FACTOR=3

# Expose the port range
ports:
  - 8081:8081
  - 8082:8082
  - 8083:8083
  - 8084:8084
  - 8085:8085
```

## Fallback Mode

If auto-discovery is disabled or fails, nodes fall back to the traditional configuration using `REPRAM_BOOTSTRAP_PEERS`.

## Algorithm Details

1. **Startup**:
   - Node generates/uses unique ID
   - Shuffles port list to reduce conflicts
   - Tries to bind each port sequentially

2. **Conflict Resolution**:
   - If two nodes try the same port, one backs off
   - Random delays prevent thundering herd
   - Exponential backoff on repeated conflicts

3. **Peer Discovery**:
   - HTTP health checks on all ports
   - Announces self to discovered peers
   - Maintains active peer list

4. **Graceful Shutdown**:
   - Notifies all peers before leaving
   - Releases port for future use

## Benefits

- **Zero Configuration**: No need to hardcode peer addresses
- **Dynamic Scaling**: Add/remove nodes without reconfiguration  
- **Self-Healing**: Nodes rediscover peers after failures
- **Platform Agnostic**: Works on any system with predictable domains