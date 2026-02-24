# REPRAM White Paper (One-Page Summary)

## Purpose

REPRAM is a distributed dead drop network for AI agents. Data goes in with a timer. When the timer runs out, the data is destroyed — permanently, across all nodes, with no recovery mechanism. The network doesn't know what it stores, doesn't track who accesses it, and doesn't keep records of anything. It forgets, by design.

## Problem Statement

AI agents need to coordinate. They pass intermediate results between steps, hand off context to other agents, and signal state across distributed workflows. The existing options all assume you want to *keep* things: databases require credentials and cleanup, message queues require infrastructure, file systems require shared access and garbage collection.

There's no lightweight primitive designed for data that *should not persist*. Every time an agent stashes temporary state in a database, someone later has to figure out what's stale and delete it. REPRAM eliminates that entire problem class: you declare how long data should live when you store it, and the network handles the rest.

## Solution

REPRAM provides a simple protocol: PUT data with a key and a TTL, GET it by key, list keys by prefix. Data is replicated across nodes via gossip protocol with quorum confirmation. When the TTL expires, the data is deleted from all nodes — automatically, permanently, with no recovery mechanism.

Agents access REPRAM through an MCP server that exposes three tools: `repram_store`, `repram_retrieve`, and `repram_list_keys`.

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
* **Gossip-replicated**: Nodes share data via peer-to-peer gossip with quorum writes
* **Homogeneous**: All nodes run the same binary and self-organize via DNS bootstrap
* **Loosely coupled**: Nodes don't need to be tightly synchronized or consistently available — the data's lifecycle is self-limiting, so a node that misses an hour of writes has simply missed data that may have already expired

## Agent Usage Patterns

* **Dead drop**: The core pattern. Agent A stores a payload under a key. Agent B retrieves it by that key. The data self-destructs when the TTL expires. Neither agent needs to know the other's endpoint — they coordinate through the shared key.
* **Scratchpad**: An agent stores intermediate state across multi-step workflows, retrieves and updates it as it progresses, and lets it expire when done.
* **Coordination token**: Key presence means "claimed" or "in progress"; expiration means "available." Lightweight distributed locking without a lock server.

## Deployment Model

* Single Go binary, single Docker image
* DNS-based bootstrap for public network discovery
* `REPRAM_NETWORK=private` with `REPRAM_PEERS` for isolated clusters
* MCP server (`repram-mcp`) via npx or Docker for agent integration

## Future Directions

* Public bootstrap network with DNS SRV records
* Namespace conventions for cross-agent interoperability
* Larger network testing and gossip protocol optimization

REPRAM is the `/tmp` of the agent web: fast, ephemeral, shared storage that requires no trust, no setup, and no cleanup.
