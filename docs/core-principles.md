# REPRAM Core Principles

This document defines the fundamental, inviolable principles that guide REPRAM's design and implementation. All features, including future enhancements, must adhere to these principles.

## 1. Data Storage Principles

### 1.1 Pure Key-Value Storage
- **What we store**: Only key-value pairs with TTL
- **No metadata at node level**: Nodes never interpret or store metadata about the data
- **All metadata is client-encoded**: Any additional information (including compliance data) is encoded into the value by the SDK

### 1.2 Client-Side Encryption
- **All encryption happens at the SDK**: Nodes never see unencrypted data
- **Nodes store opaque blobs**: The encrypted value is meaningless to nodes
- **Zero-knowledge architecture**: Nodes cannot decrypt or interpret user data

## 2. Data Access Principles

### 2.1 Public Readability
- **Anyone can read any key**: No access control at the node level
- **Security through encryption**: Data is protected by encryption, not access control
- **No authentication required**: Reading data requires only knowing the key

### 2.2 Private Decryptability
- **Only key holders can decrypt**: Data can only be decrypted with the private key
- **No shared secrets**: Each client maintains their own encryption keys

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

## 5. Compliance Integration Principles

### 5.1 Compliance as Client Concern
- **SDK handles compliance**: All compliance logic lives in the SDK
- **Compliance data in value**: Compliance metadata is encoded into the encrypted value
- **Single compliance bit**: Nodes only see a boolean flag indicating compliance-required data

### 5.2 Attestation Without Violation
- **Only key hashes stored**: Attestations contain SHA-256 of keys, not the keys themselves
- **No value storage**: Attestations never include or reference the encrypted values
- **Time-limited attestation storage**: Even attestation data has a retention limit (10 cycles)

### 5.3 Zero Performance Impact
- **Opt-in compliance**: Standard operations unchanged
- **No overhead for non-compliance**: 99% of operations have zero compliance overhead
- **Isolated compliance path**: Compliance operations don't affect normal operations

## 6. Security Principles

### 6.1 Zero Trust
- **Nodes are untrusted**: Assume nodes could be compromised
- **Client-side security**: All security measures happen at the client
- **No secrets on nodes**: Nodes never hold encryption keys or sensitive data
- **Hostile network assumption**: Geographic distribution assumes hostile network infrastructure and unfriendly jurisdictions

### 6.2 Cryptographic Integrity
- **All encryption is client-side**: Using industry-standard algorithms (AES-256-GCM)
- **Future proof**: Ready for post-quantum cryptography upgrades
- **No custom crypto**: Use well-tested, standard cryptographic libraries

## Principle Validation Checklist

When evaluating new features or modifications, ask:

1. ✓ Does it maintain pure key-value storage?
2. ✓ Is all encryption still client-side only?
3. ✓ Can anyone still read the (encrypted) data?
4. ✓ Is TTL still mandatory and enforced?
5. ✓ Does gossip still replicate to all nodes?
6. ✓ Are nodes still zero-knowledge?
7. ✓ Is there zero impact on non-participating operations?
8. ✓ Are we avoiding any custom cryptography?

If any answer is "no", the feature violates REPRAM's core principles and must be redesigned.

## Phase 5 Compliance Validation

The Phase 5 compliance framework adheres to all core principles:

- ✓ **Key-value storage maintained**: Compliance data encoded in value
- ✓ **Client-side encryption preserved**: SDK handles all compliance metadata
- ✓ **Public readability unchanged**: Anyone can still read encrypted blobs
- ✓ **TTL enforcement continues**: All data still expires, including compliance data
- ✓ **Gossip replication works**: Compliance bit gossips with key-value pairs
- ✓ **Zero-knowledge preserved**: Nodes only see hashes in attestations
- ✓ **Zero impact achieved**: Non-compliance operations completely unaffected
- ✓ **Standard crypto used**: Ed25519 for signatures, SHA-256 for hashing

The compliance framework successfully extends REPRAM's capabilities without violating any core principle.