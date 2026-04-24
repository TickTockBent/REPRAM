import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { SignedList, publicKeyFromBase64 } from "./signed-list.js";
import { OMEGA_VERSION } from "./omega.js";
import { Refresher, type Clock } from "./refresher.js";
import type { TXTResolver } from "./resolver.js";

function testKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const rawPub = spki.subarray(spki.length - 32);
  return { pubKey: publicKeyFromBase64(rawPub.toString("base64")), privateKey };
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "trust-refresh-test-"));
}

// fakeClock drives setTimeout calls from the test. advance() fires all
// pending callbacks scheduled to fire at or before the advanced time.
class FakeClock implements Clock {
  private _now: number;
  private pending: Array<{ fireAt: number; fn: () => void }> = [];

  constructor(startMs: number) {
    this._now = startMs;
  }

  now(): number {
    return this._now;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const entry = { fireAt: this._now + ms, fn };
    this.pending.push(entry);
    return entry;
  }

  clearTimeout(handle: unknown): void {
    this.pending = this.pending.filter((p) => p !== handle);
  }

  advance(ms: number): void {
    this._now += ms;
    const ready = this.pending.filter((p) => p.fireAt <= this._now);
    this.pending = this.pending.filter((p) => p.fireAt > this._now);
    for (const p of ready) p.fn();
  }

  /** Wait until there's at least one pending timer — resolves a race
   *  between the test calling advance() and the refresher registering. */
  async waitForPending(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if (this.pending.length > 0) return;
      await new Promise((r) => setImmediate(r));
    }
  }
}

class StubResolver implements TXTResolver {
  constructor(private records: Record<string, string[][]>, private errors: Record<string, Error> = {}) {}
  async resolveTxt(name: string): Promise<string[][]> {
    if (this.errors[name]) throw this.errors[name];
    return this.records[name] ?? [];
  }
}

function makeSignedList(privateKey: Parameters<SignedList["sign"]>[0], expiresSec: number, nodes: string[]): SignedList {
  const list = new SignedList({ version: OMEGA_VERSION, expires: expiresSec, nodes });
  list.sign(privateKey);
  return list;
}

describe("Refresher", () => {
  it("invokes onUpdate on scheduled refresh", async () => {
    const { pubKey, privateKey } = testKeypair();
    const start = 1_800_000_000_000;
    const clock = new FakeClock(start);
    const initial = makeSignedList(privateKey, Math.floor(start / 1000) + 3600, ["a:9090"]);
    // Refreshed list must remain valid after the clock advance below,
    // otherwise verify() fails with "expired" and onUpdate never fires.
    const refreshed = makeSignedList(
      privateKey,
      Math.floor(start / 1000) + 86400,
      ["a:9090", "b:9090"],
    );

    const resolver = new StubResolver({
      "_bootstrap.repram.io": [["omega=_omega.repram.io"]],
      "_omega.repram.io": [[refreshed.encode()]],
    });

    const dir = await makeTempDir();
    try {
      let resolveUpdate!: (l: SignedList) => void;
      const updatePromise = new Promise<SignedList>((r) => {
        resolveUpdate = r;
      });
      const r = new Refresher(
        {
          pubKey,
          cacheDir: dir,
          dns: { resolver },
          onUpdate: resolveUpdate,
          onError: (err) => {
            throw err;
          },
          clock,
          random: () => 0.5, // deterministic jitter: zero-centered
        },
        initial,
      );

      const runPromise = r.run();
      await clock.waitForPending();
      clock.advance(2 * 3600 * 1000);

      const latest = await updatePromise;
      expect(latest.nodes.length).toBe(2);

      r.stop();
      await runPromise;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("retains current list on refresh failure", async () => {
    const { pubKey, privateKey } = testKeypair();
    const start = 1_800_000_000_000;
    const clock = new FakeClock(start);
    const initial = makeSignedList(privateKey, Math.floor(start / 1000) + 3600, ["a:9090"]);

    const resolver = new StubResolver({}, {
      "_bootstrap.repram.io": new Error("dns-down"),
    });

    const dir = await makeTempDir();
    try {
      let resolveError!: (err: unknown) => void;
      const errorPromise = new Promise<unknown>((r) => {
        resolveError = r;
      });
      const r = new Refresher(
        {
          pubKey,
          cacheDir: dir,
          dns: { resolver },
          onUpdate: () => {
            throw new Error("onUpdate should not fire on failure");
          },
          onError: resolveError,
          clock,
          random: () => 0.5,
        },
        initial,
      );
      const runP = r.run();

      await clock.waitForPending();
      clock.advance(2 * 3600 * 1000);

      const errorSeen = await errorPromise;
      expect(errorSeen).not.toBeNull();
      expect(r.currentList.expires).toBe(initial.expires);

      r.stop();
      await runP;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("trigger() forces immediate refresh without waiting for schedule", async () => {
    const { pubKey, privateKey } = testKeypair();
    const start = 1_800_000_000_000;
    const clock = new FakeClock(start);
    const initial = makeSignedList(privateKey, Math.floor(start / 1000) + 86400, ["a:9090"]);
    const fresh = makeSignedList(privateKey, Math.floor(start / 1000) + 172800, ["a:9090", "b:9090"]);

    const resolver = new StubResolver({
      "_bootstrap.repram.io": [["omega=_omega.repram.io"]],
      "_omega.repram.io": [[fresh.encode()]],
    });

    const dir = await makeTempDir();
    try {
      let resolveUpdate!: (l: SignedList) => void;
      const updatePromise = new Promise<SignedList>((r) => {
        resolveUpdate = r;
      });
      const r = new Refresher(
        {
          pubKey,
          cacheDir: dir,
          dns: { resolver },
          onUpdate: resolveUpdate,
          onError: (err) => {
            throw err;
          },
          clock,
          random: () => 0.5,
        },
        initial,
      );
      const runP = r.run();
      await clock.waitForPending();

      r.trigger();

      const latest = await updatePromise;
      expect(latest.nodes.length).toBe(2);

      r.stop();
      await runP;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
