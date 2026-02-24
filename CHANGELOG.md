# Changelog

All notable changes to REPRAM are documented here.

## [Unreleased]

### Added
- `docs/patterns.md` — full usage pattern catalog (agent patterns + general-purpose primitives)
- Heartbeat/presence and state machine agent patterns across all documentation
- "Beyond Agents" general-purpose patterns: circuit breaker, ephemeral broadcast, secure relay, session continuity, distributed deduplication, ephemeral pub/sub
- `REPRAM_MAX_STORAGE_MB` env var — configurable capacity limit, returns HTTP 507 when full
- `REPRAM_LOG_LEVEL` env var — leveled logging (debug/info/warn/error), replaces raw fmt.Printf
- Test suite: 32 tests covering storage (CRUD, TTL, copy safety, capacity, concurrency with race detector) and middleware (scanner blocking, client passthrough, rate limiter, IP extraction)
- CI test workflow — runs `make build` + `go test -race` on push to main and PRs
- CI npm publish workflow — publishes `repram-mcp` to npm on `mcp-v*` tags
- `workflow_dispatch` trigger on Docker build workflow

### Changed
- Docker image published as `ticktockbent/repram-node` (was `repram/node`)
- `repram-mcp` published to npm as `repram-mcp@1.0.0` — `npx repram-mcp` now works
- README links to `docs/patterns.md` instead of inlining the full pattern catalog
- Website uses a single-line teaser for general-purpose patterns instead of a second grid
- CONTRIBUTING.md placeholder URLs replaced with actual GitHub links

### Fixed
- **MemoryStore.Get() data race** — removed `delete()` under read lock; expired entries now returned as not-found, cleaned up by background worker ([#8](https://github.com/TickTockBent/repram/issues/8))
- **MemoryStore returns mutable references** — Get/GetWithMetadata return byte slice copies; Put copies input ([#10](https://github.com/TickTockBent/repram/issues/10))
- **Suspicious request filter false-positives** — removed `python-requests` from blocked UAs; removed URL pattern matching that blocked legitimate keys containing words like `select`, `delete`, `drop` ([#9](https://github.com/TickTockBent/repram/issues/9))
- **Unbounded memory growth** — MemoryStore now enforces configurable capacity limit with proper size tracking through overwrites and expiration ([#20](https://github.com/TickTockBent/repram/issues/20))

### Removed
- GitHub Pages deployment workflow (site is hosted on Vercel)
- Docker Scout security scan step (requires subscription)

### Known Issues
- Write quorum timeout too aggressive at 2s ([#21](https://github.com/TickTockBent/repram/issues/21))
- No TLS on gossip transport ([#22](https://github.com/TickTockBent/repram/issues/22))

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
