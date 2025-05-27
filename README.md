# REPRAM

**REplicated EPhemeral RAM** - A distributed, ephemeral key-value storage network designed for high-performance, privacy-preserving applications. It provides a permissionless interface for encrypted, self-expiring data storage with zero trust assumptions.

## 🚀 Key Features

- **Encrypted Storage**: Client-side encryption ensures zero knowledge by the network
- **Ephemeral Data**: Time-to-live (TTL) enforced automatic data expiration
- **Distributed Architecture**: Symmetric node architecture with no central coordinator
- **Zero Trust**: Nodes cannot read or interpret user data
- **Dual Licensing**: Open-source node software with proprietary encryption SDK

## 🏗 Architecture

REPRAM consists of two main components:

### Open Source Node
- Stores arbitrary binary data with TTL expiration
- REST API for data storage and retrieval
- In-memory storage with automatic cleanup
- Can be deployed by anyone to join the network

### Proprietary SDK
- Client-side AES-256-GCM encryption
- Key generation and management
- Transparent encryption/decryption
- Available under commercial license

## 🛠 Quick Start

### Prerequisites
- Go 1.21+
- Make

### Building

```bash
# Clone the repository
git clone <repository-url>
cd REPRAM

# Build the open-source node
make build-raw

# Build the proprietary SDK example (requires SDK access)
make build-sdk-example
```

### Running the Open Source Node

```bash
# Start the node
make run-raw

# The node will start on port 8080 with endpoints:
# POST /raw/put - Store unencrypted data
# GET /raw/get/{key} - Retrieve unencrypted data
# PUT /data/{key} - Store binary data (for SDK use)
# GET /data/{key} - Retrieve binary data (for SDK use)
```

### Testing with Raw Data

```bash
# Store some data
curl -X POST http://localhost:8080/raw/put \
  -H "Content-Type: application/json" \
  -d '{"data":"Hello REPRAM!","ttl":60}'

# Response: {"key":"raw-1234567890"}

# Retrieve the data
curl http://localhost:8080/raw/get/raw-1234567890
# Response: {"data":"Hello REPRAM!"}
```

## 📋 Available Commands

```bash
# Building
make build              # Main encrypted node
make build-raw          # Open-source unencrypted node  
make build-sdk-example  # Proprietary SDK example

# Running
make run               # Start main node (port 8080)
make run-raw          # Start open-source node

# Testing & Demos
make test             # Run all tests
make demo-opensource  # Curl-based demo of raw node
make demo-sdk        # End-to-end encrypted SDK demo

# Cleanup
make clean           # Remove all built binaries
```

## 🔧 Development

### Project Structure

```
REPRAM/
├── cmd/
│   ├── node/           # Main encrypted node
│   ├── node-raw/       # Open-source node
│   └── example/        # Example client
├── internal/
│   ├── node/           # HTTP server implementation
│   ├── storage/        # Storage backends
│   └── crypto/         # Encryption utilities
├── pkg/
│   └── client/         # Client library
├── repram-sdk/         # Proprietary SDK (separate module)
└── docs/              # Documentation
```

### API Endpoints

**Standard Endpoints** (all nodes):
- `PUT /data/{key}` - Store binary data with TTL
- `GET /data/{key}` - Retrieve binary data
- `GET /health` - Health check

**Open Source Endpoints** (raw node only):
- `POST /raw/put` - Store unencrypted string data
- `GET /raw/get/{key}` - Retrieve unencrypted string data

## 🗺 Roadmap

### ✅ Phase 1: MVP Core (Completed)
- Single-node ephemeral storage
- Client-side encryption
- Open-source/proprietary separation
- REST API implementation

### 🚧 Phase 2: Distributed Network (Planned)
- Gossip-based data replication
- Peer discovery and bootstrap
- Multi-node consensus
- Network health monitoring

### 📋 Phase 3: Production Ready (Planned)
- Container deployment (Docker/Kubernetes)
- Advanced monitoring and metrics
- Security hardening
- Performance optimization

### 🔮 Phase 4: Extensions (Future)
- Long-term storage integration
- IPFS blob offloading
- Reputation scoring
- Web3 authentication bridges

## 🤝 Use Cases

- Temporary form submission data
- Anonymous session coordination
- Secure self-expiring messages
- Short-lived tokens and access receipts
- Ephemeral game state or caches

## 📄 License

The REPRAM node software is open source under the MIT License. The REPRAM SDK and encryption components are proprietary and available under commercial license.

See [LICENSE](LICENSE) for details.

## 🏢 Commercial SDK

For access to the proprietary REPRAM SDK with encryption capabilities, please contact us for licensing information.

## 📞 Support

For issues with the open-source node software, please open an issue in this repository.

For commercial SDK support, please contact our commercial support team.

---

**Note**: This is early-stage software. Use in production at your own risk.