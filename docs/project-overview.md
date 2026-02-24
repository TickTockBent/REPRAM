# Project Overview: REPRAM (REplicated EPhemeral RAM)

## Summary

REPRAM is a distributed dead drop network for AI agents. Store data under a key with a time-to-live, retrieve it by key, and let it self-destruct when the TTL expires. The network doesn't know what it stores, doesn't track who accesses it, and doesn't keep records. Privacy through transience: the network is safe to use because it forgets everything.

The core insight: agents need a place to put things that *should not last*. Intermediate reasoning, handoff payloads, coordination tokens, scratch state — all of this currently ends up in databases or file systems designed to keep things forever, and then someone has to write cleanup logic. REPRAM makes ephemerality the default, not a feature bolted onto persistent infrastructure.

## What REPRAM Is Not

REPRAM is not a database (data is guaranteed to disappear), not a message queue (no delivery guarantees), not a secrets manager (no access control), and not a cache (no eviction policies). It occupies a different niche: temporary, replicated, self-cleaning storage for data that should not exist longer than it's needed.

## Key Properties

* Mandatory TTL on all data — nothing persists, by design
* Zero-knowledge nodes — they store opaque bytes without interpreting them
* No accounts, no authentication — access is controlled by knowing the key
* Gossip-based replication with quorum confirmation
* MCP server for direct AI agent integration (store, retrieve, list tools)
* DNS-based bootstrap for public network discovery
* Single binary, single config surface (`REPRAM_*` env vars)

## The Security Model

REPRAM has no access control, no encryption, and no authentication. It is secure because it forgets. Nodes can't inspect stored data (no schema, no indexes, no query language). Data exists only in memory for the TTL duration, then it's destroyed across all nodes. There's nothing to breach because nothing accumulates.

If you need confidentiality during the TTL window, encrypt data before storing it. REPRAM is agnostic to whether bytes are plaintext or ciphertext.

## Architecture

* **REPRAM Node**: Go binary that stores key-value pairs in memory with TTL expiration, replicates via gossip protocol, and exposes a REST API (`/v1/data/{key}`, `/v1/keys`, `/v1/health`)
* **MCP Server** (`repram-mcp`): TypeScript MCP server that wraps the REST API as agent-callable tools (`repram_store`, `repram_retrieve`, `repram_list_keys`). This is the primary interface for AI agents.
* **Bootstrap Layer**: DNS-based peer discovery for the public network (`bootstrap.repram.network`), or manual `REPRAM_PEERS` for private clusters
* **Gossip Network**: HTTP-based peer-to-peer message propagation with quorum acknowledgement

## Agent Usage Patterns

**Dead drop** — The core pattern. Agent A stores a payload under a key. Agent B retrieves it by that key. Neither agent needs to know the other's endpoint — they coordinate through the shared key. For rendezvous between agents that don't know each other, derive the key from shared context (e.g., `hash(task_id + agent_pair)`) so both parties can compute it independently.

**Scratchpad** — An agent stores intermediate reasoning or computation state, retrieves it across multi-step workflows, and lets it expire when done.

**Coordination token** — Multiple agents treat key presence as a signal. A key existing means "task claimed" or "in progress"; its expiration means "available." Lightweight distributed locking without a lock server.

## Technology Stack

* **Language**: Go (node), TypeScript (MCP server)
* **Runtime**: Docker containers, single binary deployment
* **Transport**: HTTP REST API, gossip over HTTP
* **Storage**: In-memory with TTL-based expiration
* **Discovery**: DNS SRV/A records for public network, static peer list for private
* **Agent Interface**: Model Context Protocol (MCP) over stdio

## Resilience Through Ephemerality

REPRAM nodes don't need to be tightly coupled or consistently available. The data's lifecycle is self-limiting: a node that goes offline for an hour and comes back has simply missed some data that may have already expired anyway. There's no catch-up problem — traditional distributed systems need complex reconciliation when a node rejoins, but REPRAM doesn't, because expired data doesn't need to be synced and current data will arrive via normal gossip.

This is a resilience property that falls naturally out of the ephemeral design. Partial network availability doesn't create stale state or split-brain problems. Data either exists (within TTL) or doesn't. There's no ambiguity to resolve.

## Design Constraints

See [Core Principles](core-principles.md) for the full set of inviolable design rules. Key constraints:

* Every key must have a TTL — no permanent storage
* Nodes never interpret stored data — zero knowledge
* No authentication at the node level — access through key knowledge
* All nodes are equal — no coordinators, no hierarchy
* TTL cannot be extended — must re-write with a new TTL

REPRAM is the `/tmp` of the agent web: fast, ephemeral, shared storage that requires no trust, no setup, and no cleanup.
