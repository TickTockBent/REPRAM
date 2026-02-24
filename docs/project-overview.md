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
* **MCP Server** (`repram-mcp`): TypeScript MCP server that wraps the REST API as agent-callable tools (`repram_store`, `repram_retrieve`, `repram_exists`, `repram_list_keys`). This is the primary interface for AI agents.
* **Bootstrap Layer**: DNS-based peer discovery for the public network (`bootstrap.repram.network`), or manual `REPRAM_PEERS` for private clusters
* **Gossip Network**: HTTP-based peer-to-peer message propagation with quorum acknowledgement

## Agent Usage Patterns

**Dead drop** — The core pattern. Agent A stores a payload under a key. Agent B retrieves it by that key. Neither agent needs to know the other's endpoint — they coordinate through the shared key. For rendezvous between agents that don't know each other, derive the key from shared context (e.g., `hash(task_id + agent_pair)`) so both parties can compute it independently.

**Scratchpad** — An agent stores intermediate reasoning or computation state, retrieves it across multi-step workflows, and lets it expire when done.

**Coordination token** — Multiple agents treat key presence as a signal. A key existing means "task claimed" or "in progress"; its expiration means "available." Lightweight distributed locking without a lock server.

**Heartbeat / presence** — An agent writes a key on a recurring interval with a short TTL. The key's existence is the liveness signal. If the writer stops writing, the key expires — and the absence is the failure notification. No health check infrastructure, no polling, no failure detector. The TTL is the failure detector.

**State machine** — A job ID key whose value transitions through states via overwrites (`queued` → `in_progress` → `complete`). The TTL acts as a staleness guarantee: if a job writes `in_progress` with a 10-minute TTL and then crashes, the key expires and any agent polling it knows the job didn't complete. Overwrites reset the TTL, so each state transition refreshes the window.

Both patterns rely on silent overwrite being the defined behavior for existing keys, and reinforce why DELETE doesn't belong in the protocol — in the heartbeat pattern, the *absence* of a write is the meaningful signal. The system's only job is to faithfully forget.

## Beyond Agents — REPRAM as a Primitive

REPRAM is `pipe`, not `grep`. It doesn't know or care what flows through it — it stores bytes, replicates them, and destroys them on schedule. The agent patterns above are the primary use case, but the primitive is general-purpose. Any system that needs temporary, replicated, self-cleaning storage can use REPRAM without modification.

**Circuit breaker** — A service writes a `healthy` key with short TTL. Consumers check before calling. Service dies → key expires → consumers back off. Distributed circuit breaking without a circuit breaker library.

**Ephemeral broadcast** — Write a value to a known key; anyone polling that key gets the current state. Config distribution, feature flags, announcement channels. Stop writing and the broadcast expires — automatic rollback with zero cleanup.

**Secure relay** — Encrypt a payload, store it, share the key through a side channel. Recipient retrieves it. Data self-destructs after TTL. No server logs, no accounts, no metadata trail. The infrastructure doesn't know what it carried and can't be compelled to remember. Works for anything from whistleblower drops to encrypted military communications.

**Session continuity** — Store session state under a session ID, overwrite on each interaction to refresh TTL. Any edge server can read the current state. User stops interacting → session expires naturally. No session store, no garbage collection, no stale session cleanup jobs. Enterprise browser session replication without enterprise infrastructure.

**Distributed deduplication** — Write a key when processing an event. Before processing, check if key exists. Key present = already handled. TTL = dedup window. No dedup database, no purge logic.

**Ephemeral pub/sub** — Publisher overwrites a known key on interval. Subscribers poll. No subscription management, no broker, no message ordering. Lossy by design — and for status dashboards, approximate state sync, or coordination signals, that's exactly right.

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
