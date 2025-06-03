# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Architecture

REPRAM (REplicated EPhemeral RAM) is a distributed ephemeral key-value storage system designed for high-performance, privacy-preserving applications. It uses a dual licensing model:

- **Open Source Node**: Stores unencrypted data, can be run by anyone (MIT license)
- **Proprietary SDK**: Handles client-side encryption and communicates with nodes (commercial license)

### Core Components

- **Node Server** (`internal/node/server.go`): HTTP REST API with interface-based storage abstraction, security middleware, and Prometheus metrics
- **Memory Storage** (`internal/storage/memory.go`): TTL-based ephemeral storage with background cleanup every 30 seconds
- **Crypto Layer** (`internal/crypto/` and `repram-sdk/crypto/`): AES-256-GCM client-side encryption
- **Client Libraries**: HTTP clients with optional encryption (`pkg/client/` and `repram-sdk/client/`)
- **Gossip Protocol** (`internal/gossip/`): Peer-to-peer replication for distributed deployments

### Node Types

The codebase provides three node implementations:
1. **Main node** (`cmd/node/main.go`) - Works with encrypted SDK
2. **Open-source node** (`cmd/node-raw/main.go`) - Stores unencrypted data directly with standard endpoints
3. **Cluster node** (`cmd/cluster-node/main.go`) - Supports distributed deployment with gossip protocol and quorum-based writes

All use the same core storage components but expose different APIs.

## Common Development Commands

```bash
# Building
make build              # Main encrypted node
make build-raw          # Open-source unencrypted node  
make build-cluster      # Cluster node with gossip protocol
make build-sdk-example  # Proprietary SDK example

# Running
make run               # Start main node (port 8080)
make run-raw          # Start open-source node (port 8080)
make run-cluster      # Start cluster node (port 8080)

# Testing & Demos
make test             # Run all tests
make demo-opensource  # Curl-based demo of raw node
make demo-sdk        # End-to-end encrypted SDK demo

# Docker Operations
make docker-build               # Build container image
make docker-compose-cluster    # Run 3-node cluster
make docker-scale-test-quick   # Quick scale testing (10 clients, 30s)
make docker-scale-test-full    # Full performance testing (100 clients, 5m)

# Cleanup
make clean           # Remove all built binaries
```

## API Endpoints

All nodes provide the same core API:
- `PUT /data/{key}` - Store raw data with TTL (via query param `?ttl=seconds` or `X-TTL` header)
- `GET /data/{key}` - Retrieve raw data exactly as stored
- `GET /health` - Health check
- `GET /status` - Detailed status including metrics, uptime, and node info
- `GET /metrics` - Prometheus metrics endpoint

**Additional endpoints by node type:**
- **Cluster Node** (`cmd/cluster-node/main.go`):
  - `GET /scan` - List all keys
  - `POST /gossip/message` - Gossip protocol communication
  - `POST /bootstrap` - Node bootstrapping
  - `PUT /cluster/put/{key}` - Alternative cluster-specific put endpoint
  - `GET /cluster/get/{key}` - Alternative cluster-specific get endpoint
  - `GET /cluster/scan` - Alternative cluster-specific scan endpoint

## Key Architecture Patterns

- **Pure Key-Value Storage**: Nodes accept any data format without interpretation
- **Interface-based Storage**: `Store` interface allows pluggable backends (currently only `MemoryStore`)
- **Client-side Encryption**: When encryption is needed, it happens in the SDK/client before reaching nodes
- **TTL Management**: Automatic expiration via background goroutines and on-access cleanup (minimum 300s)
- **Zero-knowledge Storage**: Nodes store data as opaque blobs without understanding content

## Important Development Notes

- **Data Format**: Nodes accept raw data in request body; TTL is passed via query parameter or header
- **Encryption Separation**: The `repram-sdk/` directory is a separate Go module for proprietary distribution
- **Storage Interface**: When adding new storage backends, implement the `Store` interface
- **TTL Enforcement**: Minimum 300 seconds per core principles; cleanup runs every 30 seconds
- **HTTP Client**: SDK clients send raw encrypted data directly, not wrapped in JSON

## Testing

```bash
make test                    # Run all unit tests
make test-cluster           # Test 3-node cluster with gossip
scripts/test-cluster.sh     # Manual cluster testing
scripts/load-test.sh        # Load testing script

# Test auto-discovery for Flux deployment
cd fade/
./test-flux-sim.sh          # Test multi-node in single container
```

For integration testing, use the demo commands which start nodes and run full end-to-end scenarios.

## Auto-Discovery Mode (Flux Deployment)

REPRAM supports automatic port discovery for platforms like Flux where multiple instances share the same domain:

```bash
# Enable auto-discovery
USE_AUTO_DISCOVERY=true
DISCOVERY_DOMAIN=fade.repram.io
BASE_PORT=8081              # Starting port
MAX_PORTS=10                # Port range size

# Nodes will automatically:
# 1. Find available ports (8081-8090)
# 2. Discover peer nodes
# 3. Form gossip network
```

See `docs/flux-auto-discovery-deployment.md` for detailed Flux deployment instructions.

## Production Features

- **Security Middleware**: Rate limiting (100 req/sec), security headers, request validation
- **Monitoring**: Prometheus metrics, health endpoints, detailed status reporting
- **Gossip Protocol**: Eventually consistent replication with configurable quorum sizes
- **Docker Support**: Multi-stage builds, compose files for local clusters
- **Flux Deployment**: Auto-discovery for multi-instance deployment
- **Auto-Discovery**: Self-organizing nodes for simplified deployment