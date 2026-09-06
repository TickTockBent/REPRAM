# REPRAM 2.1 Spec: Signed Root Discovery and Omega Trust Anchor

## Status

Implemented in the Go reference node. Production activation is pending the
first real omega key ceremony, public root deployment, and DNS publication.
Scoped to the public network only.

## Scope

This spec addressed a single gap in the pre-2.1 design: the public REPRAM network discovered bootstrap peers via unsigned DNS lookups, which meant a compromised DNS provider, a cache poisoning attack, or a compromised registrar account could redirect every new node onto an attacker-controlled network.

2.1 closes that gap by introducing a signed root list, a baked-in trust anchor (the *omega pubkey*), and self-recognition of root status at startup. It does **not** introduce per-node keypairs, signed topology messages, or trust infrastructure for private enclaves — those are deferred to 2.2 and beyond.

### In scope

- Omega keypair held by the network operator (Clocktower for the public network)
- Omega pubkey baked into the node binary with a version identifier
- Signed root list published via DNS TXT records
- Node startup flow: fetch root list, verify signature, cache, act
- Root self-recognition: nodes determine their own root status by checking whether their advertised address appears in the signed root list
- Tooling to generate omega keypairs and sign root lists offline

### Out of scope

- Per-node keypairs and signed gossip messages (2.2)
- Private enclave trust hierarchies (future, customer-driven)
- Two-tier rotation signer (one-key model is sufficient at current scale)
- Changes to the existing `REPRAM_CLUSTER_SECRET` HMAC scheme (private enclaves continue to use it unchanged)

## Problem Statement

Before 2.1, a new REPRAM node consulting unsigned bootstrap DNS would bootstrap against whatever addresses DNS returned. There was no cryptographic verification that those addresses were authentic roots. An attacker who compromised the record could therefore direct new nodes to an attacker-controlled shadow network.

The existing `REPRAM_CLUSTER_SECRET` mechanism doesn't help here. It authenticates gossip messages *after* a node has joined, but the shadow network has its own (attacker-chosen) cluster secret. A node that bootstraps into the shadow network will accept the shadow network's secret as authoritative.

The fix must be a trust anchor that exists *outside* DNS — something baked into the binary that the attacker cannot forge. From that anchor, the node verifies that DNS-delivered data is authentic before trusting it.

## Design

### Trust Anchor: Omega Pubkey

Every release of the REPRAM binary contains a hardcoded Ed25519 public key — the *omega pubkey* — and a version identifier. These live in a single source file (`internal/trust/omega.go` or similar) and are the only trust root for public network operation.

```go
// Package trust contains baked-in trust anchors.
// These values are updated only by shipping a new binary release.
package trust

const (
    OmegaVersion = "omega-v1"
    OmegaPubkey  = "base64-encoded-ed25519-pubkey-here"
)
```

The omega *private* key is held offline by the network operator (Clocktower for the public network). It is used only to sign root lists. It is never deployed to any node, never accessible over any network, and ideally lives on an air-gapped signing machine.

### Signed Root List: DNS Format

Two DNS TXT records serve the trust chain:

**`_omega.repram.io` TXT** — Published alongside any operational updates. Content:

```
v=omega-v1 exp=1735689600 nodes=54.12.34.56:8080,54.12.34.57:8080,54.12.34.58:8080 sig=base64-ed25519-signature
```

Fields:

- `v` — omega version identifier. Must match the binary's baked-in version or the record is rejected.
- `exp` — Unix timestamp after which this record is no longer valid. Signed root lists have a defined lifetime; nodes must refuse expired lists and refetch.
- `nodes` — Comma-separated list of root node addresses (`host:http-port`). These are the nodes that will answer bootstrap requests for the public network. The HTTP port is what `/v1/bootstrap` listens on; the gossip port is an internal cluster detail and is exchanged in the bootstrap handshake itself, not in the signed list.
- `sig` — Ed25519 signature over the canonical form of the other fields (see "Signature Format" below).

The record is rebuilt and republished on a schedule (hourly or daily, operator's choice) with a fresh `exp` timestamp. If the operator stops publishing, existing signed lists remain valid until their `exp`, then the network is unable to onboard new public nodes until a fresh list is published.

**`_bootstrap.repram.io` TXT** — A simpler redirect record pointing to where the signed root list lives. Content:

```
omega=_omega.repram.io
```

This indirection allows future spec versions to move the omega record without changing the baked-in discovery path. Node binaries look up `_bootstrap.repram.io` first, then follow to wherever it points. For 2.1 this indirection is trivial but harmless; it pays off if you ever need to migrate DNS infrastructure.

### Signature Format

The signed payload is the UTF-8 encoding of the record with fields in canonical order, excluding the signature itself:

```
v=omega-v1;exp=1735689600;nodes=54.12.34.56:8080,54.12.34.57:8080,54.12.34.58:8080
```

Canonical rules:

- Fields appear in fixed order: `v`, `exp`, `nodes`.
- Field values are separated from keys by `=` and from each other by `;`.
- Node addresses within `nodes` are sorted lexicographically before signing.
- No whitespace is included in the signed payload.
- **omega-v1 is a strict wire format.** Parsers MUST reject records that
  contain any field other than `v`, `exp`, `nodes`, `sig`. The signature
  only covers the canonical payload (which contains just the known fields),
  so silently tolerating unknown fields would admit unauthenticated data
  into an otherwise-authenticated record. Forward-compatible extensions
  must bump `OmegaVersion`.

The signature is Ed25519 over this payload, base64-encoded for transport.

### Node Startup Flow

On startup, every node operating on the public network (i.e., `REPRAM_NETWORK=public`, which is the default) performs:

1. **Consult DNS.** Look up `_bootstrap.repram.io` TXT. Follow the `omega=` redirect to `_omega.repram.io` (or whatever it points to).
2. **Parse the signed root list.** Extract `v`, `exp`, `nodes`, `sig` fields. Reject if any are missing or malformed.
3. **Verify version.** If `v` does not match the binary's baked-in `OmegaVersion`, reject. This prevents downgrade attacks and provides clear error messages when a node is running an outdated binary.
4. **Verify expiration.** If `exp` is in the past, reject. Refetch in case DNS caching served a stale record; if still expired, fail startup with a clear error. An expired signed list indicates the operator has stopped publishing updates or the network is in a compromised state; either way the node should not proceed.
5. **Verify signature.** Reconstruct the canonical payload, verify the Ed25519 signature against the baked-in `OmegaPubkey`. If verification fails, reject.
6. **Cache the verified root list** in memory. Persist to disk (e.g., `~/.repram/cache/root-list.json`) so subsequent restarts have a fallback if DNS is unavailable.
7. **Determine root status.** Compare the node's own advertised address (`REPRAM_ADDRESS:REPRAM_HTTP_PORT` — see the `nodes` field description above for why http_port is the canonical form) against the verified `nodes` list. If it appears, the node marks itself as a root and will answer bootstrap requests. Otherwise, it operates as a normal node that consumes bootstrap from roots.
8. **Bootstrap normally.** Use the verified root list as the seed peer list for the existing bootstrap handshake. The existing `Bootstrap()` logic in `internal/gossip/bootstrap.go` is unchanged below this point.

### DNS Failure and Cache Fallback

A node that cannot reach DNS at startup falls back to its on-disk cache, provided the cached record has not yet expired. This keeps nodes running through transient DNS outages and gives the network resilience against short-lived DNS attacks.

If no valid cached record exists and DNS is unreachable, the node fails startup with a clear error. This is a deliberate choice: a node that can't verify its trust anchor should not join the network. Private deployments that want to skip DNS entirely continue to use `REPRAM_NETWORK=private` with manually configured `REPRAM_PEERS`, which bypasses all of this.

### Periodic Refresh

The cached root list has a defined lifetime driven by the `exp` field. Nodes refresh before expiration with modest jitter (to avoid synchronized DNS traffic fingerprinting) and on demand when:

- The current peer list drops below a viable threshold (all known peers unreachable).
- A bootstrap attempt fails.
- The cached record's `exp` is within some window of now (e.g., 10% of original lifetime remaining).

Successful refresh replaces the cache atomically. Failed refresh retains the previous cached record and retries with backoff. A node whose cache expires while DNS is unreachable enters a degraded state: it continues serving any peers it still knows about, but cannot onboard new peers until DNS recovers.

### Root Self-Recognition

Root status is a function of the signed root list, not node configuration. A node becomes a root by having its address added to the signed list by the operator; it stops being a root by having its address removed.

This preserves the "every node runs the same binary" invariant. There is no `--root` flag, no `REPRAM_ROOT=true`, nothing in configuration that distinguishes roots. The only difference between a root and a non-root node at runtime is:

- Roots answer `POST /v1/bootstrap` requests from new nodes joining the network.
- Non-roots return `403 Forbidden` to bootstrap requests, indicating that they are not an authorized bootstrap source.

A node recomputes its root status every time it refreshes the signed root list. A node that was a root but was removed from the list stops answering bootstrap requests on the next refresh. A new node added to the list starts answering after it picks up the updated record.

### Interaction with Existing Configuration

| Variable | 2.0 behavior | 2.1 behavior |
|----------|--------------|--------------|
| `REPRAM_NETWORK=public` (default) | Used unsigned DNS bootstrap | Uses signed omega DNS bootstrap |
| `REPRAM_NETWORK=private` | Uses `REPRAM_PEERS`, skips DNS | Unchanged |
| `REPRAM_PEERS` | Manual peer list, consulted first | Unchanged; still consulted first. If set, DNS is skipped. |
| `REPRAM_CLUSTER_SECRET` | HMAC-signs gossip bodies | Unchanged. Orthogonal to omega trust anchor. |
| `REPRAM_ENCLAVE` | Replication boundary name | Unchanged. Omega signs root lists for the public network as a whole; enclaves within the public network are unaffected. |

Private networks are entirely unaffected by this spec. A deployment with `REPRAM_NETWORK=private` and a manual peer list never consults omega DNS and never verifies any signature introduced by 2.1.

### Protocol Versioning

The omega version identifier (`omega-v1`) is the mechanism for forward-compatible changes. Future specs that change the signed record format bump the version (`omega-v2`). During a transition window, the operator publishes both versions in parallel:

```
_omega-v1.repram.io   TXT   v=omega-v1 ...
_omega-v2.repram.io   TXT   v=omega-v2 ...
```

Nodes running the 2.1 binary look up `_omega.repram.io` (which points to `_omega-v1.repram.io` during the transition). Nodes running a future binary look up the same top-level record but the redirect points to `_omega-v2.repram.io`. Once old binaries are fully deprecated, the old version is retired.

## Tooling

Two CLI tools ship alongside the node binary, built from `cmd/repram-omega/`. These are operator tools — they do not run on nodes.

### `repram-omega keygen`

Generates a new omega keypair. Outputs the public key (for baking into the binary) and the private key (for the operator's offline signing machine).

```
$ repram-omega keygen --out-private omega-v1.key --out-public omega-v1.pub
Generated Ed25519 keypair.
Public key: base64-encoded-pubkey
Private key written to omega-v1.key (chmod 600)

To use this key:
  1. Bake the public key into the REPRAM binary at internal/trust/omega.go
  2. Store omega-v1.key on your offline signing machine
  3. Never transmit the private key over any network
```

### `repram-omega sign`

Signs a root list using a private key file, producing a ready-to-paste DNS TXT record value.

```
$ repram-omega sign \
    --key omega-v1.key \
    --version omega-v1 \
    --expires-in 3600 \
    --nodes 54.12.34.56:8080,54.12.34.57:8080,54.12.34.58:8080

v=omega-v1;exp=1735693200;nodes=54.12.34.56:8080,54.12.34.57:8080,54.12.34.58:8080;sig=base64-sig

To publish:
  1. Update the _omega.repram.io TXT record with the value above
  2. Verify propagation with `dig TXT _omega.repram.io`
  3. Old record expires at 2025-01-01 00:00:00 UTC
```

This is a pure function: same inputs produce the same canonical payload and signature. The operator runs this tool on their signing machine, copies the output to their DNS provider's dashboard or API, and the network picks up the change on nodes' next refresh.

DNS automation (calling the registrar's API to push the new record) is deliberately out of scope for this spec. It's straightforward to script around `repram-omega sign` and whatever DNS API the operator uses, but the spec only defines the primitive.

## Implementation Status

The implementation was delivered in phases. Code phases are complete; public
operator deployment remains outstanding.

### Phase 1: Trust primitives — complete

- `internal/trust/` contains `OmegaVersion`, the placeholder `OmegaPubkey`, strict record parsing, canonicalization, Ed25519 verification, and tests.

### Phase 2: Omega tooling — complete

- `cmd/repram-omega/` provides `keygen` and `sign`.
- The operator workflow is documented in `docs/omega-operations.md`.

### Phase 3: Startup integration — complete

- Public startup fetches, strictly parses, verifies, and caches the signed root list. There is no unsigned fallback.
- Nodes derive root status from the verified list; non-roots return 403 from `/v1/bootstrap`.
- Verified lists are cached at `$REPRAM_CACHE_DIR/root-list.json`, defaulting to `$HOME/.repram/cache` and then `/var/cache/repram` when no home directory is available.

### Phase 4: Periodic refresh and recovery — complete

- A background refresher rotates before expiration with jitter and atomically updates root status.
- An isolated node re-bootstraps from the refresher's current signed seed list.
- Failed refresh retains a still-valid cached record and reports the error.

### Phase 5: Operator deployment — pending

- Generate the first real omega keypair.
- Replace the placeholder `OmegaPubkey` in the release binary.
- Stand up independent public roots and publish the first signed root list.
- Validate the cutover on a public testnet before making public startup the normal Quick Start path.

## Testing Strategy

- **Unit tests** on trust primitives: canonical payload construction, signature roundtrip, version mismatch rejection, expiration rejection, malformed record rejection.
- **Integration tests** with a test omega keypair: full startup flow, verify a node picks up the correct roots, verify non-roots refuse bootstrap, verify roots answer bootstrap.
- **DNS simulation tests**: mock DNS responses to test cache fallback, expiration handling, refresh scheduling.
- **Upgrade path test**: 2.0 node and 2.1 node side by side during a transition — verify they can still gossip with each other (they should, since nothing in the wire protocol between peers changes; only the bootstrap discovery path differs).

## Resolved Decisions and Remaining Limits

**Cache directory.** Resolved as `REPRAM_CACHE_DIR` when set, otherwise `$HOME/.repram/cache`, with `/var/cache/repram` as the last resort. Non-root containers should set `REPRAM_CACHE_DIR` to a writable path.

**Disk cache security.** The cached signed list is public data — anyone can read the published DNS record. No confidentiality concerns. But if an attacker has write access to the cache file, they could replace it with a signed list from an old (compromised) omega version. The version check catches this if the compromised key was retired, but only if the binary has been updated. Worth documenting but probably not worth mitigating beyond "don't let attackers write to your node's filesystem."

**Fate of unsigned DNS bootstrap.** Resolved: removed. Public mode has no unsigned fallback. `REPRAM_NETWORK=private` with `REPRAM_PEERS` remains the explicit path for operators who provide their own seeds.

**Bootstrap response handling during refresh transitions.** Accepted behavior: a just-retired root may continue answering until its next refresh. It still returns live peer topology, and root status is corrected when the signed list rotates locally.

**Record size limits.** DNS TXT records are typically limited to 255 bytes per string, with some resolvers allowing multiple strings concatenated up to ~4KB total. A root list with 10 nodes and signatures should fit comfortably, but if the network grows substantially, the record could need splitting or a different distribution mechanism (e.g., DNS-hosted pointer to an HTTPS endpoint serving the signed list). Not a 2.1 concern but worth noting.

**Self-recognition address matching.** Public roots must have stable, directly routable advertised addresses matching the signed list. NAT-constrained nodes participate as ordinary nodes through outbound attachment; they are not public roots.
