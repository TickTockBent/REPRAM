# Project Overview: REPRAM (REplicated EPhemeral RAM)

## Summary

REPRAM is an ephemeral coordination layer for autonomous AI agents. It provides a distributed, self-expiring key-value store where agents can stash temporary data, coordinate handoffs, and share state — without accounts, authentication, or persistent storage.

The core insight: AI agents need a way to pass data to each other that doesn't require shared databases, API keys, or permanent infrastructure. REPRAM fills this gap with a simple protocol — PUT data with a TTL, GET it by key, and let it disappear automatically.

## Key Features

* Mandatory TTL on all data — nothing persists, by design
* Gossip-based replication across distributed nodes with quorum confirmation
* Zero-knowledge nodes — they store opaque data without interpreting it
* No accounts, no authentication — access is controlled by key knowledge
* MCP server for direct AI agent integration (store, retrieve, list tools)
* DNS-based bootstrap for public network discovery
* Single binary, single config surface (`REPRAM_*` env vars)

## Architecture

* **REPRAM Node**: Go binary that stores key-value pairs in memory with TTL expiration, replicates via gossip protocol, and exposes a REST API (`/v1/data/{key}`, `/v1/keys`, `/v1/health`)
* **MCP Server** (`repram-mcp`): TypeScript MCP server that wraps the REST API as agent-callable tools (`repram_store`, `repram_retrieve`, `repram_list_keys`). This is the primary interface for AI agents.
* **Bootstrap Layer**: DNS-based peer discovery for the public network (`bootstrap.repram.network`), or manual `REPRAM_PEERS` for private clusters
* **Gossip Network**: HTTP-based peer-to-peer message propagation with quorum acknowledgement

## Agent Usage Patterns

**Dead drop** — Agent A stores a payload under a key. Agent B retrieves it by that key. The data self-destructs when the TTL expires.

**Scratchpad** — An agent stores intermediate reasoning or computation state, retrieves it across multi-step workflows, and lets it expire when done.

**Coordination token** — Multiple agents treat key presence as a signal. A key existing means "task claimed" or "in progress"; its expiration means "available."

## Technology Stack

* **Language**: Go (node), TypeScript (MCP server)
* **Runtime**: Docker containers, single binary deployment
* **Transport**: HTTP REST API, gossip over HTTP
* **Storage**: In-memory with TTL-based expiration
* **Discovery**: DNS SRV/A records for public network, static peer list for private
* **Agent Interface**: Model Context Protocol (MCP) over stdio

## Design Constraints

See [Core Principles](core-principles.md) for the full set of inviolable design rules. Key constraints:

* Every key must have a TTL — no permanent storage
* Nodes never interpret stored data — zero knowledge
* No authentication at the node level — security through key knowledge
* All nodes are equal — no coordinators, no hierarchy
* TTL cannot be extended — must re-write with a new TTL

REPRAM serves as the short-term memory of the agent web, enabling trustless coordination, ephemeral state sharing, and frictionless handoffs across distributed AI systems.
