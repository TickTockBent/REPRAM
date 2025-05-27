# Project Overview: REPRAM (REplicated EPhemeral RAM)

## Summary

REPRAM is a distributed, ephemeral key-value storage network designed for high-performance, privacy-preserving applications. It provides a permissionless interface for encrypted, self-expiring data storage with zero trust assumptions. All nodes in the network are equal, and no node can read or interpret user data. The system is optimized for ease of deployment on decentralized compute networks like Flux but is platform-agnostic and compatible with Kubernetes, Docker Swarm, or bare-metal clusters.

## Key Features

* Encrypted client-side data storage
* Time-to-live (TTL) enforced automatic data expiration
* Symmetric node architecture with no central coordinator
* Gossip-based data replication with quorum confirmation
* Stateless, low-resource node design
* Zero knowledge of content or user identity by the network
* Permissionless reads secured by cryptographic access

## Architecture

* **Client SDK**: Generates ultra-unique encrypted keys and payloads, handles write propagation and confirmation, decrypts on read
* **Node Daemon**: Accepts writes, replicates via gossip, stores encrypted blobs in memory, schedules TTL expiration
* **Bootstrap Layer**: Core node list for network discovery, defined at runtime; all nodes run the same software
* **Gossip Network**: Peer-to-peer message propagation and quorum acknowledgement
* **Optional Persistence**: FluxDrive or local disk snapshot riders for advanced deployments

## Technology Stack

* **Language**: Rust or Go (TBD, optimized for speed and concurrency)
* **Runtime**: Docker containers, Flux-native deployment with autoscaling support
* **Transport**: gRPC or custom lightweight protocol over TCP/UDP
* **Storage**: In-memory TTL heap, optionally backed by ephemeral disk
* **Encryption**: NaCl or AES-based client-side encryption, keypair-authenticated writes
* **Discovery**: Static bootstrap list with peer gossip
* **Monitoring**: Healthcheck endpoints, optional metrics via Prometheus-style exporter

## Future Extensions

* Long-term storage layer with paid persistence
* Optional IPFS-backed blob layer for large file offloading
* Reputation scoring for node reliability and uptime
* Web3-native authentication bridges

REPRAM is designed to serve as the short-term memory of decentralized applications, enabling trustless coordination, secure ephemeral messaging, and frictionless state sync across distributed systems.
