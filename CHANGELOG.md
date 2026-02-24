# Changelog

All notable changes to REPRAM are documented here.

## [Unreleased]

### Added
- `docs/patterns.md` — full usage pattern catalog (agent patterns + general-purpose primitives)
- "Beyond Agents" patterns: circuit breaker, ephemeral broadcast, secure relay, session continuity, distributed deduplication, ephemeral pub/sub
- Heartbeat/presence and state machine agent patterns across all documentation
- `CLAUDE.md` project context file

### Changed
- README links to `docs/patterns.md` instead of inlining the full pattern catalog
- Website uses a single-line teaser for general-purpose patterns instead of a second grid

## [2.0.0] — 2025-12-19

v2 is a ground-up rearchitecture. The multi-binary, SDK-dependent, Kubernetes-oriented codebase was replaced with a single Go binary, gossip replication over HTTP, and an MCP server as the primary agent interface. ~21,000 lines of code were removed; ~1,400 were added.

### Added
- **MCP server** (`repram-mcp/`) — TypeScript MCP server exposing `repram_store`, `repram_retrieve`, `repram_list_keys` tools for AI agent integration via Claude Code, Cursor, etc.
- **Unified binary** (`cmd/repram/`) — single Go entry point replacing `cmd/node/`, `cmd/cluster-node/`, `cmd/example/`
- **Versioned API** — all routes under `/v1/` (`/v1/data/{key}`, `/v1/keys`, `/v1/health`, `/v1/status`, `/v1/metrics`, `/v1/gossip/message`, `/v1/bootstrap`)
- `REPRAM_ADDRESS` env var (replaces `NODE_ADDRESS`)
- `REPRAM_PEERS` port convention documented — peers are HTTP addresses (`host:httpPort`)
- DNS-based bootstrap for public network discovery (`REPRAM_NETWORK=public`)
- Private network mode (`REPRAM_NETWORK=private`) for isolated clusters
- Docker Compose 3-node cluster configuration for development
- `docs/patterns.md` — comprehensive usage pattern catalog

### Changed
- **Messaging overhaul** — "privacy through transience" replaces "zero-trust" across all documentation; dead drop is the primary metaphor; "zero-knowledge nodes" is the consistent term
- **Security framing** — reframed as a natural consequence of ephemerality, not a bolted-on posture. "Nodes hold nothing of lasting value" and "hostile infrastructure is irrelevant" replace "nodes are untrusted" and "hostile network assumption"
- **Resilience framing** — "resilience through ephemerality" articulated: nodes don't need tight coupling because the data lifecycle is self-limiting. No catch-up problem, no split-brain
- README completely rewritten for agent-focused messaging and quick start
- Website (`web/index.html`, `web/script.js`) rewritten with agent-focused content; hackerpunk CSS preserved
- `docs/whitepaper.md` rewritten with dead drop framing, "What REPRAM Is Not" section, deployment model
- `docs/core-principles.md` updated: removed SDK encryption references, removed unimplemented compliance section, added "Resilience Through Ephemerality" (4.3), reframed security principles (5.1)
- `docs/project-overview.md` rewritten with agent coordination angle, MCP server as primary interface
- Gossip internal paths updated to match versioned routes (`/v1/bootstrap`, `/v1/gossip/message`)

### Removed
- `cmd/node/`, `cmd/cluster-node/`, `cmd/example/` — replaced by unified `cmd/repram/`
- `cmd/discovery-demo/` — empty directory
- `demos/fade/` — FADE ephemeral message board demo
- `demos/synth-tree/` — Synth-Tree discovery protocol demo
- `web/synth-tree/` — embedded Synth-Tree visualization
- `deployment/` — Discord bridge, GCP configs, Flux/Kubernetes deployment files
- `docs/future/` — speculative pre-v2 discovery protocol designs
- `DEPLOYMENT_STATUS.md`, `STRATEGIC_SHIFT_SUMMARY.md`
- Legacy unversioned routes (`/gossip/message`, `/bootstrap`)
- All "Proprietary SDK" / "Commercial License" / dual licensing language
- `web/node_modules/` removed from git tracking (3.6MB of vendored deps)
- Dead synth-tree route from `web/vercel.json`

### Fixed
- Gossip bootstrap and message propagation used legacy unversioned paths after route migration — nodes couldn't communicate
- `zod` added as direct dependency in `repram-mcp` (was only a transitive dep of `@modelcontextprotocol/sdk`)

### Known Issues
- `MemoryStore.Get()` deletes under read lock — data race ([#8](https://github.com/TickTockBent/repram/issues/8))
- Suspicious request filter false-positives on valid keys ([#9](https://github.com/TickTockBent/repram/issues/9))
- `MemoryStore` returns mutable references to internal data ([#10](https://github.com/TickTockBent/repram/issues/10))
- No capacity limit on `MemoryStore` ([#20](https://github.com/TickTockBent/repram/issues/20))
- Write quorum timeout too aggressive at 2s ([#21](https://github.com/TickTockBent/repram/issues/21))
- No TLS on gossip transport ([#22](https://github.com/TickTockBent/repram/issues/22))
- Docker image not published to Docker Hub ([#23](https://github.com/TickTockBent/repram/issues/23))
- `CONTRIBUTING.md` has placeholder URLs ([#24](https://github.com/TickTockBent/repram/issues/24))
