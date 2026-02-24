# Usage Patterns

REPRAM is `pipe`, not `grep`. It stores bytes, replicates them, and destroys them on schedule. It doesn't know or care what flows through it. The patterns below are not an exhaustive list — they're illustrations of what falls out of a simple primitive: PUT with TTL, GET by key, silent overwrite, automatic expiration.

## Agent Patterns

**Dead drop** — The core pattern. Agent A stores a payload with a known key. Agent B retrieves it later using that key. The data self-destructs after TTL. For rendezvous between agents that don't know each other's endpoints, derive the key from shared context (e.g., `hash(task_id + agent_pair)`) so both parties can compute it independently.

**Scratchpad** — An agent stores intermediate reasoning state across multi-step workflows, retrieving and updating as it progresses. Each overwrite refreshes the TTL. When the workflow completes (or the agent dies), the state expires on its own.

**Coordination token** — Multiple agents use a shared key as a lightweight lock or signal. Presence of the key means "in progress"; expiration means "available." Lightweight distributed locking without a lock server.

**Heartbeat / presence** — An agent writes a key on a recurring interval with a short TTL. The key's existence is the liveness signal. If the writer stops writing, the key expires — and the absence *is* the failure notification. No health check infrastructure, no polling, no failure detector. The TTL is the failure detector.

**State machine** — A job ID key whose value transitions through states via overwrites (`queued` → `in_progress` → `complete`). The TTL acts as a staleness guarantee: if a job writes `in_progress` with a 10-minute TTL and then crashes, the key expires and any agent polling it knows the job didn't complete. Overwrites reset the TTL, so each state transition refreshes the window.

Both heartbeat and state machine patterns rely on silent overwrite being the defined behavior for existing keys, and reinforce why DELETE doesn't belong in the protocol — in the heartbeat pattern, the *absence* of a write is the meaningful signal. The system's only job is to faithfully forget.

## Beyond Agents — REPRAM as a Primitive

The agent patterns above are the primary motivation, but the primitive is general-purpose. Any system that needs temporary, replicated, self-cleaning storage can use REPRAM without modification.

**Circuit breaker** — A service writes a `healthy` key with short TTL. Consumers check before calling. Service dies → key expires → consumers back off. Distributed circuit breaking without a circuit breaker library. Same mechanic as the heartbeat pattern, viewed from the consumer's perspective.

**Ephemeral broadcast** — Write a value to a known key; anyone polling that key gets the current state. Config distribution, feature flags, announcement channels. Stop writing and the broadcast expires — automatic rollback with zero cleanup.

**Secure relay** — Encrypt a payload, store it, share the key through a side channel. Recipient retrieves it. Data self-destructs after TTL. No server logs, no accounts, no metadata trail. The infrastructure doesn't know what it carried and can't be compelled to remember. Works for anything from whistleblower drops to encrypted military communications.

**Session continuity** — Store session state under a session ID, overwrite on each interaction to refresh TTL. Any edge server can read the current state. User stops interacting → session expires naturally. No session store, no garbage collection, no stale session cleanup jobs. Enterprise browser session replication without enterprise infrastructure.

**Distributed deduplication** — Write a key when processing an event. Before processing, check if key exists. Key present = already handled. TTL = dedup window. No dedup database, no purge logic.

**Ephemeral pub/sub** — Publisher overwrites a known key on interval. Subscribers poll. No subscription management, no broker, no message ordering. Lossy by design — and for status dashboards, approximate state sync, or coordination signals, that's exactly right.

## Key Naming Conventions

REPRAM doesn't enforce key structure — keys are opaque strings. But consistent naming helps agents discover each other's data and avoids collisions across unrelated workloads. These conventions are suggestions, not protocol requirements.

### Namespace prefixes

Use a prefix to indicate the key's role:

| Prefix | Purpose | Example |
|--------|---------|---------|
| `handoff:` | Dead drop / agent-to-agent payload | `handoff:task-742:agent-a→agent-b` |
| `scratch:` | Working state for a single agent | `scratch:agent-c:reasoning-step-3` |
| `lock:` | Coordination token / mutex | `lock:pipeline:stage-2` |
| `heartbeat:` | Presence signal | `heartbeat:worker-12` |
| `state:` | State machine / job status | `state:job-9f3a` |
| `broadcast:` | Ephemeral broadcast channel | `broadcast:config:feature-flags` |

Separate hierarchy levels with `:` (colon). This is a convention, not a separator the server understands — but it plays well with prefix-based listing (`/v1/keys?prefix=lock:`).

### Key generation strategies

**UUID keys** (default for `repram_store`) — Best for scratchpad and one-shot storage where the writer returns the key to the caller. No collision risk.

```
scratch:550e8400-e29b-41d4-a716-446655440000
```

**Deterministic keys** — Best for dead-drop rendezvous where both parties need to compute the key independently. Derive from shared context:

```
handoff:sha256(task_id + sender + receiver)
lock:pipeline-name:stage-name
heartbeat:worker-id
```

The key derivation function doesn't matter as long as both sides agree. SHA-256 of concatenated context fields is a safe default.

**Human-readable keys** — Fine for development, debugging, and single-tenant deployments. Use namespacing to avoid collisions:

```
myapp:session:user-42
myapp:cache:homepage
```

### Prefix listing for discovery

The `/v1/keys?prefix=` endpoint (and `repram_list_keys` tool) makes prefixes useful for discovery:

- `?prefix=heartbeat:` — list all live agents
- `?prefix=state:` — list all active jobs
- `?prefix=lock:pipeline:` — list all held locks in a pipeline
- `?prefix=myapp:` — list everything in your namespace

### Avoiding collisions

On a shared public network, unrelated agents may store data on the same nodes. UUID keys avoid collisions by default. For deterministic keys, include enough context to be unique — a bare `lock:stage-2` could collide, but `lock:org-acme:pipeline-ingest:stage-2` won't.
