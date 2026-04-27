# Omega Operations

Operator guide for REPRAM's signed-root-discovery trust anchor. Context and
rationale live in `docs/REPRAM-2.1-Spec.md`.

The omega *public* key is compiled into every node binary. The omega
*private* key lives on an air-gapped signing machine and is used only to
sign root lists. It never touches a node, a CI system, or any network.

## Configuration interactions (read first)

**Root nodes must not set `REPRAM_PEERS`.** The public-network omega
verification is gated on "public network AND no manual peers." Setting
`REPRAM_PEERS` on a public-network node short-circuits the entire omega
path: the node skips the signed-list fetch, `IsRoot()` stays `false`, and
`/v1/bootstrap` returns 403 for every request. Nodes log a warning at
startup when they detect this combination, but the failure mode is quiet
otherwise. Use `REPRAM_NETWORK=private` with `REPRAM_PEERS` for private
clusters; leave `REPRAM_PEERS` unset on public-network root nodes.

## When to use which tool

- `repram-omega keygen` — one time, at network birth, and again only if the
  key is lost or compromised. Generating a new omega key invalidates every
  existing signed root list and requires shipping a new binary.
- `repram-omega sign` — every time the root node set changes and before the
  current signed list expires.

Both run on the offline signing machine. Do not install `repram-omega` on a
REPRAM node.

## First-time setup

1. On an air-gapped machine, generate the keypair:

   ```
   repram-omega keygen \
     --out-private omega-v1.key \
     --out-public  omega-v1.pub
   ```

   `omega-v1.key` is written with mode `0600`. Back it up to offline media
   (two copies, two locations). Losing it means rotating the omega version.

2. Copy the base64 public key from stdout (or from `omega-v1.pub`) into the
   node source on the online build machine:

   - `internal/trust/omega.go` — `OmegaPubkey` constant.
   - `repram-mcp/src/node/trust/omega.ts` — `OMEGA_PUBKEY` constant.

   Both must match. Build, tag, release.

## Publishing a signed root list

1. On the signing machine, decide the node set and lifetime. A 24-hour
   lifetime is a reasonable default; the network operator can refresh more
   often without cost.

   ```
   repram-omega sign \
     --key omega-v1.key \
     --version omega-v1 \
     --expires-in 24h \
     --nodes root-a.example:9090,root-b.example:9090,root-c.example:9090
   ```

2. The command prints the full TXT-record value on stdout and the
   publication checklist on stderr. Transfer only the stdout line (it is
   public data) to the DNS provider's control panel or API.

3. Update two records:

   - `_bootstrap.repram.io  TXT  "omega=_omega.repram.io"` — rarely
     changes; points discovery at the omega record.
   - `_omega.repram.io      TXT  "<output of repram-omega sign>"` —
     republished on every refresh.

4. Verify propagation:

   ```
   dig +short TXT _bootstrap.repram.io
   dig +short TXT _omega.repram.io
   ```

5. Nodes pick up the new record on their next refresh cycle (before the
   previous record's `exp`). There is no need to restart nodes.

## Changing the root node set

Run `sign` with the new `--nodes` list, publish the new TXT record. A node
whose advertised `REPRAM_ADDRESS:REPRAM_GOSSIP_PORT` is removed from the
list stops answering `/v1/bootstrap` requests within one refresh cycle; a
newly-added node starts answering on the same schedule.

## Rotating the omega key (version bump)

Required if the private key is lost or compromised. **Rotation is
binary-coordinated, not DNS-coordinated.** The omega pubkey is baked into
the node binary — a DNS update alone rotates nothing; existing nodes keep
verifying against the old pubkey and reject any list signed with the new
one. Get the ordering wrong and you partition the network.

Correct sequence:

1. **Generate new keypair** on the air-gapped machine: `repram-omega
   keygen --out-private omega-v2.key --out-public omega-v2.pub`.
2. **Ship a binary release** with the new pubkey baked in:
   - `OmegaVersion = "omega-v2"`, new `OmegaPubkey` in `internal/trust/omega.go`.
   - `OMEGA_VERSION = "omega-v2"`, new `OMEGA_PUBKEY` in
     `repram-mcp/src/node/trust/omega.ts`.
   Both constants must match exactly. Tag and release.
3. **Wait for deployment to propagate** across operators and
   self-hosters. The previous signed-list `exp` is your deadline — past
   that, un-upgraded nodes can no longer refresh their root list.
4. **Begin publishing new-key signed lists** via `_omega-v2.repram.io`
   in parallel with the existing `_omega-v1.repram.io`. Nodes on the new
   binary start accepting the new lists; nodes still on the old binary
   continue using the old lists.
5. **Retire `_omega-v1.repram.io`** once you're confident no `omega-v1`
   binaries remain in the network.

If the old key is compromised and you can't wait for propagation, shorten
the transition window by pre-shipping the new binary before publishing any
old-key list that would span the rotation — or accept a brief period in
which un-upgraded nodes cannot bootstrap new peers. In either case, do
not publish new-key signed lists before the binary containing the new
pubkey has reached all nodes that need to verify them.

## Recovery if the signing machine is unavailable

The network keeps operating until the current signed list's `exp`. Existing
nodes continue to gossip with each other normally. New nodes cannot bootstrap
onto the public network once the cached list expires everywhere.

To recover:

1. Restore the private key from offline backup onto a clean air-gapped
   machine.
2. `repram-omega sign` with a fresh `exp`.
3. Publish.

There is no online key-recovery path by design. This is the point.
