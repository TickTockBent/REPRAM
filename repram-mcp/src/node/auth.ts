/**
 * Gossip authentication — HMAC-SHA256 signing and verification.
 *
 * Port of internal/gossip/auth.go. Uses Node.js crypto module.
 * Constant-time comparison via timingSafeEqual prevents timing attacks.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export function signBody(secret: string, body: Buffer): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function verifyBody(secret: string, body: Buffer, signature: string): boolean {
  const expected = Buffer.from(signBody(secret, body), "hex");
  const actual = Buffer.from(signature, "hex");

  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
