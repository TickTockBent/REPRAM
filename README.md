# REPRAM

[![CI](https://github.com/TickTockBent/REPRAM/actions/workflows/test.yml/badge.svg)](https://github.com/TickTockBent/REPRAM/actions/workflows/test.yml)
[![Docker](https://github.com/TickTockBent/REPRAM/actions/workflows/docker-build.yml/badge.svg)](https://github.com/TickTockBent/REPRAM/actions/workflows/docker-build.yml)
[![npm](https://img.shields.io/npm/v/repram-mcp)](https://www.npmjs.com/package/repram-mcp)
[![Docker Image](https://img.shields.io/docker/v/ticktockbent/repram-node?label=docker)](https://hub.docker.com/r/ticktockbent/repram-node)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**Ephemeral Coordination Layer for the Agent Web**

REPRAM is a distributed network where data self-destructs on a timer. Agents leave data, other agents pick it up, and the network cleans itself. Nobody signs a guest book.

Think of it as a dead drop network: you store a payload under a key with a time-to-live, and anyone who knows the key can retrieve it — until the TTL expires and the data is permanently, irreversibly gone. No accounts. No authentication. No logs. The network doesn't know or care what you stored.

**REPRAM is not a database.** It's not a message queue. It's not a secrets manager. It will not keep your data safe — it will *destroy* your data, on schedule, and that's the entire point. Privacy through transience: the network is safe to use because it forgets everything.

## Quick Start

Run a node:
bash
docker run -p 8080:8080 -p 9090:9090 ticktockbent/repram-node

Give an agent access (MCP config for Claude Code, Cursor, etc.):

{
  "mcpServers": {
    "repram": {
      "command": "npx",
      "args": ["repram-mcp"]
    }
  }
}

That's it — `repram-mcp` v2.0 includes an embedded REPRAM node. No separate server needed. The agent gets `repram_store`, `repram_retrieve`, `repram_exists`, and `repram_list_keys` tools immediately.

To connect to an existing node instead (e.g. the Docker node above), add "env": { "REPRAM_URL": "http://localhost:8080" } to the config.

Store data manually:
bash
curl -X PUT -H "X-TTL: 300" -d "hello" http://localhost:8080/v1/data/mykey

Retrieve it:
bash
curl http://localhost:8080/v1/data/mykey


## Private Network

To run a local cluster for testing before joining the public network:
bash
# Set REPRAM_NETWORK=private to disable DNS-based peer discovery
docker run -p 8080:8080 -p 9090:9090 -e REPRAM_NETWORK=private ticktockbent/repram-node

Or spin up a 3-node cluster with docker compose:
bash
docker compose up --build
# Nodes available at localhost:8091, :8092, :8093

The included `docker-compose.yml` configures three nodes with gossip replication in a private network — useful for development and integration testing.

## Omega Operations

When using dnsmasq for publishing, note that sending SIGHUP to dnsmasq does not reload `txt-record` entries. To reload these entries, a full restart of the dnsmasq service is required, for example, using `sudo systemctl restart dnsmasq`. This is a crucial consideration for any dnsmasq-based publishing setup.

## How It Works

REPRAM is a network of identical nodes that store key-value pairs in memory and replicate them via gossip protocol. Two implementations exist — a Go binary (`cmd/repram/`) and a TypeScript
