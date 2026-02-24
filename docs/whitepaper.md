# REPRAM White Paper (One-Page Summary)

## Purpose

REPRAM is a distributed ephemeral key-value store designed as an infrastructure primitive for autonomous AI agents. It provides a zero-trust coordination layer where agents can store temporary data, pass payloads to each other, and share state — without accounts, authentication, or persistent storage.

## Problem Statement

AI agents need to coordinate. They need to pass intermediate results between steps, hand off context to other agents, and signal state across distributed workflows. But the existing options are heavy: databases require credentials and cleanup, message queues require infrastructure, and file systems require shared access. There's no lightweight, self-cleaning coordination primitive designed for ephemeral agent workflows. REPRAM fills that gap.

## Solution

REPRAM provides a simple protocol: PUT data with a key and a TTL, GET it by key, list keys by prefix. Data is replicated across nodes via gossip protocol with quorum confirmation. When the TTL expires, the data is deleted from all nodes — automatically, permanently, with no recovery mechanism. Agents access REPRAM through an MCP server that exposes three tools: `repram_store`, `repram_retrieve`, and `repram_list_keys`.

## Key Properties

* **Ephemeral**: All data has a mandatory TTL and is automatically deleted on expiration
* **Zero-trust**: Nodes store opaque data without interpreting, indexing, or logging it
* **Permissionless**: No accounts, no API keys, no authentication — access is controlled by key knowledge
* **Gossip-replicated**: Nodes share data via peer-to-peer gossip with quorum writes
* **Homogeneous**: All nodes run the same binary and self-organize via DNS bootstrap

## Agent Usage Patterns

* **Dead drop**: Agent A stores a payload, Agent B retrieves it by key. Data self-destructs after TTL.
* **Scratchpad**: An agent stores intermediate state across multi-step workflows.
* **Coordination token**: Key presence means "claimed" or "in progress"; expiration means "available."
* **Session state**: Ephemeral workflow context that doesn't persist beyond the task.

## Deployment Model

* Single Go binary, single Docker image
* DNS-based bootstrap for public network discovery
* `REPRAM_NETWORK=private` with `REPRAM_PEERS` for isolated clusters
* MCP server (`repram-mcp`) via npx or Docker for agent integration

## Future Directions

* Public bootstrap network with DNS SRV records
* Encrypted storage layer for sensitive agent payloads
* Cross-agent namespace conventions
* Larger network testing and optimization

REPRAM is designed to be the short-term memory of the agent web: fast, private, temporary storage that requires no trust and no central control.
