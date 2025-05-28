# Phase 5 Compliance: Final Design - Ephemeral Attestations

## Core Concept
Nodes generate time-limited attestations for compliance-flagged deletions, maintaining them only briefly. Compliance becomes the client's responsibility, with optional enterprise storage service.

## Architecture Overview

### Node Behavior (Minimal Enhancement)
- **First-bit checking**: Nodes check first bit of encrypted blob during deletion
- **Deletion tracking**: Short-term buffer of compliance-flagged deletions only
- **Periodic attestations**: Generate deletion proofs at intervals
- **10-cycle buffer**: Keep last 10 attestation cycles (not individual deletions)
- **No permanent storage**: All attestations auto-expire
- **No identity required**: Nodes remain anonymous, no signatures or identification
- **Pure key-value**: No separate compliance field, just opaque encrypted blobs

### Key Design Elements

```go
// Node sees only
type StorageEntry struct {
    Key           string
    EncryptedBlob []byte    // First bit indicates compliance if set to 1
    TTL           time.Time
    // No separate compliance field needed!
}

// When compliance-flagged data expires
type ComplianceDeletion struct {
    KeyHash    string    // SHA-256 of key
    DeletedAt  time.Time
}

// Periodic attestation cycles (e.g., every hour)
type AttestationCycle struct {
    CycleID     string
    StartTime   time.Time
    EndTime     time.Time
    Deletions   []ComplianceDeletion
    // No signatures - nodes remain anonymous
}

// Node maintains rolling buffer
type ComplianceBuffer struct {
    cycles [10]AttestationCycle  // Fixed size, circular buffer
    current int
}
```

## Implementation Details

### Compliance-Flagged Deletion Flow
1. **TTL Expiration**: Data with compliance bit expires
2. **Deletion Recorded**: Key hash + timestamp added to current cycle
3. **Normal Deletion**: Data removed as usual
4. **Cycle Completion**: Attestation generated at interval end
5. **Buffer Rotation**: Old cycles dropped after 10 cycles

### Attestation Distribution

#### Event Stream (Push Model)
```
WebSocket: /compliance/stream

// Clients subscribe to real-time attestations
{
    "type": "attestation_cycle",
    "cycle_id": "2024-01-28-1400",
    "deletions": [
        {"key_hash": "sha256:abc...", "deleted_at": "2024-01-28T14:23:45Z"},
        {"key_hash": "sha256:def...", "deleted_at": "2024-01-28T14:47:12Z"}
    ]
    // No node identification or signatures
}
```

#### Pull API (Query Model)
```
GET /compliance/attestations
Response: Last 10 cycles of attestations

GET /compliance/attestations/latest
Response: Current/most recent cycle

GET /compliance/attestations/{cycle_id}
Response: Specific cycle (if still in buffer)
```

### No Authentication Required
- **Public endpoints**: Anyone can subscribe or query
- **Client responsibility**: Store attestations they care about
- **No access control**: Maintains REPRAM's open principle

## Client Responsibilities

### SDK Behavior
```go
// SDK encodes compliance in the encrypted blob itself
func (sdk *SDK) Put(key string, value []byte, ttl int, opts ...Option) {
    needsCompliance := false
    var complianceData ComplianceMetadata
    
    for _, opt := range opts {
        if compliance, ok := opt.(ComplianceOption); ok {
            needsCompliance = true
            complianceData = compliance.Metadata
        }
    }
    
    // Prepare the value with optional compliance metadata
    var finalValue []byte
    if needsCompliance {
        // Embed compliance metadata in the value
        finalValue = sdk.embedCompliance(value, complianceData)
    } else {
        finalValue = value
    }
    
    // Encrypt the value
    encrypted := sdk.encrypt(finalValue)
    
    // Set first bit to 1 if compliance is needed
    if needsCompliance {
        encrypted[0] |= 0x80  // Set the first bit to 1
        sdk.trackForCompliance(key, ttl)
    } else {
        encrypted[0] &= 0x7F  // Ensure first bit is 0
    }
    
    // Node just sees an encrypted blob
    node.Put(key, encrypted, ttl)
}

// Node checks first bit during deletion
func (node *Node) processExpiredData(entry StorageEntry) {
    // Check if this needs compliance attestation
    if len(entry.EncryptedBlob) > 0 && (entry.EncryptedBlob[0]&0x80) != 0 {
        // First bit is 1, add to compliance buffer
        node.recordComplianceDeletion(entry.Key)
    }
    // Delete the data regardless
    node.delete(entry.Key)
}
```

### Compliance Monitoring
```go
// Client subscribes to attestations
func (client *ComplianceClient) MonitorAttestations() {
    ws := client.connectWebSocket("/compliance/stream")
    
    for attestation := range ws.Messages() {
        // Match against tracked keys
        for _, deletion := range attestation.Deletions {
            if client.isTracking(deletion.KeyHash) {
                client.recordCompliance(deletion)
            }
        }
    }
}
```

## Enterprise Compliance Service (Optional)

**Important**: This service is EXTERNAL to REPRAM - it monitors the network like a blockchain explorer monitors blockchains. It is not part of the core REPRAM architecture.

### Value-Added Service
```go
// Your compliance storage service (separate infrastructure)
type RepramComplianceVault struct {
    storage     AttestationDB      // Permanent storage
    subscribers []string           // Customer accounts
}

// Service monitors REPRAM nodes from outside
func (vault *RepramComplianceVault) CollectAttestations() {
    for _, node := range vault.monitoredNodes {
        go vault.subscribeToNode(node)  // External monitoring
    }
}

// Customers query your service, not REPRAM nodes
GET https://compliance.repram.io/api/v1/attestations
Authorization: Bearer {customer-api-key}
```

### Monetization Tiers

1. **Self-Service** (Free)
   - Monitor nodes yourself
   - Store your own attestations
   - Basic SDK compliance features

2. **Compliance Cloud** ($X/month)
   - We monitor all nodes for you
   - Searchable attestation history
   - Compliance reports
   - Guaranteed retention periods

3. **Enterprise** (Custom pricing)
   - Dedicated compliance infrastructure
   - Custom retention policies
   - Regulatory report templates
   - Audit support

## Key Benefits

### Maintains Core Principles
- ✓ **No permanent storage**: 10-cycle buffer auto-expires
- ✓ **No authentication**: Public endpoints maintained
- ✓ **Ephemeral by design**: Attestations are temporary
- ✓ **No node identity**: Nodes remain completely anonymous
- ✓ **Zero-knowledge**: Only key hashes, no values
- ✓ **Minimal overhead**: Only tracks compliance-flagged deletions

### Enables Compliance
- ✓ **Audit trails**: Provable deletion records
- ✓ **Multi-framework**: Supports any compliance need
- ✓ **Resilient design**: 10-cycle buffer prevents data loss
- ✓ **Enterprise ready**: Optional managed service

### Business Model
- ✓ **Open core**: Basic compliance in open source
- ✓ **Value-added service**: Compliance storage/management
- ✓ **Enterprise features**: Advanced compliance tools
- ✓ **Clear monetization**: Pay for convenience, not access

## Example Compliance Flow

1. **Healthcare App** stores patient session:
   ```go
   sdk.Put("session:patient:123", data, 3600, 
       WithCompliance("HIPAA", "PHI-Session"))
   ```

2. **Node** sees compliance bit, tracks deletion

3. **Hour passes**, session expires, node records:
   ```
   KeyHash: sha256("session:patient:123")
   DeletedAt: 2024-01-28T15:30:00Z
   ```

4. **Cycle ends**, node broadcasts attestation

5. **Healthcare App** receives attestation, stores for 7 years

6. **OR** uses Repram Compliance Cloud for managed storage

## Summary

This design achieves enterprise compliance while maintaining REPRAM's revolutionary architecture:
- Nodes remain ephemeral with time-limited buffers
- No authentication or permanent storage added
- Clients own their compliance destiny
- Optional enterprise service for convenience
- Perfect alignment with dual-licensing model