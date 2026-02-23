# REPRAM v2: Ephemeral Coordination Layer for the Agent Web

## Vision

REPRAM becomes the missing infrastructure primitive for autonomous AI agents: a zero-trust, self-expiring, distributed scratchpad that any agent can write to and read from without registration, authentication, or permanent data trails.

One command to run a node. One MCP tool definition to give an agent access. Everything else is emergent.

---

## What Stays

The existing codebase has good bones. These components survive largely intact:

- **`internal/storage/memory.go`** — The MemoryStore with TTL enforcement, cleanup workers, and stats. Clean, correct, no changes needed.
- **`internal/cluster/node.go`** — ClusterNode with quorum writes, gossip message handling, and pending write tracking. The core Put/Get/Scan flow is solid.
- **`internal/gossip/protocol.go`** — The gossip Protocol with peer management, health checks, topology sync, and transport abstraction. This is the nervous system and it works.
- **`internal/gossip/simple_transport.go` / `http_transport.go`** — HTTP-based gossip transport. Pragmatic choice that avoids gRPC complexity while still working across NATs and firewalls.
- **`internal/node/middleware.go`** — Rate limiting, security headers, request size limits. Production-hardened and reusable.
- **Core principles** — Zero-knowledge nodes, client-side encryption, mandatory TTL, permissionless reads, symmetric architecture. All of these are *more* relevant in the agent context, not less.

## What Changes

### 1. Single Unified Binary

**Current state:** Three separate binaries (`repram-node`, `repram-cluster-node`, plus the SDK example). The `cmd/node` is a standalone non-clustering node. The `cmd/cluster-node` is the real thing but has a separate code path.

**Target state:** One binary. One Docker image. One `CMD`. The cluster-node *is* the node. The standalone mode is just a cluster of one (quorum=1, no bootstrap peers). This eliminates confusion about which binary to run.

```
cmd/
  repram/           # Single entry point
    main.go         # Unified node: cluster-capable, defaults to public network
```

The current `cmd/cluster-node/main.go` becomes the basis. The `cmd/node` standalone server gets folded in as the "no peers" degenerate case.

### 2. Default-Join-Public Bootstrap

**Current state:** Bootstrap requires explicit `BOOTSTRAP_NODES` or `REPRAM_BOOTSTRAP_PEERS` env vars. No default. New users must configure peers manually.

**Target state:** The default behavior is to join the public REPRAM network. Zero configuration required.

```
# Join the public network (default)
docker run repram/node

# Run a private network (opt-in)
docker run -e REPRAM_NETWORK=private repram/node

# Run a private network with specific peers
docker run -e REPRAM_NETWORK=private -e REPRAM_PEERS=10.0.0.2:9090,10.0.0.3:9090 repram/node
```

**Bootstrap resolution order:**
1. If `REPRAM_NETWORK=private` → no public bootstrap, use only `REPRAM_PEERS` if provided
2. If `REPRAM_PEERS` is set → use those as bootstrap peers (can combine with public)
3. Default → resolve `bootstrap.repram.network` via DNS, use returned addresses as seeds

The DNS approach is the simplest thing that works. A single A/AAAA record (or SRV for port flexibility) pointing at 2-3 stable root nodes. No service discovery infrastructure, no registries. Update the DNS record to rotate roots. The existing `internal/gossip/bootstrap.go` already handles the HTTP-based bootstrap handshake — we just need to feed it addresses from DNS resolution instead of env vars.

**Startup sequence:**
```
1. Generate node ID (random UUID, no persistence needed)
2. Resolve bootstrap addresses (DNS or env var)
3. Start gossip transport (listen on 9090)
4. Start HTTP API (listen on 8080)
5. Bootstrap from seed nodes (exchange peer lists)
6. Begin gossip protocol (health checks, topology sync, data replication)
7. Log: "REPRAM node online. Peers: N. Network: public"
```

### 3. Simplified Discovery

**Current state:** The docs describe an elaborate tree discovery protocol (root/trunk/branch/leaf hierarchy) with latency-based clustering, migration hysteresis, and capacity management. The actual implementation uses simpler HTTP-based bootstrap with peer list exchange.

**Target state:** Keep the simple approach. The tree discovery design is interesting but premature for the current scale. The existing bootstrap + periodic topology sync is sufficient for hundreds of nodes.

For v2, discovery is:
- Bootstrap from known seeds (DNS or configured)
- Exchange peer lists during bootstrap handshake  
- Periodic topology sync broadcasts (existing 30s interval)
- Health check pings to detect dead peers (existing 30s interval)

The tree protocol document moves to `docs/future/` as a scaling roadmap item.

### 4. Streamlined API Surface

**Current state:** Multiple endpoint patterns (`/data/{key}`, `/cluster/put/{key}`, `/cluster/get/{key}`, `/raw/put`, `/raw/get/{key}`). The cluster endpoints duplicate the data endpoints. The raw endpoints are an artifact of the open-source/proprietary split.

**Target state:** One set of endpoints. Clean, RESTful, obvious.

```
PUT  /v1/data/{key}          # Store data (body = raw bytes, X-TTL header or ?ttl= param)
GET  /v1/data/{key}          # Retrieve data (returns bytes + TTL metadata headers)
GET  /v1/keys                # List all non-expired keys (replaces /scan)
GET  /v1/health              # Health + peer count + network info
GET  /v1/status              # Detailed status (memory, goroutines, uptime)
GET  /v1/metrics             # Prometheus metrics
POST /v1/gossip/message      # Internal: gossip message exchange
POST /v1/bootstrap           # Internal: bootstrap handshake
```

Key changes from current:
- Version prefix (`/v1/`) for future compatibility
- `PUT /v1/data/{key}` accepts raw bytes in body (not JSON-wrapped). TTL comes from header or query param, not body. This makes curl usage trivial: `curl -X PUT -H "X-TTL: 300" -d "my data" http://localhost:8080/v1/data/mykey`
- `GET /v1/data/{key}` returns raw bytes. Metadata in response headers (`X-Remaining-TTL`, `X-Created-At`). The current cluster-node already does this well.
- Remove `/raw/*` endpoints entirely. All data is opaque bytes. Encryption is always the client's concern.
- Remove duplicate `/cluster/*` endpoints.

### 5. Docker Image Overhaul

**Current state:** Multi-stage Dockerfile builds both node and cluster-node binaries. Default CMD runs the standalone node (the wrong one).

**Target state:** Single binary, minimal image, sane defaults.

```dockerfile
FROM golang:1.22-alpine AS builder
RUN apk add --no-cache git ca-certificates
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o repram ./cmd/repram

FROM alpine:latest
RUN apk --no-cache add ca-certificates tzdata
RUN adduser -D -s /bin/sh repram
WORKDIR /app
COPY --from=builder /app/repram .
RUN chown -R repram:repram /app
USER repram
EXPOSE 8080 9090
CMD ["./repram"]
```

Published as `repram/node:latest` on Docker Hub. The experience:

```bash
# That's it. You're part of the network.
docker run -p 8080:8080 -p 9090:9090 repram/node
```

### 6. Configuration Simplification

**Current state:** Multiple env var names for the same thing (`REPRAM_PORT`/`HTTP_PORT`, `REPRAM_GOSSIP_PORT`/`NODE_PORT`, `REPRAM_BOOTSTRAP_PEERS`/`BOOTSTRAP_NODES`). Backwards compatibility cruft.

**Target state:** One name per config. Document it clearly. No aliases.

| Variable | Default | Description |
|----------|---------|-------------|
| `REPRAM_HTTP_PORT` | `8080` | HTTP API port |
| `REPRAM_GOSSIP_PORT` | `9090` | Gossip protocol port |
| `REPRAM_NETWORK` | `public` | `public` or `private` |
| `REPRAM_PEERS` | (empty) | Comma-separated peer addresses (host:gossipPort) |
| `REPRAM_REPLICATION` | `3` | Replication factor |
| `REPRAM_MIN_TTL` | `300` | Minimum TTL in seconds (5 min default) |
| `REPRAM_MAX_TTL` | `86400` | Maximum TTL in seconds (24 hour default) |
| `REPRAM_LOG_LEVEL` | `info` | Log verbosity |
| `REPRAM_RATE_LIMIT` | `100` | Requests/sec per IP |

---

## The MCP Layer

### Design Philosophy

The MCP server is a *separate process* that wraps the REPRAM HTTP API. It doesn't embed the node — it talks to one. This means:

- An agent can use a remote REPRAM network without running a local node
- The MCP server can point at `localhost:8080` if you're running a local node
- Multiple agents can share one MCP server instance
- The MCP server is stateless — all state lives in the REPRAM network

### MCP Server: `repram-mcp`

A lightweight TypeScript or Python MCP server exposing three tools. The tool descriptions are critical — they teach the agent the protocol semantics.

```
repram-mcp/
  src/
    index.ts          # MCP server entry point
    tools.ts          # Tool definitions
    client.ts         # REPRAM HTTP client
  package.json
  Dockerfile
```

### Tool Definitions

#### `repram_store`

```json
{
  "name": "repram_store",
  "description": "Store ephemeral data on the REPRAM distributed network. Data is replicated across multiple nodes and automatically deleted after the TTL expires. Use this for temporary coordination data, handoff payloads between agents, session tokens, intermediate results, or any data that should not persist permanently. The key is your access handle — anyone with the key can read the data, so use unique/random keys for privacy. For sensitive data, encrypt before storing. Returns the key and expiration time.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "key": {
        "type": "string",
        "description": "Storage key. Use descriptive prefixes for organization (e.g., 'agent:task123:result', 'handoff:session-abc'). If omitted, a random UUID key is generated."
      },
      "data": {
        "type": "string",
        "description": "The data to store. Can be any string — plain text, JSON, base64-encoded binary, etc."
      },
      "ttl_seconds": {
        "type": "integer",
        "description": "Time-to-live in seconds. Data is permanently deleted after this duration. Minimum 300 (5 minutes), maximum 86400 (24 hours). Default: 3600 (1 hour).",
        "default": 3600
      }
    },
    "required": ["data"]
  }
}
```

#### `repram_retrieve`

```json
{
  "name": "repram_retrieve",
  "description": "Retrieve ephemeral data from the REPRAM network by key. Returns the stored data along with TTL metadata (when it was created, how much time remains). Returns null if the key doesn't exist or has expired — expired data is permanently gone and cannot be recovered. This is by design.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "key": {
        "type": "string",
        "description": "The key to retrieve data for."
      }
    },
    "required": ["key"]
  }
}
```

#### `repram_list_keys`

```json
{
  "name": "repram_list_keys",
  "description": "List all non-expired keys currently stored on the connected REPRAM node. Useful for discovering what data is available or checking if a specific key prefix has entries. Note: this returns keys visible to the local node — in a distributed network, recently-written keys may take a few seconds to propagate. Keys are opaque strings; the data they point to may be encrypted.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "prefix": {
        "type": "string",
        "description": "Optional prefix filter. Only return keys starting with this string."
      }
    }
  }
}
```

### MCP Server Configuration

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

Or with Docker:
```json
{
  "mcpServers": {
    "repram": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "--network=host", "repram/mcp"],
      "env": {
        "REPRAM_URL": "http://localhost:8080"
      }
    }
  }
}
```

### Agent Usage Patterns

The tool descriptions are designed so that an agent naturally understands the coordination patterns:

**Dead Drop (agent-to-agent handoff):**
```
Agent A: repram_store(key="handoff:job-42:result", data="{...}", ttl=600)
Agent A: [passes key to Agent B via shared context or orchestrator]
Agent B: repram_retrieve(key="handoff:job-42:result")
```

**Ephemeral Scratchpad (multi-step reasoning):**
```
Agent: repram_store(key="scratch:research:step1", data="...", ttl=1800)
Agent: repram_store(key="scratch:research:step2", data="...", ttl=1800)
Agent: repram_list_keys(prefix="scratch:research:")
Agent: repram_retrieve(key="scratch:research:step1")
```

**Coordination Token:**
```
Agent A: repram_store(key="lock:resource-x", data="claimed-by-agent-a", ttl=300)
Agent B: repram_retrieve(key="lock:resource-x") → "claimed-by-agent-a" → back off
```

---

## Migration Path

This is not a rewrite. It's a reshaping. Here's the sequence:

### Phase 1: Unify the Binary
1. Merge `cmd/node` and `cmd/cluster-node` into `cmd/repram`
2. ClusterNode with replication=1, quorum=1 replaces standalone node
3. Remove `cmd/node`, `cmd/example`
4. Simplify env var names (drop aliases)
5. Update Dockerfile to single binary

### Phase 2: Default-Public Bootstrap
1. Add DNS-based bootstrap resolution to `internal/gossip/bootstrap.go`
2. Set up `bootstrap.repram.network` DNS record pointing at 2-3 stable nodes
3. Wire default bootstrap into the unified binary
4. Add `REPRAM_NETWORK=private` escape hatch
5. Deploy 2-3 root nodes (your homelab k8s cluster is perfect for initial roots)

### Phase 3: API Cleanup
1. Add `/v1/` prefix to all endpoints
2. Change PUT to accept raw bytes (remove JSON wrapper)
3. Remove duplicate `/cluster/*` and `/raw/*` routes
4. Add max TTL enforcement
5. Add optional key prefix filtering to scan/list

### Phase 4: MCP Server
1. Build `repram-mcp` as a standalone npm package
2. Three tools: store, retrieve, list_keys
3. Publish to npm for `npx repram-mcp` usage
4. Publish Docker image for container-based MCP
5. Test with Claude Code and Wieland

### Phase 5: Polish & Publish
1. Push `repram/node:latest` to Docker Hub
2. Update README for the new "one command" experience  
3. Update website (repram.vercel.app) with agent-focused messaging
4. Write a "REPRAM for AI Agents" guide
5. Move tree discovery docs to `docs/future/`

---

## What Gets Cut

- **`cmd/node/`** — Standalone non-cluster node. Replaced by cluster node with replication=1.
- **`cmd/example/`** — SDK usage example. Replaced by MCP server as the canonical client.
- **`repram-sdk/`** — The Go SDK with proprietary encryption. The MCP server becomes the primary client interface. The Go SDK can live on as a library but it's no longer the main story.
- **`web/fade/`** — The FADE demo. Cool proof-of-concept but not relevant to the agent positioning. Archive it.
- **`demos/`** — Synth-tree and FADE demos. Archive.
- **`deployment/discord-bridge/`** — Discord bot integration. Archive.
- **`deployment/gcp/`** — GCP-specific deployment scripts. Replace with generic Docker instructions.
- **`internal/discovery/`** — Port auto-discovery. Unnecessary with the simplified bootstrap.
- **Dual env var names** — Pick one name per config, drop all aliases.
- **The proprietary/open-source split narrative** — Everything is open source. The encryption story is "encrypt before you store, the network doesn't care."

---

## Open Questions

1. **NAT traversal** — The gossip protocol uses direct HTTP connections between nodes. This works within Docker networks and on servers with public IPs, but won't work for nodes behind residential NATs without port forwarding. Is this acceptable for v2, or do we need relay nodes / TURN-like infrastructure? (Recommendation: accept the limitation for v2, document that nodes need reachable gossip ports.)

2. **Key namespacing** — Should the network enforce any key structure, or is it purely convention? The MCP tool descriptions suggest prefix conventions (`agent:`, `handoff:`, `scratch:`) but the network treats all keys as opaque strings. (Recommendation: convention only, no enforcement.)

3. **Encryption story** — The current SDK does client-side AES-256-GCM. In the MCP world, agents would need to handle their own encryption. Should `repram-mcp` offer optional built-in encryption (generate a key, encrypt before storing, return the decryption key alongside the storage key)? Or keep it pure and let agents manage crypto? (Recommendation: offer it as an opt-in convenience in the MCP server, not in the network.)

4. **Public network governance** — Who runs the root nodes? What prevents abuse (someone flooding the network with max-TTL garbage)? The rate limiting helps per-IP, but a determined actor could use many IPs. (Recommendation: rate limiting + max TTL cap + optional proof-of-work for large payloads. Tackle this after the network has real usage.)

5. **Monitoring the public network** — Should there be a public dashboard showing network health, node count, data volume? (Recommendation: yes, build it, it's good marketing and it demonstrates the network is alive.)
