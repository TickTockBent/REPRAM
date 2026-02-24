# REPRAM

**Ephemeral Coordination Layer for the Agent Web**

Zero-trust, self-expiring, distributed scratchpad for AI agents. Store temporary data, coordinate across agents, and let it disappear automatically.

## Quick Start

Run a node:

```bash
docker run -p 8080:8080 -p 9090:9090 repram/node
```

Give an agent access (MCP config for Claude Code, Cursor, etc.):

```json
{
  "mcpServers": {
    "repram": {
      "command": "npx",
      "args": ["repram-mcp"],
      "env": {
        "REPRAM_URL": "http://localhost:8080"
      }
    }
  }
}
```

Store data manually:

```bash
curl -X PUT -H "X-TTL: 300" -d "hello" http://localhost:8080/v1/data/mykey
```

Retrieve it:

```bash
curl http://localhost:8080/v1/data/mykey
```

## Private Network

To run a local cluster for testing before joining the public network:

```bash
# Set REPRAM_NETWORK=private to disable DNS-based peer discovery
docker run -p 8080:8080 -p 9090:9090 -e REPRAM_NETWORK=private repram/node
```

Or spin up a 3-node cluster with docker compose:

```bash
docker compose up --build
# Nodes available at localhost:8081, :8082, :8083
```

The included `docker-compose.yml` configures three nodes with gossip replication in a private network — useful for development and integration testing.

## How It Works

REPRAM is an ephemeral key-value store with gossip-based replication across nodes.

- **Mandatory TTL**: Every piece of data has a time-to-live. When it expires, it's gone — no recovery, no traces.
- **Gossip replication**: Writes propagate to peer nodes via gossip protocol with quorum confirmation.
- **Zero-knowledge nodes**: Nodes store opaque data. They don't interpret, index, or log what you store.
- **No accounts, no auth**: Store with a PUT, retrieve with a GET. Access is controlled by key knowledge.

## Agent Usage Patterns

**Dead drop** — Agent A stores a payload with a known key. Agent B retrieves it later using that key. The data self-destructs after TTL.

**Scratchpad** — An agent stores intermediate reasoning state across multi-step workflows, retrieving and updating as it progresses.

**Coordination token** — Multiple agents use a shared key as a lightweight lock or signal. Presence of the key means "in progress"; expiration means "available."

## API Reference

### Store data

```bash
curl -X PUT -H "X-TTL: 300" -d "your data here" http://localhost:8080/v1/data/{key}
# Returns: 201 Created
```

The `X-TTL` header sets expiration in seconds. TTL can also be passed as a `?ttl=300` query parameter.

### Retrieve data

```bash
curl http://localhost:8080/v1/data/{key}
# Returns: 200 with data body, or 404 if expired/missing
# Response headers: X-Created-At, X-Original-TTL, X-Remaining-TTL
```

### List keys

```bash
curl http://localhost:8080/v1/keys
curl http://localhost:8080/v1/keys?prefix=myapp/
# Returns: {"keys": ["key1", "key2", ...]}
```

### Health check

```bash
curl http://localhost:8080/v1/health
# Returns: {"status": "healthy", "node_id": "...", "network": "..."}
```

### Status

```bash
curl http://localhost:8080/v1/status
# Returns: detailed node status with uptime, memory, goroutines
```

### Metrics

```bash
curl http://localhost:8080/v1/metrics
# Returns: Prometheus-format metrics
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `REPRAM_HTTP_PORT` | `8080` | HTTP API port |
| `REPRAM_GOSSIP_PORT` | `9090` | Gossip protocol port |
| `REPRAM_ADDRESS` | `localhost` | Advertised address for this node |
| `REPRAM_NETWORK` | `public` | `public` for DNS bootstrap, `private` for manual peers only |
| `REPRAM_PEERS` | _(empty)_ | Comma-separated bootstrap peers (`host:httpPort`) |
| `REPRAM_REPLICATION` | `3` | Quorum replication factor |
| `REPRAM_MIN_TTL` | `300` | Minimum TTL in seconds (5 minutes) |
| `REPRAM_MAX_TTL` | `86400` | Maximum TTL in seconds (24 hours) |
| `REPRAM_RATE_LIMIT` | `100` | Requests per second per IP |

## Building from Source

```bash
make build          # Build the binary to bin/repram
make test           # Run tests
make docker-build   # Build Docker image (repram/node:latest)
```

## Documentation

- [Core Principles](docs/core-principles.md) — Inviolable design constraints
- [Project Overview](docs/project-overview.md) — Architecture and rationale
- [Whitepaper](docs/whitepaper.md) — Technical deep dive

## License

MIT. See [LICENSE](LICENSE) for details.
