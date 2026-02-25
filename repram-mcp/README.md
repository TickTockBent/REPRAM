# repram-mcp

Unified [REPRAM](https://github.com/ticktockbent/REPRAM) node + MCP server. A single `npx repram-mcp` gives AI agents an embedded ephemeral coordination node with store/retrieve/list tools — no separate server process needed.

## Modes

| Mode | How | What it does |
|------|-----|-------------|
| **MCP (default)** | `npx repram-mcp` | Embedded REPRAM node + MCP stdio transport |
| **MCP + external** | `REPRAM_URL=... npx repram-mcp` | Connects to existing node via HTTP |
| **Standalone** | `npx repram-mcp --standalone` | HTTP server only, no MCP (replaces Go binary) |

## Tools

| Tool | Description |
|------|-------------|
| `repram_store` | Store data with automatic expiration (TTL). Returns a key for retrieval. |
| `repram_retrieve` | Retrieve data by key. Returns null if expired or missing. |
| `repram_exists` | Check if a key exists without retrieving the value. Returns remaining TTL. |
| `repram_list_keys` | List stored keys, optionally filtered by prefix. |

## Quick Start

### Claude Code

Add to your MCP settings (`.claude/settings.json` or project-level):

```json
{
  "mcpServers": {
    "repram": {
      "command": "npx",
      "args": ["repram-mcp"]
    }
  }
}
```

That's it — no separate server needed. The embedded node starts automatically with conservative defaults (ephemeral port, 50MB storage cap, warn-level logging).

### Connect to an existing node

If you're running a REPRAM cluster and want the MCP server to use it instead of the embedded node:

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

### Standalone server (no MCP)

Run a full REPRAM node as an HTTP server without MCP transport:

```bash
npx repram-mcp --standalone
# or
REPRAM_MODE=standalone npx repram-mcp
```

## Configuration

All settings via `REPRAM_*` environment variables. Defaults differ between embedded (MCP) and standalone modes:

| Variable | Embedded Default | Standalone Default | Description |
|----------|-----------------|-------------------|-------------|
| `REPRAM_HTTP_PORT` | `0` (auto) | `8080` | HTTP API port |
| `REPRAM_GOSSIP_PORT` | `0` (auto) | `9090` | Gossip protocol port |
| `REPRAM_ADDRESS` | `localhost` | `localhost` | Advertised address for peer discovery |
| `REPRAM_NODE_ID` | auto-generated | auto-generated | Unique node identifier |
| `REPRAM_NETWORK` | `public` | `public` | Network name for peer grouping |
| `REPRAM_ENCLAVE` | `default` | `default` | Data replication scope |
| `REPRAM_REPLICATION` | `3` | `3` | Replication factor |
| `REPRAM_MIN_TTL` | `300` | `300` | Minimum TTL in seconds (5 min) |
| `REPRAM_MAX_TTL` | `86400` | `86400` | Maximum TTL in seconds (24 hr) |
| `REPRAM_WRITE_TIMEOUT` | `5` | `5` | Quorum write timeout in seconds |
| `REPRAM_CLUSTER_SECRET` | _(empty)_ | _(empty)_ | HMAC secret for gossip auth (open mode if empty) |
| `REPRAM_RATE_LIMIT` | `100` | `100` | Requests per second per IP |
| `REPRAM_TRUST_PROXY` | `false` | `false` | Trust X-Forwarded-For headers |
| `REPRAM_MAX_STORAGE_MB` | `50` | `0` (unlimited) | Storage capacity limit |
| `REPRAM_LOG_LEVEL` | `warn` | `info` | Log level (debug/info/warn/error) |
| `REPRAM_URL` | _(not set)_ | n/a | External node URL (MCP mode only; skips embedded node) |
| `REPRAM_PEERS` | _(not set)_ | _(not set)_ | Comma-separated peer addresses for bootstrap |

## HTTP API (v1)

Available in standalone mode or when connecting to a node via `REPRAM_URL`.

| Method | Path | Description |
|--------|------|-------------|
| `PUT` | `/v1/data/{key}` | Store data. TTL via `?ttl=N` or `X-TTL` header. |
| `GET` | `/v1/data/{key}` | Retrieve data. Returns `X-Remaining-TTL`, `X-Original-TTL`, `X-Created-At`. |
| `HEAD` | `/v1/data/{key}` | Check existence. Same headers as GET, no body. |
| `GET` | `/v1/keys?prefix=X&limit=N&cursor=X` | List keys with optional prefix filter and pagination. |
| `GET` | `/v1/health` | Health check. |
| `GET` | `/v1/status` | Node status with memory usage. |
| `GET` | `/v1/topology` | Known peers. |

## Wire Compatibility

The TypeScript node uses the same JSON wire format and HMAC-SHA256 signing as the Go implementation. TS and Go nodes can coexist in the same cluster.

## Building from Source

```bash
npm install
npm run build
npm test          # 248 tests
```

## License

MIT
