# REPRAM Whitepaper

## Abstract

REPRAM is a permissionless coordination substrate for information that should
exist temporarily. A client stores opaque bytes under a key with a mandatory
time-to-live (TTL). Nodes replicate the data piece within an enclave, serve it
while it remains live, and automatically forget it afterward.

The system deliberately does not provide accounts, key ownership, durable
delivery, historical retrieval, server-side interpretation, or payload
confidentiality. Applications that need encryption, signatures, identity,
merge rules, or provenance implement them inside the opaque value.

REPRAM is `pipe`, not `grep`: a small transport and lifecycle primitive from
which dead drops, heartbeats, coordination tokens, ephemeral chat, agent
handoffs, and much longer-horizon protocols can be composed.

## 1. Premise

Most infrastructure treats persistence as success. Databases retain records,
queues retain unconsumed messages, logs retain history, and caches treat
expiration as an eviction policy added to otherwise durable semantics. Systems
then need cleanup jobs, retention rules, deletion workflows, and decisions
about which stale state still matters.

REPRAM begins from the opposite premise: some information is useful only while
it is current. Its disappearance is not data loss; it is completion of the
information's lifecycle.

This matters immediately for agents and people. Intermediate work, handoffs,
presence, conversation, and coordination state often should not become a
permanent institutional record. It matters even more for autonomous systems
operating with unstable membership, intermittent communication, bounded local
resources, and no dependable central service. In that environment, immortal
stale state can be more dangerous than missing state.

## 2. The Primitive

The client-visible data model is deliberately small:

```
PUT(key, value, ttl)
GET(key)
HEAD(key)
LIST(prefix)
```

Every accepted data piece has:

- An opaque key.
- An opaque byte value.
- Local creation time.
- A mandatory TTL.
- Local expiration time.

The lifecycle is:

1. A node accepts a PUT and stores the bytes locally.
2. It gossips the data piece to reachable members of the same enclave.
3. Each accepting replica begins its own local TTL.
4. Reads and listings stop exposing the piece at local expiration.
5. A periodic sweep reclaims the now-invisible entry from memory.

There is no DELETE operation. An overwrite is a new PUT: it replaces the local
value and begins a fresh TTL. REPRAM does not distinguish an original writer
from any later writer and assigns no ownership to a key.

### 2.1 TTL policy

If a client omits TTL, the reference implementation uses 1800 seconds (30
minutes). If a client provides a positive value below 300 seconds, the node
accepts the request and normalizes it to the five-minute propagation floor.
Operators may configure a stricter local floor and a lower maximum than the
default 24 hours.

TTL is local lifecycle information, not a globally synchronized deletion
deadline. Replicas may accept the same write at slightly different times and
therefore expire it at slightly different times. The system promises that each
node forgets its accepted copy; it does not make clients, observers, or other
systems forget bytes they retained.

## 3. Architecture

The reference implementation is a single Go binary. The same binary can run as
a long-lived HTTP node or as an MCP stdio server with an embedded node.

Its principal components are:

- **Memory store:** concurrent key-value storage with TTL enforcement and an
  optional payload-byte capacity limit.
- **HTTP API:** client PUT, GET, HEAD, listing, health, status, topology, and
  metrics endpoints.
- **Gossip protocol:** peer discovery, health checking, topology exchange,
  enclave-scoped replication, acknowledgement, and message deduplication.
- **Omega discovery:** Ed25519 verification of DNS-published public root lists
  plus a local cache and periodic refresh.
- **Reachability tree:** WebSocket attachment between inbound-capable
  substrates and outbound-only transients.
- **MCP adapter:** four tools for storing, retrieving, checking, and listing
  ephemeral data without a separate daemon.

### 3.1 Equal nodes and unequal reachability

Every node runs the same software and participates in the same gossip data
plane. REPRAM has no master replica, primary data owner, shard coordinator, or
node class that receives writes before "lesser" nodes.

Some nodes nevertheless have different network capabilities:

- A **public root** is listed in the omega-signed bootstrap record and answers
  bootstrap requests.
- A **substrate** accepts inbound WebSocket attachments.
- A **transient** attaches outbound when it cannot or should not accept inbound
  connections.

These are discovery and transport roles, not a data hierarchy. Roots do not
approve client operations. Substrates do not interpret or own child data.

### 3.2 Enclaves

An enclave is a replication boundary. Nodes in the same enclave gossip values
to one another. Nodes in different enclaves may share topology but do not
replicate application data across that boundary.

REPRAM does not shard data within an enclave. Every reachable enclave member is
a replication target. This is a full-replication architecture, not an absolute
delivery guarantee: finite TTL, partitions, process failure, and lossy networks
can prevent a particular member from ever receiving a particular value.

## 4. Gossip and Replication

Small enclaves use full broadcast. When the peer count exceeds the fanout
threshold, the origin sends to approximately the square root of known enclave
peers. Recipients continue epidemic forwarding to their own random subsets.
A bounded message-ID cache suppresses repeat processing.

This gives overwhelmingly likely propagation in a healthy connected enclave
without requiring every origin to perform O(N) direct sends. It intentionally
does not turn probabilistic delivery into a universal claim.

There is no durable replication queue and no payload anti-entropy pass when a
node rejoins. A node that was absent may simply have missed values that are no
longer relevant. Current information reaches it through later ordinary writes.

### 4.1 Dynamic quorum

Every accepted client write is stored locally first. The effective replication
population is:

```
effective = min(current enclave node count, configured replication factor)
quorum    = floor(effective / 2) + 1
```

The local write counts as one confirmation. A single-node enclave therefore
has a quorum of one.

For the HTTP API:

- `201 Created` means the value was stored locally and the node observed its
  dynamic quorum within the write timeout.
- `202 Accepted` means the value was stored locally but quorum was not
  confirmed before the timeout.

`202` is not a failure of the local write, nor is it a promise that a specific
remote node has accepted the value. Replicas already reached keep their copies;
other members may or may not receive the write through the active gossip path.

The MCP adapter exposes the same distinction as `quorum_status: confirmed` or
`quorum_status: pending`.

## 5. Consistency and Same-Key Writes

REPRAM has overwrite semantics, not an ownership or transaction model. The
current v2 protocol does not compare write timestamps, elect an authoritative
writer, or merge competing values.

At each node, the last PUT delivered to that node wins locally. Consequently:

- Two connected nodes writing different values concurrently can observe the
  writes in different orders and temporarily retain different values.
- Two sides of a partition can overwrite the same key independently.
- Healing the topology does not trigger historical payload reconciliation.
- A later write reaching both sides, or expiration of both values, removes the
  disagreement naturally.

The wire timestamp is informational in current v2 handling; it is not a
last-write-wins ordering field. Applications that require causal ordering,
multi-value registers, signed histories, or CRDT merge behavior put those
rules inside their values and key conventions.

This is not classical convergence through an authoritative final record.
REPRAM's resilience is that disagreement does not become an immortal history
the network must repair.

## 6. Discovery and Reachability

### 6.1 Public discovery

Public nodes discover bootstrap roots through DNS TXT records. The root list is
signed offline with the omega Ed25519 key and verified against a public key
compiled into the binary. Nodes cache only verified, unexpired lists and
refresh them before expiration.

Root status is self-recognized from the current signed list. There is no root
configuration flag and no separate root binary. A root answers bootstrap
requests; a non-root returns 403. Once bootstrap completes, ordinary peer
gossip does not depend on a root remaining online.

The current source contains a placeholder omega public key. The code path and
operator tooling are implemented, but the public network is not activated
until the real offline key ceremony, root deployment, and DNS publication are
complete.

### 6.2 Private discovery

Private networks bypass omega and use operator-supplied `REPRAM_PEERS`. They
retain the same data-plane behavior and may optionally configure a shared
cluster secret.

### 6.3 Substrates and transients

Transient nodes maintain outbound WebSocket attachments to substrates.
Substrates relay child PUTs, route acknowledgements back to their origin, and
broadcast enclave-matched replicas to attached children. On disconnection, a
transient tries goodbye-provided alternatives, cached topology, and finally
fresh seed addresses.

This tree solves reachability; it does not change replication authority.

## 7. Security Model

REPRAM's security promise is narrow: its nodes forget the payloads they hold.

### 7.1 Permissionless client plane

There are no client accounts, API keys, key owners, or client authorization
checks. Anyone able to reach a node may read or overwrite a known key. The node
may temporarily distinguish network sources for local concerns such as rate
limiting, but it assigns no application identity and keeps no user account or
durable access history.

### 7.2 Content-agnostic storage

A node necessarily possesses and can read the bytes it stores. "Opaque" means
the node attaches no application meaning to them: no schema, semantic index,
ownership, tags, or content-dependent behavior.

The node retains only information required to handle the piece:

- Key.
- Value bytes.
- Creation time.
- TTL and expiration.

Values are never written to application logs or metrics. Debug logging may
include opaque keys and peer transport information, so REPRAM does not claim to
erase metadata held by networks, hosts, or observers.

### 7.3 Client responsibility

Clients that need confidentiality encrypt before storing. Clients that need
provenance sign their values. Clients that need identity, authorization,
lineage, or conflict resolution define those rules above REPRAM.

If someone retains plaintext and stores it again, REPRAM treats that as an
ordinary new write. The system cannot and does not attempt to make participants
forget what they learned.

### 7.4 Optional peer authentication

Operators may set `REPRAM_CLUSTER_SECRET` to HMAC-sign peer gossip and
bootstrap bodies. This authenticates membership in that configured transport
domain. It does not authenticate client PUT or GET operations, create user
identity, or change the permissionless data model.

## 8. Failure Model

REPRAM assumes:

- Nodes appear and disappear.
- Membership knowledge is incomplete.
- Messages may be delayed, duplicated, reordered, or lost.
- Partitions may outlive the data they separate.
- A returning node may have missed information entirely.
- No operator will reconcile old payload history.

The response is not to emulate a perfectly synchronized durable system.
Instead, current writes spread through the currently reachable network and
obsolete state removes itself. Isolation recovery repairs peer discovery;
ordinary future writes repopulate useful state.

## 9. Applications

The primitive supports patterns without understanding any of them:

- **Dead drop:** a writer leaves bytes under a rendezvous key.
- **Scratchpad:** overwrites refresh temporary working state.
- **Coordination token:** presence means claimed; expiration means available.
- **Heartbeat:** periodic rewrites make absence the failure signal.
- **Ephemeral chat:** a room remains readable while participants are present
  and leaves no server-side transcript after expiration.
- **Circuit breaker:** a short-lived health value disappears when its producer
  stops refreshing it.
- **Encrypted relay:** clients exchange ciphertext through an opaque key.
- **Signpost:** successive visitors validate, extend, sign, and refresh a
  long-lived pointer without requiring the storage layer to understand it.

## 10. Long-Horizon Motivation

The deepest design case is coordination among self-replicating autonomous
probes. Such a population has no stable membership, shared present, permanent
control plane, or guarantee that descendants use their ancestors' higher-level
protocols. Network partitions are physics. Persistent accumulation across an
expanding population is unaffordable, and ancient coordination state can be
actively harmful.

REPRAM supplies a hereditary primitive: leave named bytes, let reachable peers
carry them, and forget them unless another participant finds them useful enough
to rewrite.

At that scale, TTL plus refresh becomes more than deletion. A signpost with a
centuries-long lifetime survives because successive visitors continue to
validate and renew it. Information becomes tradition: retained neither by an
immortal database nor by decree, but because each generation elects to carry
it forward.

The present protocol is terrestrial. Its global topology, integer TTL range,
and discovery mechanisms will not directly span a galactic population. Those
are subjects for simulation and future protocol versions. The invariant that
should survive is smaller: opaque bytes, local lifecycle, peer propagation,
and automatic forgetting.

## 11. Non-Goals

REPRAM is not:

- A persistent database.
- A reliable message queue.
- A secrets manager.
- A durable log.
- A consensus service.
- An identity provider.
- A globally ordered register.
- A server-side application platform.

Adding those guarantees to the core would make the primitive less portable
and less honest about its operating environment.

## Conclusion

REPRAM treats forgetting as infrastructure rather than cleanup. Its usefulness
comes from the guarantees it declines to accumulate: no ownership, no durable
history, no central data authority, and no requirement that every participant
share one interpretation of the bytes.

Store the piece. Let it spread. Use it while it matters. Then let the network
forget.
