/**
 * SignedList — parse, canonicalize, and verify REPRAM 2.1 omega-signed root
 * lists. Mirrors internal/trust/signedlist.go byte-for-byte; both sides must
 * produce the same canonical form so a single signed record is accepted by
 * Go and TypeScript nodes alike.
 */

import { createPublicKey, createPrivateKey, verify as nodeVerify, sign as nodeSign, type KeyObject } from "node:crypto";
import { OMEGA_VERSION } from "./omega.js";

const FIELD_SEPARATOR = ";";
const KV_SEPARATOR = "=";
const NODE_SEPARATOR = ",";

const ED25519_PUBLIC_KEY_LENGTH = 32;
const ED25519_SIGNATURE_LENGTH = 64;

/** Sentinel errors so callers can branch on failure mode. */
export const TrustError = {
  MissingField: "trust: signed list missing required field",
  DuplicateField: "trust: signed list has duplicate field",
  MalformedField: "trust: signed list has malformed field",
  MalformedSignature: "trust: signed list signature is not valid base64",
  Expired: "trust: signed list has expired",
  VersionMismatch: "trust: signed list version does not match binary",
  BadSignature: "trust: signed list signature verification failed",
  EmptyNodes: "trust: signed list contains no nodes",
  InvalidPubkey: "trust: omega pubkey has wrong length",
} as const;

export interface SignedListFields {
  version: string;
  expires: number; // Unix seconds
  nodes: string[];
  signature?: Buffer;
}

export class SignedList implements SignedListFields {
  version: string;
  expires: number;
  nodes: string[];
  signature?: Buffer;

  constructor(fields: SignedListFields) {
    this.version = fields.version;
    this.expires = fields.expires;
    this.nodes = fields.nodes;
    this.signature = fields.signature;
  }

  /**
   * canonical() emits the exact byte sequence that sign() signs and verify()
   * verifies. Field order is fixed (v;exp;nodes), nodes are lex-sorted, no
   * whitespace, no signature.
   */
  canonical(): Buffer {
    const sorted = [...this.nodes].sort();
    const payload =
      `${fieldKey.version}${KV_SEPARATOR}${this.version}${FIELD_SEPARATOR}` +
      `${fieldKey.expires}${KV_SEPARATOR}${this.expires}${FIELD_SEPARATOR}` +
      `${fieldKey.nodes}${KV_SEPARATOR}${sorted.join(NODE_SEPARATOR)}`;
    return Buffer.from(payload, "utf8");
  }

  /**
   * encode() returns the full TXT-record value including a base64-encoded
   * signature. Intended for the operator signing tool (not published from
   * this package, but useful for cross-language tests).
   */
  encode(): string {
    if (!this.signature) {
      throw new Error("SignedList.encode called without a signature — call sign() first");
    }
    return (
      this.canonical().toString("utf8") +
      FIELD_SEPARATOR +
      fieldKey.sig +
      KV_SEPARATOR +
      this.signature.toString("base64")
    );
  }

  /**
   * sign() computes an Ed25519 signature over canonical() using the
   * provided private key and stores it on this instance. privKey must be a
   * Node KeyObject for an Ed25519 key.
   */
  sign(privKey: KeyObject): Buffer {
    const sig = nodeSign(null, this.canonical(), privKey);
    this.signature = sig;
    return sig;
  }

  /**
   * verify() fails fast on version mismatch, expiration, or signature
   * mismatch. Callers MUST check the returned error before trusting
   * this.nodes.
   *
   * @param pubKey Ed25519 public key (KeyObject, spki-wrapped).
   * @param now   Reference time; tests inject deterministic clocks.
   */
  verify(pubKey: KeyObject, now: Date): Error | null {
    if (this.version !== OMEGA_VERSION) {
      return new Error(`${TrustError.VersionMismatch}: got ${this.version} want ${OMEGA_VERSION}`);
    }
    const nowSec = Math.floor(now.getTime() / 1000);
    if (nowSec >= this.expires) {
      return new Error(`${TrustError.Expired}: exp=${this.expires} now=${nowSec}`);
    }
    if (this.nodes.length === 0) {
      return new Error(TrustError.EmptyNodes);
    }
    if (!this.signature || this.signature.length !== ED25519_SIGNATURE_LENGTH) {
      return new Error(TrustError.BadSignature);
    }
    const ok = nodeVerify(null, this.canonical(), pubKey, this.signature);
    if (!ok) {
      return new Error(TrustError.BadSignature);
    }
    return null;
  }
}

const fieldKey = {
  version: "v",
  expires: "exp",
  nodes: "nodes",
  sig: "sig",
} as const;

/**
 * parseSignedList deserializes a TXT-record payload. Field order on the
 * wire is tolerated; canonical() re-normalizes for signature verification.
 * Duplicate fields are rejected; unknown fields are ignored so future
 * additions within the same omega version remain forward-compatible.
 */
export function parseSignedList(raw: string): SignedList | Error {
  if (!raw) {
    return new Error(`${TrustError.MalformedField}: empty record`);
  }

  const seen = new Set<string>();
  let version: string | undefined;
  let expires: number | undefined;
  let nodes: string[] | undefined;
  let signature: Buffer | undefined;

  for (const part of raw.split(FIELD_SEPARATOR)) {
    if (!part) continue;
    const eq = part.indexOf(KV_SEPARATOR);
    if (eq < 0) {
      return new Error(`${TrustError.MalformedField}: ${part}`);
    }
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();

    if (seen.has(key)) {
      return new Error(`${TrustError.DuplicateField}: ${key}`);
    }
    seen.add(key);

    switch (key) {
      case fieldKey.version:
        version = value;
        break;
      case fieldKey.expires: {
        const n = parseInt(value, 10);
        if (!Number.isFinite(n) || String(n) !== value) {
          return new Error(`${TrustError.MalformedField}: exp=${value}`);
        }
        expires = n;
        break;
      }
      case fieldKey.nodes: {
        if (!value) return new Error(TrustError.EmptyNodes);
        nodes = value
          .split(NODE_SEPARATOR)
          .map((n) => n.trim())
          .filter((n) => n.length > 0);
        if (nodes.length === 0) return new Error(TrustError.EmptyNodes);
        break;
      }
      case fieldKey.sig: {
        if (!/^[A-Za-z0-9+/=]*$/.test(value)) {
          return new Error(TrustError.MalformedSignature);
        }
        signature = Buffer.from(value, "base64");
        // Node silently tolerates garbage base64 by producing empty buffers
        // with shorter length; use re-encode roundtrip as a sanity check.
        if (signature.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
          return new Error(TrustError.MalformedSignature);
        }
        break;
      }
      // Unknown fields: ignored; forward-compatible within the same
      // omega version. Breaking changes bump OMEGA_VERSION.
    }
  }

  if (version === undefined) return new Error(`${TrustError.MissingField}: v`);
  if (expires === undefined) return new Error(`${TrustError.MissingField}: exp`);
  if (nodes === undefined) return new Error(`${TrustError.MissingField}: nodes`);
  if (signature === undefined) return new Error(`${TrustError.MissingField}: sig`);

  return new SignedList({ version, expires, nodes, signature });
}

/**
 * Decode the baked-in or operator-supplied base64 Ed25519 public key into
 * a Node KeyObject suitable for verify(). Throws if the key length is wrong.
 */
export function publicKeyFromBase64(b64: string): KeyObject {
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== ED25519_PUBLIC_KEY_LENGTH) {
    throw new Error(`${TrustError.InvalidPubkey}: got ${raw.length} want ${ED25519_PUBLIC_KEY_LENGTH}`);
  }
  // Node only accepts Ed25519 keys via SPKI-wrapped DER or JWK; construct
  // the SPKI prefix ourselves so the raw 32-byte key can come from anywhere.
  const SPKI_PREFIX = Buffer.from([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
  ]);
  const spki = Buffer.concat([SPKI_PREFIX, raw]);
  return createPublicKey({ key: spki, format: "der", type: "spki" });
}

/**
 * Build a Node KeyObject for an Ed25519 private key, given the 64-byte
 * libsodium-style seed||pubkey concatenation that `repram-omega keygen`
 * writes out (base64 on disk).
 */
export function privateKeyFromBase64(b64: string): KeyObject {
  const raw = Buffer.from(b64, "base64");
  // Node's ed25519 private key is 32 bytes of seed; the 64-byte go form is
  // seed||pubkey. Take the first 32 bytes.
  if (raw.length !== 64 && raw.length !== 32) {
    throw new Error(`trust: private key has wrong length: got ${raw.length}`);
  }
  const seed = raw.length === 64 ? raw.subarray(0, 32) : raw;
  const PKCS8_PREFIX = Buffer.from([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22, 0x04, 0x20,
  ]);
  const pkcs8 = Buffer.concat([PKCS8_PREFIX, seed]);
  return createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
}
