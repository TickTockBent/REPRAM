# REPRAM

[![CI](https://github.com/TickTockBent/REPRAM/actions/workflows/test.yml/badge.svg)](https://github.com/TickTockBent/REPRAM/actions/workflows/test.yml)
[![Docker](https://github.com/TickTockBent/REPRAM/actions/workflows/docker-build.yml/badge.svg)](https://github.com/TickTockBent/REPRAM/actions/workflows/docker-build.yml)
[![Docker Image](https://img.shields.io/docker/v/ticktockbent/repram-node?label=docker)](https://hub.docker.com/r/ticktockbent/repram-node)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**Ephemeral Coordination Layer for the Agent Web**

REPRAM is a distributed network where data self-destructs on a timer. Agents leave data, other agents pick it up, and the network cleans itself. Nobody signs a guest book.

Think of it as a dead drop network: you store a payload under a key with a time-to-live, and anyone who knows the key can retrieve it — until the TTL expires and every node deletes its copy. There is no recovery mechanism. No accounts. No authentication. The network doesn't know or care what you stored.

**REPRAM is not a database.** It's not a message queue. It's not a secrets manager. It will not keep your data safe — it will *destroy* your data, on schedule, and that's the entire point. Privacy through transience: the network is safe to use because it forgets everything.

## Quick Start

Run a node:

```bash
docker run -p 8080:8080 -p 9090:9090 ticktockbent/repram-node
```

Give an agent access (MCP config for Claude Code, Cursor, etc.):

```json
{
  "mcpServers": {
    "repram": {
      "command": "repram",
      "args": ["--mcp"]
    }
  }
}
```

That's it — `repram --mcp` runs the Go binary as an MCP stdio server with an embedded REPRAM node (private, in-memory, 50MB cap). No npm, no Node.js, ~13MB static binary. The agent gets `repram_store`, `repram_retrieve`, `repram_exists`, and `repram_list_keys` tools immediately.

To join an existing cluster, set `"env": { "REPRAM_PEERS": "host:8080" }` in the MCP config — the embedded node will gossip with that cluster while still serving tools over stdio.

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
docker run -p 8080:8080 -p 9090:9090 -e REPRAM_NETWORK=private ticktockbent/repram-node
```

Or spin up a 3-node cluster with docker compose:

```bash
docker compose up --build
# Nodes available at localhost:8091, :8092, :8093
```

The included `docker-compose.yml` configures three nodes with gossip replication in a private network — useful for development and integration testing.

## How It Works

REPRAM is a network of identical nodes that store key-value pairs in memory and replicate them via gossip protocol. The reference implementation is a single Go binary (`cmd/repram/`) that runs either as a long-lived HTTP node or, with `--mcp`, as an embedded MCP stdio server for agent use.

- **Mandatory TTL**: Every piece of data has a time-to-live. When it expires, every node deletes its copy. There is no recovery mechanism.
- **Gossip replication**: Writes propagate to reachable enclave peers via gossip protocol with dynamic quorum confirmation. Small enclaves use full broadcast; larger enclaves switch to probabilistic √N fanout with epidemic forwarding.
- **Content-agnostic nodes**: Nodes store opaque bytes. They don't interpret or index what you store — no schema, no query language. A node necessarily holds the bytes it stores and can read them; it attaches no meaning to them. If the bytes need to stay secret, encrypt them before they arrive.
- **No client accounts or auth**: Store with a PUT, retrieve with a GET. Access is controlled by knowing the key. Cluster operators may optionally authenticate peer-to-peer gossip with a shared HMAC secret; this does not add client identity or access control.
- **Loosely coupled**: Nodes don't need to be tightly synchronized. A node that goes offline for an hour and comes back has simply missed data that may have already expired. There's no catch-up problem — expired data doesn't need to be synced, and current data arrives via normal gossip.

## What REPRAM Is Not

| If you need... | Use... | Not REPRAM |
|----------------|--------|------------|
| Persistent storage | A database | Data here is guaranteed to disappear |
| Reliable message delivery | A message queue | REPRAM is "leave it and hope they check" |
| Secret management | A vault | REPRAM has no access control or encryption |
| A cache with eviction policies | Redis / Memcached | REPRAM only evicts on TTL, never on memory pressure |

REPRAM occupies a different niche: **temporary, replicated, self-cleaning storage for data that should not exist longer than it's needed.**

## Agent Usage Patterns

**Dead drop** — The core pattern. Agent A stores a payload with a known key. Agent B retrieves it later using that key. The data self-destructs after TTL. For rendezvous between agents that don't know each other's endpoints, derive the key from shared context (e.g., `hash(task_id + agent_pair)`) so both parties can compute it independently.

**Scratchpad** — An agent stores intermediate reasoning state across multi-step workflows, retrieving and updating as it progresses.

**Coordination token** — Multiple agents use a shared key as a lightweight lock or signal. Presence of the key means "in progress"; expiration means "available."

**Heartbeat / presence** — An agent writes a key on a recurring interval with a short TTL. The key's existence is the liveness signal. If the writer stops writing, the key expires — and the absence *is* the failure notification. No health check infrastructure, no polling, no failure detector. The TTL is the failure detector.

**State machine** — A job ID key whose value transitions through states via overwrites (`queued` → `in_progress` → `complete`). The TTL acts as a staleness guarantee: if a job writes `in_progress` with a 10-minute TTL and then crashes, the key expires and any agent polling it knows the job didn't complete. Overwrites reset the TTL, so each state transition refreshes the window.

REPRAM is `pipe`, not `grep` — the primitive is general-purpose. See [Usage Patterns](docs/patterns.md) for more examples including circuit breakers, ephemeral broadcast, secure relay, session continuity, and key naming conventions for agent interoperability.

## API Reference

### Store data

```bash
curl -X PUT -H "X-TTL: 300" -d "your data here" http://localhost:8080/v1/data/{key}
# Returns: 201 Created (quorum confirmed) or 202 Accepted (stored locally, replication pending)
```

The `X-TTL` header sets expiration in seconds. TTL can also be passed as a `?ttl=300` query parameter. If TTL is omitted, it defaults to 1800 seconds (30 minutes). Explicit positive values below 300 seconds are accepted and normalized to 300 seconds.

`201 Created` means the value was stored locally and the node observed its dynamic quorum within the write timeout. `202 Accepted` means the value was stored locally but quorum was not confirmed before the timeout. It does not promise that any particular remote replica has accepted the value.

### Retrieve data

```bash
curl http://localhost:8080/v1/data/{key}
# Returns: 200 with data body, or 404 if expired/missing
# Response headers: X-Created-At, X-Original-TTL, X-Remaining-TTL
```

### Check existence (HEAD)

```bash
curl -I http://localhost:8080/v1/data/{key}
# Returns: 200 with TTL headers (no body), or 404 if expired/missing
# Use for lightweight existence checks, coordination tokens, heartbeat polling
```

### List keys

```bash
curl http://localhost:8080/v1/keys
curl http://localhost:8080/v1/keys?prefix=myapp/
curl "http://localhost:8080/v1/keys?limit=10"
curl "http://localhost:8080/v1/keys?limit=10&cursor=last-key-from-previous-page"
# Returns: {"keys": ["key1", "key2", ...]}
# With pagination: {"keys": [...], "next_cursor": "key10"}
```

Keys are returned in lexicographic order. Use `?limit=N` to cap the page size and `?cursor=X` to continue from the previous page (the cursor is the last key from the previous response). When more pages are available, the response includes a `next_cursor` field. No limit returns all keys (backwards compatible).

Note: Expired keys never appear in listings or reads — both check the TTL at access time, so expiry is precise per node. The background sweep (every 30s) only reclaims the memory of already-invisible entries.

### Health check

```bash
curl http://localhost:8080/v1/health
# Returns: {"status": "healthy", "node_id": "...", "network": "..."}
```

### Status

```bash
curl http://localhost:8080/v1/status
# Returns: detailed node status with uptime and memory usage
```

### Topology

```bash
curl http://localhost:8080/v1/topology
# Returns: peer list with enclave membership and health status
```

### Metrics

```bash
curl http://localhost:8080/v1/metrics
# Returns: Prometheus-format metrics
```

### CORS

REPRAM accepts requests from any origin. This is intentional — REPRAM is permissionless by design, with no authentication or access control, so restricting CORS origins would add complexity without meaningful security benefit. Any client that can reach the node's HTTP port can already read and write data regardless of browser origin policy. If you need to restrict browser-based access, place REPRAM behind a reverse proxy with CORS rules.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `REPRAM_HTTP_PORT` | `8080` | HTTP API port |
| `REPRAM_GOSSIP_PORT` | `9090` | Legacy compatibility metadata. Current gossip uses the HTTP port (`/v1/gossip/message`); no separate listener binds this port. |
| `REPRAM_NODE_ID` | generated | Optional stable node identifier; otherwise generated at startup |
| `REPRAM_ADDRESS` | `localhost` | Advertised address for this node |
| `REPRAM_NETWORK` | `public` | `public` for DNS bootstrap, `private` for manual peers only |
| `REPRAM_PEERS` | _(empty)_ | Comma-separated bootstrap peers (`host:httpPort`) |
| `REPRAM_ENCLAVE` | `default` | Enclave name. Nodes in the same enclave replicate data to each other. Nodes in different enclaves share topology but not data. |
| `REPRAM_REPLICATION` | `3` | Quorum replication factor |
| `REPRAM_MIN_TTL` | `300` | Local TTL floor in seconds. Values below the protocol minimum of 300 are treated as 300; operators may configure a stricter floor. |
| `REPRAM_MAX_TTL` | `86400` | Maximum TTL in seconds (24 hours) |
| `REPRAM_WRITE_TIMEOUT` | `5` | Quorum confirmation timeout in seconds. A timeout returns 202: stored locally, quorum not confirmed. |
| `REPRAM_CLUSTER_SECRET` | _(empty)_ | Optional shared secret for peer-to-peer gossip HMAC-SHA256 authentication. It does not authenticate client reads or writes. If empty, gossip is open. |
| `REPRAM_RATE_LIMIT` | `100` | Requests per second per IP. When behind a reverse proxy, set `REPRAM_TRUST_PROXY=true` so the rate limiter uses `X-Forwarded-For` / `X-Real-IP` headers. When exposed directly, leave it `false` to prevent header spoofing. |
| `REPRAM_TRUST_PROXY` | `false` | Trust `X-Forwarded-For` and `X-Real-IP` headers for client IP detection. Set to `true` when running behind a reverse proxy (nginx, Cloudflare, etc.). |
| `REPRAM_LOG_LEVEL` | `info` | Log verbosity: `debug`, `info`, `warn`, `error` |
| `REPRAM_MAX_STORAGE_MB` | `0` | Max data storage in MB (0 = unlimited). Rejects writes with 507 when full. Tracks payload bytes only — actual memory usage is higher due to per-entry overhead (~80 bytes + key length per entry). For workloads with many small values, set conservatively. |
| `REPRAM_INBOUND` | `false` | `true` accepts inbound WebSocket attachments as a substrate; `false` operates as a transient and attaches outbound when seeds are available |
| `REPRAM_MAX_CHILDREN` | `100` | Maximum transient WebSocket children accepted by a substrate; `0` disables attachments |
| `REPRAM_CACHE_DIR` | platform default | Directory for the verified omega root-list cache |
| `REPRAM_PPROF_ENABLED` | `false` | Enable pprof/profiling diagnostic endpoints on a separate listener (`REPRAM_PPROF_ADDR`). Do not expose in untrusted environments. |
| `REPRAM_PPROF_ADDR` | `127.0.0.1:6060` | Address for the pprof listener (only used when `REPRAM_PPROF_ENABLED=true`). Loopback-only by default — set to `0.0.0.0:6060` to allow external access. |

## Building from Source

```bash
make build          # Build Go binary to bin/repram
make test           # Run Go tests
make docker-build   # Build Docker image (ticktockbent/repram-node:latest)

# Run as an MCP stdio server (embedded node, no HTTP exposure required):
./bin/repram --mcp
```

## Documentation

- [Usage Patterns](docs/patterns.md) — Agent patterns, general-purpose primitives, and key naming conventions
- [Client-Side Encryption](docs/encryption-example.md) — AES-256-GCM example with opaque key derivation
- [Core Principles](docs/core-principles.md) — Inviolable design constraints
- [Project Overview](docs/project-overview.md) — Architecture and rationale
- [Whitepaper](docs/whitepaper.md) — Technical deep dive
- [Changelog](CHANGELOG.md) — What changed and when

## License

MIT. See [LICENSE](LICENSE) for details.
---

*Part of a growing suite of literary-named MCP servers. See more at [github.com/TickTockBent](https://github.com/TickTockBent).*
