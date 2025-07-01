# REPRAM Hybrid Consensus and Sync Model

## Overview
REPRAM is an ephemeral key-value storage network where data is short-lived and encrypted at rest. Rather than achieving strong global consensus, REPRAM prioritizes eventual consistency and fault-tolerance through a hybrid approach combining Bloom Filter Sync, Lazy Pull Consensus, and topology-aware bootstrapping.

## Key Principles
- **Ephemeral by Design**: All data has a time-to-live (TTL). The system does not aim to store permanent state.
- **Convergence over Immediacy**: The network favors lightweight self-healing over strong consistency.
- **Topology-Aware Onboarding**: New nodes enter via structured discovery, then decentralize fully.

## Consensus and Synchronization Components

### 1. Bootstrap Sync
When a new node joins:
- It contacts a known root node.
- Receives a topology map with nearby peers.
- Selects one peer and requests a **full ephemeral key dump**.
- Applies this dump locally before participating in further sync rounds.

### 2. Bloom Filter Sync
All nodes periodically:
- Build a Bloom filter representing their current active keys.
- Share this filter with a subset of peers.
- Compare received filters to identify definite missing keys.
- Request and replicate only missing data.

False positives in Bloom filters are acceptable due to the self-correcting nature of periodic syncs.

### 3. Lazy Pull Consensus
- Nodes track which peers have stale or incomplete views.
- If queried for a missing key, a node will pull it from others if it's still available.
- This supports implicit healing during normal operation.

### 4. Periodic Hierarchical Rebalance
- Nodes periodically re-evaluate their position in the discovery tree.
- If a significantly better parent is available (typically 20% latency improvement), the node migrates.
- Leaf nodes rebalance first, followed by branch and trunk layers.

### 5. Self-Healing Checks
- Nodes periodically verify that their parent is valid (correct role, capacity, and responsiveness).
- If a mismatch is detected, they re-initiate discovery and reattach.

## Behavior Under Failure
- **Parent Failure**: Nodes detect unresponsive or misclassified parents and reattach elsewhere.
- **Partitioning**: Nodes re-bootstrap from root nodes to rejoin the main network.
- **Graceful Recovery**: Data loss is acceptable if TTL expires, but nodes strive to maintain completeness during the lifetime window.

## Benefits
- Low bandwidth usage
- Fast convergence
- Resilient to churn and partial outages
- Suitable for encrypted, short-lived data workloads

## Future Extensions
- Time-bucketed Bloom filters for TTL-prioritized syncing
- Root node failover via DNS or distributed bootstrapping
- Optional snapshot anchoring for forensic or archival purposes

