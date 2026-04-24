import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { fetchSigned, type TXTResolver } from "./resolver.js";
import { publicKeyFromBase64, SignedList, TrustError } from "./signed-list.js";
import { OMEGA_VERSION } from "./omega.js";

function testKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const rawPub = spki.subarray(spki.length - 32);
  return { pubKey: publicKeyFromBase64(rawPub.toString("base64")), privateKey };
}

class StubResolver implements TXTResolver {
  constructor(
    private records: Record<string, string[][]>,
    private errors: Record<string, Error> = {},
  ) {}
  async resolveTxt(name: string): Promise<string[][]> {
    if (this.errors[name]) throw this.errors[name];
    return this.records[name] ?? [];
  }
}

describe("fetchSigned", () => {
  it("returns a verified list on the happy path", async () => {
    const { pubKey, privateKey } = testKeypair();
    const list = new SignedList({
      version: OMEGA_VERSION,
      expires: Math.floor(Date.now() / 1000) + 3600,
      nodes: ["root-a.example:9090", "root-b.example:9090"],
    });
    list.sign(privateKey);

    const resolver = new StubResolver({
      "_bootstrap.repram.io": [["omega=_omega.repram.io"]],
      "_omega.repram.io": [[list.encode()]],
    });

    const got = await fetchSigned({ resolver }, pubKey, new Date());
    expect(got.nodes.length).toBe(2);
  });

  it("rejects when the bootstrap TXT has no omega= entry", async () => {
    const { pubKey } = testKeypair();
    const resolver = new StubResolver({
      "_bootstrap.repram.io": [["something-else=value"]],
    });
    await expect(fetchSigned({ resolver }, pubKey, new Date())).rejects.toThrow(
      /no omega= entry/,
    );
  });

  it("propagates an expired-list verify failure", async () => {
    const { pubKey, privateKey } = testKeypair();
    const list = new SignedList({
      version: OMEGA_VERSION,
      expires: Math.floor(Date.now() / 1000) - 60,
      nodes: ["a:9090"],
    });
    list.sign(privateKey);
    const resolver = new StubResolver({
      "_bootstrap.repram.io": [["omega=_omega.repram.io"]],
      "_omega.repram.io": [[list.encode()]],
    });
    await expect(fetchSigned({ resolver }, pubKey, new Date())).rejects.toThrow(
      TrustError.Expired,
    );
  });

  it("propagates a signature-mismatch verify failure", async () => {
    const { privateKey } = testKeypair();
    const { pubKey: attackerPub } = testKeypair();
    const list = new SignedList({
      version: OMEGA_VERSION,
      expires: Math.floor(Date.now() / 1000) + 3600,
      nodes: ["a:9090"],
    });
    list.sign(privateKey);
    const resolver = new StubResolver({
      "_bootstrap.repram.io": [["omega=_omega.repram.io"]],
      "_omega.repram.io": [[list.encode()]],
    });
    await expect(fetchSigned({ resolver }, attackerPub, new Date())).rejects.toThrow(
      TrustError.BadSignature,
    );
  });

  it("propagates DNS errors", async () => {
    const { pubKey } = testKeypair();
    const resolver = new StubResolver({}, {
      "_bootstrap.repram.io": new Error("dns-down"),
    });
    await expect(fetchSigned({ resolver }, pubKey, new Date())).rejects.toThrow("dns-down");
  });

  it("joins multi-segment TXT records", async () => {
    const { pubKey, privateKey } = testKeypair();
    const list = new SignedList({
      version: OMEGA_VERSION,
      expires: Math.floor(Date.now() / 1000) + 3600,
      nodes: ["a:9090"],
    });
    list.sign(privateKey);
    const full = list.encode();
    const half = Math.floor(full.length / 2);
    const resolver = new StubResolver({
      "_bootstrap.repram.io": [["omega=_omega.repram.io"]],
      // Simulate resolver splitting at 255-byte boundary.
      "_omega.repram.io": [[full.slice(0, half), full.slice(half)]],
    });
    const got = await fetchSigned({ resolver }, pubKey, new Date());
    expect(got.nodes).toEqual(["a:9090"]);
  });
});
