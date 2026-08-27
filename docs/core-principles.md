# REPRAM Core Principles

This document defines the fundamental, inviolable principles that guide REPRAM's design and implementation. All features, including future enhancements, must adhere to these principles.

## 1. Data Storage Principles

### 1.1 Pure Key-Value Storage
- **What we store**: Only key-value pairs with TTL
- **No metadata at node level**: Nodes never interpret or store metadata about the data
- **Opaque values**: Nodes treat all stored data as opaque blobs

### 1.2 Content-Agnostic Nodes
- **Nodes store opaque data**: They do not interpret or index stored values. (A node necessarily holds the bytes and can read them; it attaches no meaning to them. Confidentiality is the client's layer — encrypt values that must stay secret.)
- **No content awareness**: Nodes attach no meaning to what they store
- **No logging of values**: Stored data is never written to logs or metrics

## 2. Data Access Principles

### 2.1 Permissionless Access
- **Anyone can read any key**: No access control at the node level
- **No authentication required**: Reading data requires only knowing the key
- **Security through key knowledge**: Keys are the only access control mechanism

### 2.2 No Accounts or Identity
- **No user accounts**: Nodes do not track who stores or retrieves data
- **No API keys**: Access is open by design
- **Anonymity by default**: Nodes cannot distinguish between clients

## 3. Ephemeral Storage Principles

### 3.1 Mandatory TTL
- **Every key has a TTL**: No permanent storage, ever
- **Automatic deletion**: Data is irretrievably deleted when TTL expires
- **No recovery mechanism**: Deleted data cannot be recovered by design
- **Minimum TTL enforced**: 300 seconds (5 minutes) minimum to ensure network-wide propagation

### 3.2 TTL Enforcement
- **Background cleanup**: A periodic sweep (every 30s) reclaims the memory of expired entries
- **On-access enforcement**: Expired entries are invisible to reads and listings from the instant of expiry — every access checks the TTL; the sweep only frees memory
- **No TTL extension**: Once set, TTL cannot be extended (must re-write with new TTL)

## 4. Network Distribution Principles

### 4.1 Gossip Protocol
- **Eventually consistent**: All nodes eventually have all key-value pairs within their enclave
- **Peer-to-peer propagation**: No central coordinator or master node
- **Symmetric network**: All nodes are equal participants
- **Adaptive fanout**: Small enclaves (≤10 peers) use full broadcast; larger enclaves use probabilistic √N fanout per hop with epidemic forwarding and message deduplication

### 4.2 Replication
- **Full replication within enclaves**: Every node stores every key-value pair from its enclave
- **Enclave-scoped**: `REPRAM_ENCLAVE` defines replication boundaries; nodes in the same enclave replicate data, all nodes share topology
- **Quorum writes**: Writes must be acknowledged by multiple nodes (dynamic quorum based on enclave size)
- **No sharding**: Data is not partitioned across nodes — every enclave member holds all enclave data

### 4.3 Resilience Through Ephemerality
- **Loose coupling**: Nodes don't need to be tightly coupled or consistently available. The data's lifecycle is self-limiting — a node that goes offline for an hour and comes back has simply missed some data that may have already expired anyway.
- **No catch-up problem**: Traditional distributed systems need complex reconciliation when a node rejoins. REPRAM doesn't — expired data doesn't need to be synced, and current data will arrive via normal gossip.
- **Graceful degradation**: Partial network availability doesn't create stale state or split-brain problems. Data either exists (within TTL) or doesn't. There's no ambiguity to resolve.

## 5. Security Principles

### 5.1 Privacy Through Transience
- **Nothing accumulates**: Nothing persists beyond its TTL, so a node's exposure is bounded to what is currently live
- **Nodes hold nothing of lasting value**: A compromised node reveals only what it currently stores — a window bounded by the maximum TTL, not an archive
- **No secrets on nodes**: Nodes hold no encryption keys or credentials of their own. Whether stored *values* are sensitive is the client's choice — see 5.2
- **Untrusted infrastructure is assumed**: Nodes are expected to run in environments nobody fully controls. The network's promise is narrow: it forgets what it holds. It cannot make observers forget what they saw, prevent anyone from re-storing bytes they kept, or protect plaintext from the node holding it. Everything beyond forgetting is the client's layer (5.2)

### 5.2 Client Responsibility
- **Encryption is a client concern**: If data needs to be encrypted, clients handle it before storing
- **Clients choose their security model**: REPRAM provides the transport, not the security envelope
- **No mandated cryptography**: Nodes are agnostic to whether data is encrypted or plaintext

## Principle Validation Checklist

When evaluating new features or modifications, ask:

1. Does it maintain pure key-value storage?
2. Are nodes still content-agnostic about stored data?
3. Can anyone still read data by key without authentication?
4. Is TTL still mandatory and enforced?
5. Does gossip still replicate to all enclave peers?
6. Is there zero impact on non-participating operations?

If any answer is "no", the feature violates REPRAM's core principles and must be redesigned.
