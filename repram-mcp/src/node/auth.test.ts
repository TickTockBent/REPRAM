import { describe, it, expect } from "vitest";
import { signBody, verifyBody } from "./auth.js";

describe("signBody", () => {
  it("produces hex-encoded HMAC-SHA256", () => {
    const sig = signBody("secret", Buffer.from("hello"));
    // Should be 64 hex chars (256 bits)
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces deterministic signatures", () => {
    const sig1 = signBody("key", Buffer.from("data"));
    const sig2 = signBody("key", Buffer.from("data"));
    expect(sig1).toBe(sig2);
  });

  it("different secrets produce different signatures", () => {
    const sig1 = signBody("secret1", Buffer.from("data"));
    const sig2 = signBody("secret2", Buffer.from("data"));
    expect(sig1).not.toBe(sig2);
  });

  it("different payloads produce different signatures", () => {
    const sig1 = signBody("secret", Buffer.from("data1"));
    const sig2 = signBody("secret", Buffer.from("data2"));
    expect(sig1).not.toBe(sig2);
  });
});

describe("verifyBody", () => {
  it("accepts valid signature", () => {
    const sig = signBody("secret", Buffer.from("payload"));
    expect(verifyBody("secret", Buffer.from("payload"), sig)).toBe(true);
  });

  it("rejects wrong signature", () => {
    expect(verifyBody("secret", Buffer.from("payload"), "bad")).toBe(false);
  });

  it("rejects tampered payload", () => {
    const sig = signBody("secret", Buffer.from("original"));
    expect(verifyBody("secret", Buffer.from("tampered"), sig)).toBe(false);
  });

  it("rejects wrong secret", () => {
    const sig = signBody("secret1", Buffer.from("payload"));
    expect(verifyBody("secret2", Buffer.from("payload"), sig)).toBe(false);
  });

  it("rejects empty signature", () => {
    expect(verifyBody("secret", Buffer.from("data"), "")).toBe(false);
  });
});

describe("cross-implementation compatibility", () => {
  it("produces known HMAC-SHA256 output", () => {
    // Verify against a known test vector:
    // HMAC-SHA256("secret", "hello") = 88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b
    const sig = signBody("secret", Buffer.from("hello"));
    expect(sig).toBe("88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b");
  });
});
