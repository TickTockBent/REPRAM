# REPRAM Roadmap: From Working Network to Civilization Primitive

REPRAM should become a protocol with a living reference network, not a more
featureful storage service. Its small primitive should become precise,
portable, observable, and durable enough that progressively stranger systems
can depend on it.

The roadmap has two horizons:

1. **Terrestrial REPRAM:** a real public network, a stable protocol, and
   applications people can use now.
2. **Deep-time REPRAM:** simulations and protocol extensions for autonomous
   populations operating across generations and light cones.

The terrestrial network is the proving ground. The probe system remains the
design compass.

## 0. Ratify the existing contract

`docs/core-principles.md` is REPRAM's constitution. The README, project
overview, whitepaper, and versioned specifications explain that contract at
different depths; this roadmap does not create a second source of truth.

The initial documentation audit found the foundation sound and identified a
bounded cleanup:

- Define TTL as a local lifecycle: omission defaults to 1800 seconds, explicit
  positive values below 300 seconds normalize to the five-minute propagation
  floor, and an overwrite begins a fresh lifetime.
- Define dynamic quorum accurately: every accepted write is local first;
  `201` means quorum was observed and `202` means it was not confirmed before
  timeout.
- Describe full replication as the target for every reachable enclave member,
  not an absolute delivery guarantee under finite TTL and partitioning.
- Clarify that all nodes run the same software and participate equally in the
  gossip data plane. Omega roots and substrate/transient roles provide
  discovery and reachability, not a privileged replication tier.
- Define node metadata narrowly: only keys and transport/lifecycle fields
  needed to handle the data piece, never application meaning or ownership.
- Distinguish permissionless client access from optional peer-to-peer HMAC.
- Mark the separate gossip-port setting as legacy compatibility metadata;
  current gossip travels over HTTP.
- Update the 2.1 specification from proposal to implemented code with public
  deployment still pending.
- Bring the original whitepaper into line with the current implementation and
  terminology.

Future protocol-versioning and compatibility policy belongs in the normative
protocol work in section 4, not in a new constitution.

### Exit criterion

The canonical principles, user documentation, current implementation, and
versioned specification describe the same system without importing guarantees
REPRAM deliberately does not make.

## Horizon I: Terrestrial REPRAM

## 1. Stabilize the current Go implementation

The current implementation is already substantial. This phase consolidates it
before expanding the network.

### 1.1 Audit quorum semantics

Quorum should mean confirmations from distinct replicas. Review:

- Duplicate ACKs from the same node.
- Late ACKs from completed writes.
- ACKs from nodes outside the enclave.
- ACKs whose sender is not a known replication peer.
- ACK routing through substrates and transient children.
- Quorum changes while a write is in flight.

Likely implementation:

- Replace the confirmation counter with a set of confirming node IDs.
- Seed it with the local node ID.
- Ignore repeated confirmations from the same node.
- Snapshot or clearly define the quorum target at write creation.
- Preserve late-ACK no-op behavior.

This is not an authentication feature. It makes the existing `201 Created`
quorum claim precise.

### 1.2 Codify TTL semantics

Document the actual and intended model:

- TTL begins independently when a replica accepts a value.
- Network-wide expiration is approximate.
- Propagation delay can create bounded differences between replicas.
- Rewriting the same key is a new write with a new lifetime.
- Republished data is new data from REPRAM's perspective.
- Expired values are inaccessible immediately and physically removed during
  cleanup.
- Nodes make no claim that copies outside the node cease to exist.

Add tests for:

- Delayed replication.
- Overwrite close to expiration.
- Expired reads before cleanup.
- Cleanup accounting after expiration.
- Replication arriving after another replica's copy has expired.
- Different clocks between nodes.

Do not add global expiration machinery unless a demonstrated application
requires it.

### 1.3 Review wire validation

The public API clamps TTL and limits request bodies. Internal gossip deserves
an explicit validation policy too. Audit:

- Negative and zero gossip TTLs.
- Values beyond configured local maximums.
- Oversized replicated payloads.
- Invalid or empty message IDs.
- Unknown message types.
- Malformed node addresses and ports.
- Cross-enclave messages.
- Messages claiming to come from the local node.
- Integer conversion and overflow boundaries.

Each node may enforce its own storage and resource limits. Permissionless
participation does not require accepting malformed or unaffordable work.

### 1.4 Lifecycle hardening

Review repeated and concurrent calls to:

- Store close.
- Protocol stop.
- Tree-manager shutdown.
- WebSocket termination.
- HTTP graceful shutdown.
- Omega refresher cancellation.

The desired property is boring idempotence: shutdown remains safe when
multiple failure paths converge.

### 1.5 Reduce assembly pressure in `cmd/repram`

Extract without redesigning:

- Environment and configuration parsing.
- Application construction.
- HTTP server configuration.
- MCP-mode construction.
- Trust and bootstrap construction.
- Shutdown coordination.

The result remains one binary. This makes startup behavior testable; it does
not create an application framework.

### 1.6 Reconcile documentation

Resolve differences between documentation and implementation around:

- On-access invisibility versus physical cleanup.
- Whether expired keys can appear in listings.
- Local TTL versus global expiration.
- What "no logs" means.
- What nodes can and cannot observe.
- The distinction between opaque data and encrypted data.

### Exit criteria

- `go test -race ./...` passes.
- New quorum and TTL semantic tests pass.
- Fuzz tests cover public and gossip message parsing.
- Startup and shutdown are tested as complete application lifecycles.
- No known documentation contradictions remain around core behavior.

## 2. Build a repeatable validation program

REPRAM's operating environment is failure, so failure testing should become a
normal project artifact.

### 2.1 CI layers

Every change:

- Formatting and compilation.
- Unit tests and the race detector.
- Protocol fixture tests.
- Basic HTTP and WebSocket integration tests.

Scheduled:

- Fuzzing.
- Multi-node container scenarios.
- Partition and reconnection tests.
- Longer soak tests.
- Dependency and container scans.

Release candidates:

- Clean-cluster boot.
- Upgrade from the previous version.
- Mixed-version compatibility.
- Root discovery and cache fallback.
- Enclave isolation.
- Substrate loss and transient reattachment.
- Capacity exhaustion and recovery.
- Sustained load.

### 2.2 Chaos scenarios

Create deterministic scenarios for:

- One node disappearing.
- Half the cluster disappearing.
- All known peers disappearing.
- Roots becoming unreachable.
- DNS returning stale or invalid records.
- Slow peers.
- Duplicated and reordered messages.
- Asymmetric partitions.
- A substrate terminating without goodbye.
- Rapid node reproduction and churn.
- Clock offsets.
- Storage saturation.
- A noisy enclave sharing topology with quiet enclaves.

### 2.3 Ramp to failure

Complete the deferred all-Go experiment. Measure:

- Maximum sustained writes and reads.
- Gossip bandwidth.
- Allocation rate.
- Heap and resident memory.
- Goroutine count.
- Propagation latency.
- `201` versus `202` rates.
- Recovery after load stops.
- Performance as enclave size crosses the fanout threshold.
- Behavior at storage capacity.

The objective is not a heroic benchmark number. It is a map of how REPRAM
degrades.

### 2.4 Long soak

Run at least one multi-week cluster with controlled churn:

- Continuous mixed traffic.
- Periodic node replacement.
- Root outages.
- Substrate cycling.
- Version upgrades.
- Metrics and pprof snapshots.
- No manual data cleanup.

Publish the after-action report even if the run is ugly.

### Exit criteria

- Failure scenarios are executable, not prose.
- Degradation modes are understood.
- Resource ceilings have measured ranges.
- The network returns to a stable baseline after faults and load.

## 3. Launch the public alpha network

The public network turns REPRAM from software into a place.

### 3.1 Omega ceremony

Replace the placeholder trust anchor through a documented ceremony:

- Generate the real Ed25519 keypair offline.
- Bake the public key into the release.
- Store redundant offline copies of the private key.
- Document who can sign root lists and under what circumstances.
- Produce and publish the first signed list.
- Test expiry, renewal, corruption, and rotation.
- Document catastrophic key-loss and compromise procedures.

The omega key signs bootstrap information. It must not become general command
authority.

### 3.2 Root deployment

Run multiple roots across independent failure domains:

- Different hosts.
- Preferably different providers or physical sites.
- Independent process supervision.
- Stable advertised addresses.
- Shared protocol version.
- Public health and topology visibility.
- No dependency on one root being continuously available.

A new node should contact all available seeds and form its own peer knowledge
rather than treating a root as a permanent coordinator.

### 3.3 DNS and cache behavior

Validate:

- Fresh DNS startup.
- Startup from unexpired disk cache.
- Root-list refresh.
- DNS outage during normal operation.
- Expired cache plus unavailable DNS.
- Root removal and addition.
- Omega version mismatch.
- Signed-list rollback attempts.

### 3.4 Public operational surface

Publish:

- Network status.
- Current protocol version.
- Root-list expiry.
- Basic topology.
- Release-version distribution.
- Incident notices.
- Join instructions.
- Clear alpha disclaimers.

Do not publish stored keys or values through the public dashboard.

### 3.5 Local resource policy

Define sensible public-node defaults:

- Maximum payload size.
- Maximum storage allocation.
- Request-rate policy.
- Gossip concurrency.
- Peer limits.
- Child attachment limits.
- Maximum ordinary TTL.
- Behavior when full.

These are local survival policies, not user identity or access control.

### Exit criteria

- A fresh binary joins through signed DNS discovery with no manual peers.
- The network survives loss of any single root.
- Nodes recover from total peer isolation.
- The public dashboard accurately reflects reachable topology.
- The network operates for a sustained period without manual intervention.

## 4. Make REPRAM a protocol, not just a Go program

A Von Neumann infrastructure primitive must be reimplementable.

### 4.1 Normative protocol specification

Specify:

- Node and enclave concepts.
- Message envelopes.
- Field types and bounds.
- Canonical HMAC input.
- Bootstrap request and response behavior.
- Gossip PUT and ACK semantics.
- Message deduplication expectations.
- Topology synchronization.
- Fanout behavior.
- WebSocket hello, welcome, goodbye, and gossip frames.
- Substrate and transient attachment.
- Quorum calculation.
- HTTP status meanings.
- TTL behavior.
- Error handling.
- Version negotiation and incompatibility behavior.

Use normative terms such as MUST, SHOULD, and MAY only where interoperability
requires them.

### 4.2 Golden fixtures

Check in fixtures for:

- Every wire-message type.
- Signed and unsigned messages.
- Canonical HMAC examples.
- Boundary TTLs.
- Empty and default enclaves.
- Binary payloads.
- Invalid messages and required rejection behavior.
- WebSocket lifecycle sequences.
- Quorum examples.

### 4.3 Black-box conformance runner

The runner should accept a node command or endpoint and verify:

- HTTP API behavior.
- TTL lifecycle.
- Overwrite semantics.
- Gossip compatibility.
- Signature verification.
- Bootstrap behavior.
- Enclave isolation.
- Quorum response codes.
- WebSocket attachment and relay.
- Shutdown and rejoin.

### 4.4 Second implementation strategy

Do not immediately maintain another full production node. First build either:

- A tiny protocol probe that can speak every wire message; or
- A deliberately minimal reference implementation used only for conformance.

A second full implementation becomes worthwhile when there is an independent
maintainer or deployment need.

### Exit criteria

- A programmer can implement an interoperable node using only the
  specification and fixtures.
- The Go implementation passes the external conformance runner.
- Protocol changes require explicit version and compatibility decisions.

## Horizon II: Applications That Explain the Primitive

## 5. Build chat like speech

Revisit Fade, or build a similarly small reference application.

### Product premise

A room is a temporary place, not a permanent transcript. The infrastructure
forgets the conversation. Participants remain free to remember, copy, or
record it.

### Minimal experience

- Create or join a room through an invite.
- Send messages with visible remaining lifetimes.
- Read only messages that are still alive.
- Allow the room itself to expire.
- No accounts.
- No permanent server-side transcript.
- Optional client-side encryption enabled by room secrets.
- A clear explanation that participants can retain messages.

### Possible REPRAM model

Keep the application protocol above REPRAM:

- A room invite provides a room identifier and encryption material.
- Each message receives its own opaque key.
- A short-lived room manifest points to live message keys.
- The manifest may be overwritten as conversation changes.
- Message payloads contain timestamps and signatures if desired.
- Clients discard expired manifest entries.
- The room survives only while participants continue refreshing its live
  state.

Concurrency may require a small CRDT or branch-and-merge manifest, but that
logic belongs in the chat protocol.

### UX principles

- Avoid presenting disappearance as a security magic trick.
- Make time visible and intuitive.
- Treat expiration as completion, not failure.
- Do not add searchable history.
- Do not add accounts merely for convenience.
- Let silence remove the room.

### Why this matters

This application:

- Makes the philosophy understandable.
- Exercises public-network behavior.
- Provides real browser traffic.
- Tests encryption conventions.
- Reveals whether polling and key listing are sufficient.
- Gives REPRAM an emotionally legible demonstration.

### Exit criterion

Two strangers can open a room, converse, leave, and later find that the
infrastructure has no transcript to serve.

## 6. Deepen the agent interface without becoming an agent platform

The Go-native MCP server is a useful terrestrial adapter.

### Improvements

- Publish precise examples for dead drops, heartbeats, leases, and handoffs.
- Add namespaced key helpers as documentation or client libraries, not server
  semantics.
- Provide encrypted handoff examples.
- Show how agents interpret absence correctly.
- Dogfood REPRAM across real multi-agent work.
- Measure which coordination patterns fail under overwrite races or delayed
  observation.
- Keep the MCP tool surface small.

### Explicit non-goals

- Agent identity.
- Workflow orchestration.
- Durable task queues.
- Server-side schemas.
- Server-side JSON operations.
- Semantic search.
- Agent history.
- Reliable notification.

### Exit criterion

Independent agents can use REPRAM for coordination without REPRAM knowing
what a task, agent, message, or workflow is.

## Horizon III: The Probe Laboratory

## 7. Build a discrete-event Von Neumann probe simulator

This should be a separate project or package that consumes a model of REPRAM.
It should not complicate the production node.

### 7.1 World model

Represent:

- Star systems or arbitrary spatial sites.
- Distances and communication delays.
- Probe velocity.
- Communication range and windows.
- Probe mortality.
- Dormancy.
- Replication time and resource cost.
- Descendant lineages.
- Local storage and bandwidth constraints.
- Regional enclaves.
- Physical message transport.
- Clock disagreement.

The simulation should have no global operational clock visible to probes,
even if the simulator uses one internally.

### 7.2 REPRAM model

Simulate:

- Local stores.
- TTL expiration.
- Gossip replication.
- Peer discovery.
- Enclave membership.
- Partitions.
- Topology aging.
- Signpost refresh.
- Storage exhaustion.
- Protocol-version differences.
- Lost, duplicated, delayed, and reordered messages.

Begin with the existing protocol's behavior. Add hypothetical versions only
as explicit experiments.

### 7.3 Signpost protocol

Define the first probe-specific protocol above REPRAM. A signpost payload
might contain:

- Subject or location identifier.
- Observation.
- Observation time according to the signer.
- Validity recommendation.
- Previous manifest hash.
- Known routes.
- Resource estimates.
- Hazards.
- Protocol versions understood.
- Signer lineage.
- Signature chain.
- References to larger payloads.
- Refresh history.

Visitors may:

1. Retrieve the signpost.
2. Validate whatever signatures they recognize.
3. Add observations or attestations.
4. Resolve conflicting branches using their own policy.
5. Rewrite the signpost with a fresh TTL.
6. Carry pointers onward.

REPRAM treats the result as bytes.

### 7.4 Experiments

Run experiments such as:

- How long does useful information survive without central maintenance?
- What refresh TTL balances relevance against loss?
- How does information move relative to the expansion frontier?
- When do lineages lose contact permanently?
- How often do incompatible protocol cultures emerge?
- How much stale information survives?
- How do malicious or defective lineages affect local knowledge?
- Can signature diversity help probes judge signposts?
- What topology knowledge is affordable?
- When must enclaves divide?
- How much bandwidth does refresh-based tradition consume?
- Which facts become permanent through repeated rediscovery?
- Which facts vanish even though their origin considered them important?

### 7.5 Visualization

Visualize:

- Probe expansion.
- Communication light cones.
- Enclave formation.
- Signpost lifetimes.
- Information refresh events.
- Protocol forks.
- Lineage trust.
- Knowledge fading at the edges.
- Regions that become causally disconnected.

This may become the project's most compelling explanation: viewers can watch
information survive because successive machines choose to carry it.

### Exit criterion

The simulator produces repeatable findings that influence, but do not
automatically enter, the production protocol.

## 8. Research long-horizon protocol limits

The simulator will eventually expose assumptions that are harmless
terrestrially but unsuitable over centuries.

### 8.1 Long TTL representation

The current wire TTL is limited by its integer representation, and Go's
`time.Duration` also has a finite range. Investigate:

- Wider integer TTL seconds.
- Protocol-versioned duration encoding.
- Locally supported maximums.
- Saturating behavior.
- Extremely long sleeping periods.
- Whether a signpost should use repeated shorter renewal periods rather than
  a single millennial TTL.

Do not use a global absolute expiration timestamp unless an application truly
needs shared wall-clock semantics.

### 8.2 Topology scaling

A galactic population cannot maintain a global peer list. Likely evolution:

- Local neighbor topology only.
- Regional enclaves.
- Bounded topology horizons.
- Explicit expiry of peer knowledge.
- Signpost pointers to distant regions.
- Opportunistic bridge probes.
- Summaries rather than individual node lists.
- No assumption that every node can learn that every other node exists.

### 8.3 Store and carry

At great distance, probes themselves become the transport. Explore a
higher-level protocol for:

- Carrying selected signposts between disconnected enclaves.
- Preserving origin signatures.
- Applying a new local TTL when imported.
- Indicating observation age separately from storage lifetime.
- Forwarding summaries under bandwidth constraints.
- Preventing one region's ancient state from overwhelming another.

This belongs above local REPRAM gossip.

### 8.4 Protocol evolution

Descendants will modify their software. Research:

- Multiple supported wire versions.
- Capability advertisement.
- Signed protocol descriptions.
- Translation gateways.
- Graceful treatment of unknown message types.
- Lineages that intentionally diverge.
- Minimal invariants that must survive for something still to be called
  REPRAM.

The goal is not eternal backward compatibility. It is legible evolution.

### 8.5 Trust evolution

Omega works for bootstrapping a terrestrial public network. It should not
become a permanent galactic monarch. Explore, above the core:

- Ancestral trust anchors.
- Multiple lineage roots.
- Delegated protocol-signing keys.
- Trust learned through repeated encounters.
- Signature diversity on signposts.
- Locally chosen trust policy.
- Recovery after a lineage key is lost or compromised.

REPRAM itself should continue accepting opaque values regardless of which
trust system produced them.

## Project stewardship

## 9. Release discipline

Use clear release categories:

- Patch: implementation fixes with unchanged wire behavior.
- Minor: backward-compatible features or optional messages.
- Major: wire or semantic incompatibility.

Every release should include:

- Protocol compatibility statement.
- Migration notes.
- Configuration changes.
- Conformance results.
- Burn-in or scenario-test results.
- Known limitations.
- Updated container image.
- Reproducible build information.

## 10. Preserve the archaeology

The project's history is useful evidence. Keep:

- Burn-in reports.
- Failure reports.
- Rejected designs.
- Compatibility fixtures.
- Protocol versions.
- Removed implementation notes.
- Major architectural decisions.

Do not preserve actual REPRAM payloads. Preserve what was learned about the
machinery.

## 11. Explain the premise at three depths

### Thirty seconds

> REPRAM is shared temporary memory. Store bytes under a key; they replicate
> and disappear automatically.

### Five minutes

> REPRAM is a permissionless coordination primitive for systems that need
> current state without permanent institutional memory.

### Full depth

> REPRAM is an experiment in infrastructure for self-replicating autonomous
> machines operating without a shared present, stable membership, or central
> authority.

The probe premise should be published. It makes the architecture intelligible
without needing to dominate the quick start.

## Suggested execution order

### Milestone A: Semantic foundation

- Constitution.
- TTL contract.
- Quorum audit.
- Wire validation.
- Documentation reconciliation.
- Lifecycle hardening.

### Milestone B: Evidence

- Expanded CI.
- Chaos scenarios.
- Ramp to failure.
- Long soak.
- Published after-action report.

### Milestone C: Public alpha

- Real omega key.
- Independent roots.
- Signed DNS discovery.
- Dashboard and status page.
- Operator documentation.
- Public join instructions.

### Milestone D: Protocol independence

- Normative specification.
- Golden fixtures.
- Conformance runner.
- Versioning and compatibility policy.

### Milestone E: Human demonstration

- Ephemeral encrypted chat.
- Public deployment.
- Dogfooding and usability study.

### Milestone F: Probe laboratory

- Discrete-event simulator.
- Signpost protocol.
- Light-cone visualization.
- Published experiments.

### Milestone G: REPRAM 3 research

Only after simulation and public-network evidence:

- Long TTL wire format.
- Bounded regional topology.
- Store-and-carry conventions.
- Protocol evolution mechanisms.
- Lineage-aware trust above the core.

## Success criteria

REPRAM succeeds if:

- The public network runs without a permanent coordinator.
- Nodes can disappear and return without reconciliation drama.
- Storage remains bounded under sustained use.
- Implementations agree on the small protocol.
- Useful applications can be built without changing the server.
- Participants understand that confidentiality is their responsibility.
- The chat room feels like speech rather than publishing.
- The simulator demonstrates coordination through causal traces rather than
  global state.
- Future features continue to be rejected when they belong in payloads.
- Someone could reproduce the protocol after the current implementation and
  its author are gone.

The final test is deliberately severe:

> Could a descendant receive only the REPRAM specification, implement it in
> an unfamiliar environment, encounter an unknown peer, exchange temporary
> knowledge, and then forget it correctly?

Everything between here and there is refinement.
