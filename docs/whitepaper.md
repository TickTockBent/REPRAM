# REPRAM White Paper (One-Page Summary)

## Purpose

REPRAM is a distributed dead drop network for AI agents. Data goes in with a timer. When the timer runs out, the data is destroyed — permanently, across all nodes, with no recovery mechanism. The network doesn't know what it stores, doesn't track who accesses it, and doesn't keep records of anything. It forgets, by design.

## Problem Statement

AI agents need to coordinate. They pass intermediate results between steps, hand off context to other agents, and signal state across distributed workflows. The existing options all assume you want to *keep* things: databases require credentials and cleanup, message queues require infrastructure, file systems require shared access and garbage collection.

There's no lightweight primitive designed for data that *should not persist*. Every time an agent stashes temporary state in a database, someone later has to figure out what's stale and delete it. REPRAM eliminates that entire problem class: you declare how long data should live when you store it, and the network handles the rest.

## Solution

REPRAM provides a simple protocol: PUT data with a key and a TTL, GET it by key, list keys by prefix. Data is replicated across nodes via gossip protocol with quorum confirmation. When the TTL expires, the data is deleted from all nodes — automatically, permanently, with no recovery mechanism.

Agents access REPRAM through an MCP server that exposes four tools: `repram_store`, `repram_retrieve`, `repram_exists`, and `repram_list_keys`.

## The Security Model: Privacy Through Transience

REPRAM is not secure in the traditional sense. It has no access control, no authentication, no encryption. Anyone who knows a key can read its value.

What REPRAM offers instead is **privacy through transience**. The network is safe to use because it forgets everything. Nodes don't interpret, index, or log what they store — they can't, because they have no schema or query language. Data exists only in memory, only for the duration of the TTL, and then it's gone. There's nothing to subpoena, nothing to breach, nothing to leak, because nothing accumulates.

This is a fundamentally different security posture: instead of protecting data with locks, REPRAM protects data by destroying it on schedule.

If you need confidentiality *during* the TTL window, encrypt your data before storing it. REPRAM doesn't care whether the bytes are plaintext or ciphertext — it stores and returns them identically.

## What REPRAM Is Not

- **Not a database.** Data here is guaranteed to disappear. There is no persistence, no backups, no recovery.
- **Not a message queue.** There's no delivery guarantee, no consumer groups, no ordering. It's "leave it and hope they check."
- **Not a secrets manager.** There's no access control. Anyone who knows the key gets the data.
- **Not a cache.** There's no eviction on memory pressure, no LRU, no write-through. TTL is the only lifecycle.

## Key Properties

* **Ephemeral**: All data has a mandatory TTL and is automatically deleted on expiration
* **Zero-knowledge**: Nodes store opaque data without interpreting, indexing, or logging it
* **Permissionless**: No accounts, no API keys, no authentication — access is controlled by key knowledge
* **Gossip-replicated**: Nodes share data via peer-to-peer gossip with quorum writes; adaptive fanout (full broadcast for small enclaves, √N probabilistic for larger ones)
* **Homogeneous**: All nodes run the same binary and self-organize via DNS bootstrap
* **Loosely coupled**: Nodes don't need to be tightly synchronized or consistently available — the data's lifecycle is self-limiting, so a node that misses an hour of writes has simply missed data that may have already expired

## Agent Usage Patterns

* **Dead drop**: The core pattern. Agent A stores a payload under a key. Agent B retrieves it by that key. The data self-destructs when the TTL expires. Neither agent needs to know the other's endpoint — they coordinate through the shared key.
* **Scratchpad**: An agent stores intermediate state across multi-step workflows, retrieves and updates it as it progresses, and lets it expire when done.
* **Coordination token**: Key presence means "claimed" or "in progress"; expiration means "available." Lightweight distributed locking without a lock server.
* **Heartbeat / presence**: An agent writes a key on a recurring interval with a short TTL. Key existence is the liveness signal; key expiration is the failure notification. The TTL *is* the failure detector — no health check infrastructure required.
* **State machine**: A job ID key whose value transitions through states via overwrites. The TTL acts as a staleness guarantee — if a job writes `in_progress` with a 10-minute TTL and crashes, the key expires, signaling incompletion to any polling agent. Overwrites reset the TTL, so each state transition refreshes the window.

## Beyond Agents — REPRAM as a Primitive

REPRAM is `pipe`, not `grep`. It stores bytes, replicates them, and destroys them on schedule. It doesn't interpret what flows through it. The agent patterns above are the primary motivation, but the primitive is general-purpose:

* **Circuit breaker**: A service writes a `healthy` key with short TTL. Consumers check before calling. Service dies → key expires → consumers back off.
* **Ephemeral broadcast**: Write config or feature flags to a known key. Consumers poll. Stop writing and the value expires — automatic rollback.
* **Secure relay**: Encrypt a payload, store it under a key shared through a side channel. Data self-destructs after TTL. No logs, no accounts, no metadata trail.
* **Session continuity**: Store session state under a session ID with rolling TTL. Any edge server reads current state. User stops interacting → session expires naturally.
* **Distributed deduplication**: Write a key when processing an event. Check before processing — key present means already handled. TTL = dedup window.
* **Ephemeral pub/sub**: Publisher overwrites a known key on interval. Subscribers poll. No broker, no subscription management. Lossy by design.

## Deployment Model

* Single Go binary, single Docker image
* DNS-based bootstrap for public network discovery
* `REPRAM_NETWORK=private` with `REPRAM_PEERS` for isolated clusters
* MCP server (`repram-mcp`) via npx or Docker for agent integration

## Design Decisions

### No DELETE

REPRAM has no delete operation. This is intentional, not an omission.

Every piece of data has exactly one lifecycle: it is stored, it exists for the duration of its TTL, and then it is destroyed. There is no other path. This constraint is what makes the system simple, predictable, and safe.

Adding DELETE would introduce a second way for data to disappear, which breaks the guarantees that several core patterns depend on. In the heartbeat pattern, the *absence* of a fresh write is the failure signal — a DELETE would be indistinguishable from a crash. In the coordination-token pattern, key presence means "claimed" — a DELETE would create ambiguity about whether the work completed or was abandoned. The TTL is the timeout, the failure detector, and the garbage collector, all in one mechanism. DELETE would undermine all three.

The practical concern — "what if I want to clean up sensitive data early?" — is addressed by the TTL itself. Choose a TTL that matches your actual need. If you're done in 30 seconds, use a 5-minute TTL, not a 24-hour one. The window of exposure is bounded and short. If even that window is unacceptable, encrypt the data client-side and discard the key when you're done — the ciphertext becomes unrecoverable junk instantly, regardless of TTL.

Soft delete via overwrite (write an empty value with short TTL) is technically possible with existing primitives, but we deliberately don't promote it. The right answer is almost always "pick a shorter TTL" rather than adding cleanup logic that can itself fail.

## Future Directions

* Public bootstrap network with DNS SRV records
* Larger network testing

REPRAM is the `/tmp` of the agent web: fast, ephemeral, shared storage that requires no trust, no setup, and no cleanup.
