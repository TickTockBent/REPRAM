/**
 * Baked-in trust anchor for REPRAM's public network. These constants MUST
 * match the Go side (internal/trust/omega.go) — they're replaced in lockstep
 * when the omega key is rotated (Phase 6 / release cutover).
 *
 * The omega private key is held offline by the network operator and never
 * touches a running node. See docs/internal/REPRAM-2.1-Spec.md and
 * docs/omega-operations.md.
 */

/** Signing-scheme identifier. Version bumps are breaking changes. */
export const OMEGA_VERSION = "omega-v1";

/**
 * PLACEHOLDER base64-encoded Ed25519 public key. The real key is baked in
 * during the 2.1 release cutover. Tests inject ephemeral keypairs and never
 * rely on this value.
 */
export const OMEGA_PUBKEY =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
