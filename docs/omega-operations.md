# Omega Operations

Operator guide for REPRAM's signed-root-discovery trust anchor. Context and
rationale live in `docs/internal/REPRAM-2.1-Spec.md`.

The omega *public* key is compiled into every node binary. The omega
*private* key lives on an air-gapped signing machine and is used only to
sign root lists. It never touches a node, a CI system, or any network.

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

Required if the private key is lost or compromised. This is a shipping-a-
new-binary event, not a DNS update.

1. `repram-omega keygen` on the air-gapped machine, written to
   `omega-v2.key` / `omega-v2.pub`.
2. Bump the constants:
   - `OmegaVersion = "omega-v2"`, new `OmegaPubkey` in Go.
   - `OMEGA_VERSION = "omega-v2"`, new `OMEGA_PUBKEY` in TS.
3. Cut a new release.
4. Publish `_omega-v2.repram.io` in parallel with `_omega-v1.repram.io`
   during the migration window. Keep the old version live until confident
   no `omega-v1` nodes remain.
5. Retire `_omega-v1.repram.io` when ready.

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
