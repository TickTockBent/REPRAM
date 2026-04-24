import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  parseSignedList,
  publicKeyFromBase64,
  SignedList,
  TrustError,
} from "./signed-list.js";
import { OMEGA_VERSION } from "./omega.js";

// Ed25519 keypair → (spki pubkey base64, KeyObject priv)
function testKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // Extract raw 32-byte pubkey from SPKI so we can round-trip through
  // publicKeyFromBase64 (the production path).
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const rawPub = spki.subarray(spki.length - 32);
  const pubKey = publicKeyFromBase64(rawPub.toString("base64"));
  return { pubKey, privateKey };
}

function validList(expires: number): SignedList {
  return new SignedList({
    version: OMEGA_VERSION,
    expires,
    nodes: ["root-c.example:9090", "root-a.example:9090", "root-b.example:9090"],
  });
}

describe("canonical", () => {
  it("emits fields in fixed order with nodes lex-sorted", () => {
    const got = validList(1_900_000_000).canonical().toString("utf8");
    const want =
      "v=omega-v1;exp=1900000000;nodes=root-a.example:9090,root-b.example:9090,root-c.example:9090";
    expect(got).toBe(want);
  });

  it("is stable across input permutations", () => {
    const a = new SignedList({
      version: OMEGA_VERSION,
      expires: 1_900_000_000,
      nodes: ["b", "a", "c"],
    });
    const b = new SignedList({
      version: OMEGA_VERSION,
      expires: 1_900_000_000,
      nodes: ["c", "a", "b"],
    });
    expect(a.canonical().equals(b.canonical())).toBe(true);
  });
});

describe("sign + verify", () => {
  it("roundtrips a freshly signed list", () => {
    const { pubKey, privateKey } = testKeypair();
    const list = validList(Math.floor(Date.now() / 1000) + 3600);
    list.sign(privateKey);
    expect(list.verify(pubKey, new Date())).toBeNull();
  });

  it("survives encode/parse", () => {
    const { pubKey, privateKey } = testKeypair();
    const list = validList(Math.floor(Date.now() / 1000) + 3600);
    list.sign(privateKey);
    const parsed = parseSignedList(list.encode());
    expect(parsed).toBeInstanceOf(SignedList);
    expect((parsed as SignedList).verify(pubKey, new Date())).toBeNull();
  });

  it("tolerates field reordering on input", () => {
    const { pubKey, privateKey } = testKeypair();
    const list = validList(Math.floor(Date.now() / 1000) + 3600);
    list.sign(privateKey);
    const nodes = [...list.nodes].sort().join(",");
    const raw = `sig=${list.signature!.toString("base64")};nodes=${nodes};exp=${list.expires};v=${OMEGA_VERSION}`;
    const parsed = parseSignedList(raw);
    expect(parsed).toBeInstanceOf(SignedList);
    expect((parsed as SignedList).verify(pubKey, new Date())).toBeNull();
  });

  it("rejects duplicate fields", () => {
    const raw = `v=omega-v1;v=omega-v1;exp=1900000000;nodes=a:9090;sig=${"A".repeat(88)}`;
    const err = parseSignedList(raw);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(TrustError.DuplicateField);
  });

  it("rejects missing fields", () => {
    const cases = [
      "exp=1900000000;nodes=a:9090;sig=AAAA",
      "v=omega-v1;nodes=a:9090;sig=AAAA",
      "v=omega-v1;exp=1900000000;sig=AAAA",
      "v=omega-v1;exp=1900000000;nodes=a:9090",
    ];
    for (const raw of cases) {
      const err = parseSignedList(raw);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain(TrustError.MissingField);
    }
  });

  it("rejects malformed exp", () => {
    const err = parseSignedList("v=omega-v1;exp=not-a-number;nodes=a:9090;sig=AAAA");
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(TrustError.MalformedField);
  });

  it("rejects empty nodes", () => {
    const err = parseSignedList("v=omega-v1;exp=1900000000;nodes=;sig=AAAA");
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(TrustError.EmptyNodes);
  });

  it("rejects version mismatch", () => {
    const { pubKey, privateKey } = testKeypair();
    const list = validList(Math.floor(Date.now() / 1000) + 3600);
    list.version = "omega-v99";
    list.sign(privateKey);
    const err = list.verify(pubKey, new Date());
    expect(err).not.toBeNull();
    expect(err!.message).toContain(TrustError.VersionMismatch);
  });

  it("rejects expired list", () => {
    const { pubKey, privateKey } = testKeypair();
    const list = validList(Math.floor(Date.now() / 1000) - 1);
    list.sign(privateKey);
    const err = list.verify(pubKey, new Date());
    expect(err).not.toBeNull();
    expect(err!.message).toContain(TrustError.Expired);
  });

  it("rejects tampered nodes", () => {
    const { pubKey, privateKey } = testKeypair();
    const list = validList(Math.floor(Date.now() / 1000) + 3600);
    list.sign(privateKey);
    list.nodes[0] = "attacker.example:9090";
    const err = list.verify(pubKey, new Date());
    expect(err).not.toBeNull();
    expect(err!.message).toContain(TrustError.BadSignature);
  });

  it("rejects wrong pubkey", () => {
    const { privateKey } = testKeypair();
    const other = testKeypair().pubKey;
    const list = validList(Math.floor(Date.now() / 1000) + 3600);
    list.sign(privateKey);
    const err = list.verify(other, new Date());
    expect(err).not.toBeNull();
    expect(err!.message).toContain(TrustError.BadSignature);
  });

  it("rejects invalid pubkey length", () => {
    expect(() => publicKeyFromBase64("AAAA")).toThrow(/wrong length/);
  });
});
