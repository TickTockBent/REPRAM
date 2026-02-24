# REPRAM Core Principles

This document defines the fundamental, inviolable principles that guide REPRAM's design and implementation. All features, including future enhancements, must adhere to these principles.

## 1. Data Storage Principles

### 1.1 Pure Key-Value Storage
- **What we store**: Only key-value pairs with TTL
- **No metadata at node level**: Nodes never interpret or store metadata about the data
- **Opaque values**: Nodes treat all stored data as opaque blobs

### 1.2 Zero-Knowledge Nodes
- **Nodes store opaque data**: They cannot interpret, index, or inspect stored values
- **No content awareness**: Nodes have no knowledge of what they store
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
- **Background cleanup**: Regular sweeps delete expired data
- **On-access cleanup**: Expired data is deleted when accessed
- **No TTL extension**: Once set, TTL cannot be extended (must re-write with new TTL)

## 4. Network Distribution Principles

### 4.1 Gossip Protocol
- **Eventually consistent**: All nodes eventually have all key-value pairs
- **Peer-to-peer propagation**: No central coordinator or master node
- **Symmetric network**: All nodes are equal participants

### 4.2 Replication
- **Full replication**: Every node stores every key-value pair
- **Quorum writes**: Writes must be acknowledged by multiple nodes
- **No sharding**: Data is not partitioned across nodes

## 5. Security Principles

### 5.1 Zero Trust
- **Nodes are untrusted**: Assume nodes could be compromised
- **No secrets on nodes**: Nodes never hold encryption keys or sensitive data
- **Hostile network assumption**: Design assumes hostile infrastructure

### 5.2 Client Responsibility
- **Encryption is a client concern**: If data needs to be encrypted, clients handle it before storing
- **Clients choose their security model**: REPRAM provides the transport, not the security envelope
- **No mandated cryptography**: Nodes are agnostic to whether data is encrypted or plaintext

## Principle Validation Checklist

When evaluating new features or modifications, ask:

1. Does it maintain pure key-value storage?
2. Are nodes still zero-knowledge about stored data?
3. Can anyone still read data by key without authentication?
4. Is TTL still mandatory and enforced?
5. Does gossip still replicate to all nodes?
6. Is there zero impact on non-participating operations?

If any answer is "no", the feature violates REPRAM's core principles and must be redesigned.
