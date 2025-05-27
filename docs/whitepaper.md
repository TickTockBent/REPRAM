# REPRAM White Paper (One-Page Summary)

## Purpose

REPRAM is a distributed ephemeral key-value store built for speed, privacy, and scalability. It provides a zero-trust data layer for decentralized systems where temporary state must be shared without persistent storage or centralized coordination. repram is not a blockchain. It is a fast, lightweight, peer-to-peer daemon network optimized for short-lived, encrypted data.

## Problem Statement

Modern decentralized systems lack a lightweight, self-expiring storage layer. Traditional databases are centralized, and most blockchain-based storage is immutable and permanent, violating both performance and compliance needs. There's a gap between permanent ledgers and volatile memory — REPRAM fills that gap.

## Solution

REPRAM enables clients to store encrypted data blobs with a specified time-to-live (TTL). The data is encrypted client-side and stored across a distributed set of nodes using a gossip-based replication protocol. Once the TTL expires, the data is deleted from all nodes. Only the original keyholder can read the content, ensuring complete privacy.

## Key Properties

* **Ephemeral**: All data expires and is deleted automatically
* **Encrypted**: All data is client-side encrypted; the network cannot decrypt or inspect it
* **Permissionless Reads**: Anyone can attempt to read any key, but only the correct decryption key will yield usable data
* **Gossip-Based Replication**: Nodes share data via a simple replication protocol
* **Homogenous Network**: All nodes run the same code and self-organize via a bootstrap mechanism

## Use Cases

* Temporary form submission data
* Anonymous session coordination
* Secure self-expiring messages
* Short-lived tokens and access receipts
* Ephemeral game state or caches

## Deployment Model

* Stateless node containers
* Flux-native autoscaling design
* Works equally well in Kubernetes or Docker

## Future Directions

* Long-term encrypted storage tier
* Integration with IPFS for large object persistence
* Cross-network TTL coordination for compliance scenarios

REPRAM is designed to be a core primitive of next-generation decentralized applications: fast, private, temporary storage that requires no trust and no central control.
