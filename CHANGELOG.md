# Changelog

All notable changes to REPRAM are documented here.

## [Unreleased]

### Added
- **Peer failure detection** — evicts peers after 3 consecutive failed health checks (~90s); peers rejoin automatically via bootstrap ([#25](https://github.com/TickTockBent/repram/issues/25))
- **Peer eviction metrics** — four Prometheus metrics for cluster health: `repram_peers_active` (gauge), `repram_peer_evictions_total`, `repram_peer_joins_total`, `repram_ping_failures_total` (counters) ([#28](https://github.com/TickTockBent/repram/issues/28))
- **Probabilistic gossip fanout** — enclaves with >10 peers switch from full broadcast O(N) to √N random fanout per hop with epidemic forwarding and message deduplication ([#31](https://github.com/TickTockBent/repram/issues/31))
- **Topology sync peer propagation** — SYNC responses now include the responder's full peer list, enabling transitive peer discovery after partitions and node churn ([#36](https://github.com/TickTockBent/repram/issues/36))
- **Bounded dedup cache** — `seenMessages` capped at 100k entries; evicts expired then oldest half on overflow ([#37](https://github.com/TickTockBent/repram/issues/37))
- **Enclave-scoped replication** — `REPRAM_ENCLAVE` env var defines replication boundaries; nodes in the same enclave replicate data, all nodes share topology; dynamic quorum based on enclave size
- `/v1/topology` endpoint — returns full peer list with enclave membership
- `REPRAM_TRUST_PROXY` env var — proxy headers (`X-Forwarded-For`, `X-Real-IP`) now ignored by default; set to `true` when behind a reverse proxy ([#30](https://github.com/TickTockBent/repram/issues/30))
- `docs/patterns.md` — full usage pattern catalog (agent patterns + general-purpose primitives + key naming conventions)
- `docs/encryption-example.md` — client-side AES-256-GCM example with opaque key derivation ([#18](https://github.com/TickTockBent/repram/issues/18))
- Heartbeat/presence and state machine agent patterns across all documentation
- "Beyond Agents" general-purpose patterns: circuit breaker, ephemeral broadcast, secure relay, session continuity, distributed deduplication, ephemeral pub/sub
- Key naming conventions: namespace prefixes, key generation strategies, prefix listing, collision avoidance ([#17](https://github.com/TickTockBent/repram/issues/17))
- `repram_exists` MCP tool — lightweight HEAD-based existence check with remaining TTL, avoids transferring payload ([#14](https://github.com/TickTockBent/repram/issues/14))
- `REPRAM_WRITE_TIMEOUT` env var — configurable quorum timeout, default 5s (was hard-coded 2s) ([#21](https://github.com/TickTockBent/repram/issues/21))
- `REPRAM_CLUSTER_SECRET` env var — HMAC-SHA256 authentication for gossip and bootstrap messages ([#22](https://github.com/TickTockBent/repram/issues/22))
- `REPRAM_MAX_STORAGE_MB` env var — configurable capacity limit, returns HTTP 507 when full ([#20](https://github.com/TickTockBent/repram/issues/20))
- `REPRAM_LOG_LEVEL` env var — leveled logging (debug/info/warn/error), replaces raw fmt.Printf ([#12](https://github.com/TickTockBent/repram/issues/12))
- **Integration tests** — 7 in-process tests with real HTTP transport: bootstrap discovery, write replication, quorum confirmation, enclave isolation, quorum timeout, 3-node topology, 3-node replication ([#26](https://github.com/TickTockBent/repram/issues/26))
- Test suite: 63 tests covering storage, middleware, gossip auth, peer failure detection, eviction metrics, proxy trust, gossip fanout, topology sync, and distributed integration ([#11](https://github.com/TickTockBent/repram/issues/11), [#26](https://github.com/TickTockBent/repram/issues/26), [#28](https://github.com/TickTockBent/repram/issues/28), [#31](https://github.com/TickTockBent/repram/issues/31), [#36](https://github.com/TickTockBent/repram/issues/36))
- CI test workflow — runs `make build` + `go test -race` on push to main and PRs
- CI npm publish workflow — publishes `repram-mcp` to npm on `mcp-v*` tags ([#13](https://github.com/TickTockBent/repram/issues/13))
- `workflow_dispatch` trigger on Docker build workflow
- "Design Decisions: No DELETE" section in whitepaper — documents rationale for TTL-only lifecycle ([#19](https://github.com/TickTockBent/repram/issues/19))

### Changed
- Docker image published as `ticktockbent/repram-node` (was `repram/node`) ([#23](https://github.com/TickTockBent/repram/issues/23))
- `repram-mcp` published to npm — `npx repram-mcp` now works; current version 1.1.0
- Quorum timeout returns 202 Accepted (stored locally, replication pending) instead of 500 ([#21](https://github.com/TickTockBent/repram/issues/21))
- HEAD requests supported on `/v1/data/{key}` for lightweight existence checks
- Rate limiter no longer trusts `X-Forwarded-For` / `X-Real-IP` by default — requires `REPRAM_TRUST_PROXY=true` ([#30](https://github.com/TickTockBent/repram/issues/30))
- Message IDs use atomic counter suffix to prevent theoretical same-nanosecond collisions ([#29](https://github.com/TickTockBent/repram/issues/29))
- Docker Compose uses `condition: service_healthy` for proper startup ordering; ports remapped to 8091-8093
- README links to `docs/patterns.md` instead of inlining the full pattern catalog
- Website uses a single-line teaser for general-purpose patterns instead of a second grid
- CONTRIBUTING.md placeholder URLs replaced with actual GitHub links ([#24](https://github.com/TickTockBent/repram/issues/24))
- Updated `google.golang.org/protobuf` to v1.36.6 (CVE fix, Dependabot alert #11)
- Documented `/v1/keys` cleanup granularity — listings may include keys up to 30s past TTL; direct GET always enforces TTL precisely ([#27](https://github.com/TickTockBent/repram/issues/27))

### Fixed
- **Graceful shutdown** — signal handler now calls `server.Shutdown()` with 10s drain timeout instead of `os.Exit(0)`; in-flight requests complete before process exits ([#33](https://github.com/TickTockBent/repram/issues/33))
- **Quorum tracking for concurrent writes** — `pendingWrites` map keyed on message ID instead of data key; concurrent writes to the same key now track quorum independently ([#34](https://github.com/TickTockBent/repram/issues/34))
- **Request body size enforcement** — `MaxRequestSizeMiddleware` (with `http.MaxBytesReader`) wired into router; previously only `ContentLength` header was checked, which clients could omit ([#35](https://github.com/TickTockBent/repram/issues/35))
- **CORS policy documented** — README now explicitly states that any origin is accepted by design, consistent with permissionless access model ([#38](https://github.com/TickTockBent/repram/issues/38))
- **MemoryStore.Get() data race** — removed `delete()` under read lock; expired entries now returned as not-found, cleaned up by background worker ([#8](https://github.com/TickTockBent/repram/issues/8))
- **MemoryStore returns mutable references** — Get/GetWithMetadata return byte slice copies; Put copies input ([#10](https://github.com/TickTockBent/repram/issues/10))
- **Suspicious request filter false-positives** — removed `python-requests` from blocked UAs; removed URL pattern matching that blocked legitimate keys containing words like `select`, `delete`, `drop` ([#9](https://github.com/TickTockBent/repram/issues/9))
- **Unbounded memory growth** — MemoryStore now enforces configurable capacity limit with proper size tracking through overwrites and expiration ([#20](https://github.com/TickTockBent/repram/issues/20))
- **Dead peers degrade write latency** — peers now evicted after 3 consecutive failed pings; gossip broadcasts no longer accumulate timeouts against unreachable nodes ([#25](https://github.com/TickTockBent/repram/issues/25))
- **Docker Compose bootstrap race** — nodes now wait for dependencies to pass healthchecks before starting

### Removed
- GitHub Pages deployment workflow (site is hosted on Vercel)
- Docker Scout security scan step (requires subscription)

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
