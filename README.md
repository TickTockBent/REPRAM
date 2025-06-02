# REPRAM

**REplicated EPhemeral RAM** - A distributed, ephemeral key-value storage network designed for high-performance, privacy-preserving applications. It provides a permissionless interface for encrypted, self-expiring data storage with zero trust assumptions.

## 🚀 Key Features

- **Encrypted Storage**: Client-side encryption ensures zero knowledge by the network
- **Ephemeral Data**: Time-to-live (TTL) enforced automatic data expiration
- **Distributed Architecture**: Symmetric node architecture with no central coordinator
- **Zero Trust**: Nodes cannot read or interpret user data
- **Production Ready**: Docker, Kubernetes, monitoring, and security hardening
- **Dual Licensing**: Open-source node software with proprietary encryption SDK

## 🏗 Architecture

REPRAM consists of two main components:

### Open Source Node
- Stores arbitrary binary data with TTL expiration
- REST API for data storage and retrieval
- In-memory storage with automatic cleanup
- Can be deployed by anyone to join the network
- Production hardening with rate limiting and security

### Proprietary SDK
- Client-side AES-256-GCM encryption
- Key generation and management
- Transparent encryption/decryption
- Available under commercial license

## 🛠 Quick Start

### Prerequisites
- Go 1.21+
- Make
- Docker (for containerized deployment)

### Building

```bash
# Clone the repository
git clone <repository-url>
cd REPRAM

# Build all components
make build              # Main encrypted node
make build-raw          # Open-source unencrypted node
make build-cluster      # Cluster node with gossip protocol

# Build Docker image
make docker-build
```

### Running

#### Single Node
```bash
# Local binary
make run

# Docker
make docker-run

# Docker with exposed metrics
docker run -p 8080:8080 repram:latest
```

#### Cluster Deployment
```bash
# Docker Compose (3 nodes)
make docker-compose-cluster

# Flux deployment with auto-discovery
# See docs/flux-auto-discovery-deployment.md
```

### Testing

```bash
# Basic tests
make test

# Load testing
make load-test              # Standard load test
make load-test-ramp         # Ramp-up test
make load-test-stress       # Stress test with large payloads

# Demos
make demo-opensource        # Curl-based demo
make demo-sdk              # End-to-end encrypted demo
```

## 📊 Production Features

### Monitoring & Observability
- **Prometheus metrics** at `/metrics`
- **Health checks** at `/health` and `/status`
- **Real-time storage statistics**
- **Request latency and throughput metrics**
- **Security metrics** (rate limiting, blocked requests)

### Security & Performance
- **Rate limiting**: 100 req/sec per IP (configurable)
- **Request validation**: 10MB max size, suspicious request detection
- **Security headers**: CSP, X-Frame-Options, etc.
- **DDoS protection**: Timeout middleware, connection limits
- **Load testing framework** with comprehensive benchmarks

### Deployment Options
- **Docker**: Single and multi-container setups
- **Docker Compose**: Local development and testing
- **Flux**: Auto-discovery deployment for distributed apps
- **Load Testing**: Comprehensive performance testing framework

## 📋 Available Commands

```bash
# Building
make build              # Main encrypted node
make build-raw          # Open-source unencrypted node  
make build-cluster      # Cluster node with gossip
make build-sdk-example  # Proprietary SDK example

# Running
make run               # Start main node (port 8080)
make run-raw          # Start open-source node
make run-cluster      # Start cluster node

# Docker
make docker-build                    # Build container image
make docker-run                     # Run single container
make docker-compose-up              # Full stack with compose
make docker-compose-cluster         # 3-node cluster

# Testing & Load Testing
make test                           # Unit tests
make load-test                      # Standard load test
make load-test-ramp                 # Ramp-up test (1→50 workers)
make load-test-stress               # Stress test (1KB→256KB)

# Demos
make demo-opensource               # Curl-based demo
make demo-sdk                     # Encrypted SDK demo

# Cleanup
make clean                        # Remove binaries
make docker-compose-down          # Stop Docker services
```

## 🔧 API Reference

### Core Endpoints (All Nodes)
- `PUT /data/{key}` - Store binary data with TTL
- `GET /data/{key}` - Retrieve binary data  
- `GET /health` - Simple health check
- `GET /status` - Detailed status with metrics
- `GET /metrics` - Prometheus metrics

### Open Source Endpoints (Raw Node)
- `POST /raw/put` - Store unencrypted string data
- `GET /raw/get/{key}` - Retrieve unencrypted string data

### Example Usage

```bash
# Store encrypted data (via SDK)
curl -X PUT http://localhost:8080/data/mykey \
  -H "Content-Type: application/json" \
  -d '{"data":"base64encodedencrypteddata","ttl":300}'

# Store raw data (open-source mode)
curl -X POST http://localhost:8080/raw/put \
  -H "Content-Type: application/json" \
  -d '{"data":"Hello REPRAM!","ttl":60}'

# Health check
curl http://localhost:8080/health

# Detailed status
curl http://localhost:8080/status

# Prometheus metrics
curl http://localhost:8080/metrics
```

## 🗺 Development Status

### ✅ Phase 1: MVP Core (Completed)
- Single-node ephemeral storage
- Client-side encryption
- Open-source/proprietary separation
- REST API implementation
- TTL-based data expiration

### ✅ Phase 2: Distributed Network (Completed)
- **gRPC-based gossip protocol** for peer communication
- **Quorum-based replication** with configurable factor
- **Bootstrap peer discovery** and dynamic peer management
- **Health monitoring** with ping/pong heartbeats
- **Symmetric architecture** with no coordinator nodes

### 🚧 Phase 3: Production Ready (In Progress)
- **Docker containerization** with security hardening
- **Kubernetes manifests** and Helm charts
- **Prometheus monitoring** with comprehensive metrics
- **Security features**: rate limiting, request validation, DDoS protection
- **Load testing framework** with multiple test patterns
- **Auto-discovery deployment** for platforms like Flux

### 📋 Phase 4: Extensions (Future)
- Long-term storage integration
- IPFS blob offloading
- Reputation scoring
- Web3 authentication bridges
- Post-quantum cryptography

## 🚀 Scale Testing

REPRAM includes comprehensive scale testing capabilities for Docker deployments:

### Quick Start
```bash
make docker-scale-test-quick  # Fast validation test
make docker-scale-test-full   # Complete performance matrix
make docker-monitor          # Real-time cluster monitoring
```

### Documentation
- **[Scale Testing Walkthrough](docs/scale-testing-walkthrough.md)** - Step-by-step guide with detailed instructions
- **[Docker Scale Testing Guide](docs/docker-scale-testing.md)** - Technical reference and advanced usage
- **[Deployment Guide](docs/deployment-guide.md)** - Production deployment procedures

The scale testing framework provides:
- **Automated cluster scaling** (1-7 nodes) with dynamic Docker Compose generation
- **Variable load testing** (10-100+ concurrent workers) with realistic workloads
- **Real-time monitoring** with live dashboards and metrics collection
- **Comprehensive reporting** with performance analysis and capacity planning

## 🤝 Use Cases

- **Temporary form submission data** with automatic cleanup
- **Anonymous session coordination** across distributed systems
- **Secure self-expiring messages** for privacy-focused applications
- **Short-lived tokens and access receipts** for authentication flows
- **Ephemeral game state or caches** with built-in expiration
- **Microservice coordination** with encrypted inter-service messaging

## 📊 Performance Characteristics

- **Throughput**: 1000+ req/sec per node (tested)
- **Latency**: Sub-millisecond for in-memory operations
- **Storage**: Efficient memory usage with automatic cleanup
- **Scaling**: Linear scaling with cluster size
- **Security**: Rate limiting and DDoS protection built-in

## 🔧 Configuration

Key environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `REPRAM_PORT` | 8080 | HTTP API port |
| `REPRAM_GOSSIP_PORT` | 9090 | Cluster communication port |
| `REPRAM_LOG_LEVEL` | info | Logging level |
| `REPRAM_RATE_LIMIT` | 100 | Requests per second per IP |
| `REPRAM_MAX_REQUEST_SIZE` | 10485760 | Max request size (10MB) |
| `REPRAM_REPLICATION_FACTOR` | 3 | Data replication factor |

## 📄 License

The REPRAM node software is open source under the MIT License. The REPRAM SDK and encryption components are proprietary and available under commercial license.

See [LICENSE](LICENSE) for details.

## 📞 Documentation & Support

### Core Documentation
- **[Development Plan](docs/development-plan.md)** - Project roadmap and architecture
- **[Project Overview](docs/project-overview.md)** - Technical deep dive
- **[Phase 3 Summary](docs/phase3-summary.md)** - Latest production features

### Deployment & Operations
- **[Deployment Guide](docs/deployment-guide.md)** - Production deployment instructions
- **[Scale Testing Walkthrough](docs/scale-testing-walkthrough.md)** - Step-by-step testing guide
- **[Docker Scale Testing Guide](docs/docker-scale-testing.md)** - Advanced testing reference

For issues with the open-source node software, please open an issue in this repository.

For commercial SDK support, please contact our commercial support team.