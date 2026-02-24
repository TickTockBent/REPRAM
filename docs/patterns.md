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
