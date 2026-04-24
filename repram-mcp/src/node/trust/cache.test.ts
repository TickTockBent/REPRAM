import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { SignedList } from "./signed-list.js";
import { OMEGA_VERSION } from "./omega.js";
import { loadCache, saveCache, defaultCacheDir, CACHE_FILE_NAME } from "./cache.js";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "trust-cache-test-"));
}

function makeSignedList(): SignedList {
  const { privateKey } = generateKeyPairSync("ed25519");
  const list = new SignedList({
    version: OMEGA_VERSION,
    expires: Math.floor(Date.now() / 1000) + 3600,
    nodes: ["a:9090", "b:9090"],
  });
  list.sign(privateKey);
  return list;
}

describe("saveCache + loadCache", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("roundtrips fields and signature", async () => {
    const list = makeSignedList();
    await saveCache(dir, list);
    const loaded = await loadCache(dir);
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(list.version);
    expect(loaded!.expires).toBe(list.expires);
    expect(loaded!.nodes).toEqual(list.nodes);
    expect(loaded!.signature!.equals(list.signature!)).toBe(true);
  });

  it("returns null when the cache file is absent", async () => {
    const loaded = await loadCache(dir);
    expect(loaded).toBeNull();
  });

  it("writes atomically — no leftover temp files after success", async () => {
    const list = makeSignedList();
    await saveCache(dir, list);
    const entries = await fs.readdir(dir);
    expect(entries).toEqual([CACHE_FILE_NAME]);
  });

  it("refuses to save a list without a signature", async () => {
    const list = new SignedList({
      version: OMEGA_VERSION,
      expires: 123,
      nodes: ["a:9090"],
    });
    await expect(saveCache(dir, list)).rejects.toThrow(/no signature/);
  });
});

describe("defaultCacheDir", () => {
  it("honors REPRAM_CACHE_DIR", () => {
    const prev = process.env.REPRAM_CACHE_DIR;
    process.env.REPRAM_CACHE_DIR = "/tmp/explicit-override";
    try {
      expect(defaultCacheDir()).toBe("/tmp/explicit-override");
    } finally {
      if (prev === undefined) delete process.env.REPRAM_CACHE_DIR;
      else process.env.REPRAM_CACHE_DIR = prev;
    }
  });

  it("falls back to $HOME/.repram/cache when REPRAM_CACHE_DIR is unset", () => {
    const prev = process.env.REPRAM_CACHE_DIR;
    delete process.env.REPRAM_CACHE_DIR;
    try {
      const got = defaultCacheDir();
      expect(got.endsWith(path.join(".repram", "cache"))).toBe(true);
    } finally {
      if (prev !== undefined) process.env.REPRAM_CACHE_DIR = prev;
    }
  });
});
