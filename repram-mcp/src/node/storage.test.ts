import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MemoryStore, StoreFull } from "./storage.js";

let store: MemoryStore;

afterEach(() => {
  store?.close();
});

describe("MemoryStore put/get", () => {
  it("stores and retrieves data", () => {
    store = new MemoryStore();
    store.put("key1", Buffer.from("hello"), 3600);

    const result = store.get("key1");
    expect(result).not.toBeNull();
    expect(result!.toString()).toBe("hello");
  });

  it("returns null for missing key", () => {
    store = new MemoryStore();
    expect(store.get("nonexistent")).toBeNull();
  });

  it("returns a copy of the data (not the internal reference)", () => {
    store = new MemoryStore();
    store.put("key1", Buffer.from("original"), 3600);

    const result = store.get("key1");
    result![0] = 0xFF; // mutate the returned buffer

    const fresh = store.get("key1");
    expect(fresh!.toString()).toBe("original");
  });

  it("overwrites existing key", () => {
    store = new MemoryStore();
    store.put("key1", Buffer.from("v1"), 3600);
    store.put("key1", Buffer.from("v2"), 3600);

    expect(store.get("key1")!.toString()).toBe("v2");
  });
});

describe("TTL expiration", () => {
  it("returns null for expired key", () => {
    store = new MemoryStore();
    vi.useFakeTimers();

    store.put("ephemeral", Buffer.from("data"), 5);

    // Still alive at 4 seconds
    vi.advanceTimersByTime(4_000);
    expect(store.get("ephemeral")).not.toBeNull();

    // Expired at 5 seconds
    vi.advanceTimersByTime(1_000);
    expect(store.get("ephemeral")).toBeNull();

    vi.useRealTimers();
  });
});

describe("getWithMetadata", () => {
  it("returns entry with metadata", () => {
    store = new MemoryStore();
    const before = Date.now();
    store.put("meta", Buffer.from("payload"), 600);
    const after = Date.now();

    const entry = store.getWithMetadata("meta");
    expect(entry).not.toBeNull();
    expect(entry!.data.toString()).toBe("payload");
    expect(entry!.ttlSeconds).toBe(600);
    expect(entry!.createdAt).toBeGreaterThanOrEqual(before);
    expect(entry!.createdAt).toBeLessThanOrEqual(after);
    expect(entry!.expiresAt).toBe(entry!.createdAt + 600_000);
  });

  it("returns null for expired key", () => {
    store = new MemoryStore();
    vi.useFakeTimers();

    store.put("temp", Buffer.from("data"), 1);
    vi.advanceTimersByTime(1_000);

    expect(store.getWithMetadata("temp")).toBeNull();

    vi.useRealTimers();
  });

  it("returns null for missing key", () => {
    store = new MemoryStore();
    expect(store.getWithMetadata("nope")).toBeNull();
  });
});

describe("exists", () => {
  it("returns true with remaining TTL for live key", () => {
    store = new MemoryStore();
    store.put("alive", Buffer.from("data"), 300);

    const result = store.exists("alive");
    expect(result.exists).toBe(true);
    expect(result.remainingTtlSeconds).toBeGreaterThan(298);
    expect(result.remainingTtlSeconds).toBeLessThanOrEqual(300);
  });

  it("returns false for missing key", () => {
    store = new MemoryStore();
    expect(store.exists("missing")).toEqual({ exists: false, remainingTtlSeconds: 0 });
  });

  it("returns false for expired key", () => {
    store = new MemoryStore();
    vi.useFakeTimers();

    store.put("gone", Buffer.from("data"), 1);
    vi.advanceTimersByTime(1_000);

    expect(store.exists("gone")).toEqual({ exists: false, remainingTtlSeconds: 0 });

    vi.useRealTimers();
  });
});

describe("scan", () => {
  it("returns all live keys", () => {
    store = new MemoryStore();
    store.put("a", Buffer.from("1"), 3600);
    store.put("b", Buffer.from("2"), 3600);
    store.put("c", Buffer.from("3"), 3600);

    const keys = store.scan();
    expect(keys.sort()).toEqual(["a", "b", "c"]);
  });

  it("excludes expired keys", () => {
    store = new MemoryStore();
    vi.useFakeTimers();

    store.put("live", Buffer.from("1"), 3600);
    store.put("dead", Buffer.from("2"), 1);
    vi.advanceTimersByTime(1_000);

    expect(store.scan()).toEqual(["live"]);

    vi.useRealTimers();
  });

  it("filters by prefix", () => {
    store = new MemoryStore();
    store.put("app-foo", Buffer.from("1"), 3600);
    store.put("app-bar", Buffer.from("2"), 3600);
    store.put("other-baz", Buffer.from("3"), 3600);

    const keys = store.scan("app-");
    expect(keys.sort()).toEqual(["app-bar", "app-foo"]);
  });

  it("returns empty array when nothing matches prefix", () => {
    store = new MemoryStore();
    store.put("key1", Buffer.from("1"), 3600);

    expect(store.scan("nope-")).toEqual([]);
  });
});

describe("capacity limit", () => {
  it("rejects writes when full", () => {
    store = new MemoryStore(10); // 10 bytes max
    store.put("a", Buffer.from("12345"), 3600); // 5 bytes

    expect(() => {
      store.put("b", Buffer.from("123456"), 3600); // 6 bytes → over limit
    }).toThrow(StoreFull);
  });

  it("allows overwrite that stays within limit", () => {
    store = new MemoryStore(10);
    store.put("a", Buffer.from("12345"), 3600);    // 5 bytes
    store.put("a", Buffer.from("1234567890"), 3600); // 10 bytes overwrite — replaces 5 with 10
    expect(store.get("a")!.toString()).toBe("1234567890");
  });

  it("tracks bytes accurately through overwrite", () => {
    store = new MemoryStore(100);
    store.put("a", Buffer.from("12345"), 3600);     // 5 bytes
    expect(store.bytesUsed).toBe(5);

    store.put("a", Buffer.from("123"), 3600);        // overwrite with 3 bytes
    expect(store.bytesUsed).toBe(3);
  });

  it("allows unlimited when maxBytes is 0", () => {
    store = new MemoryStore(0);
    const bigData = Buffer.alloc(10_000, 0x42);
    store.put("big", bigData, 3600);
    expect(store.get("big")).not.toBeNull();
  });
});

describe("cleanup", () => {
  it("removes expired entries on cleanup cycle", () => {
    vi.useFakeTimers();
    store = new MemoryStore();

    store.put("short", Buffer.from("data"), 5);
    store.put("long", Buffer.from("data"), 3600);

    // Advance past short TTL and trigger cleanup interval (30s)
    vi.advanceTimersByTime(30_000);

    // short should be cleaned up, long should remain
    expect(store.keyCount).toBe(1);
    expect(store.get("long")).not.toBeNull();

    vi.useRealTimers();
  });

  it("updates byte count after cleanup", () => {
    vi.useFakeTimers();
    store = new MemoryStore();

    store.put("temp", Buffer.from("12345"), 1); // 5 bytes, 1s TTL
    expect(store.bytesUsed).toBe(5);

    vi.advanceTimersByTime(30_000); // trigger cleanup
    expect(store.bytesUsed).toBe(0);

    vi.useRealTimers();
  });
});

describe("getStats", () => {
  it("returns count and total bytes", () => {
    store = new MemoryStore();
    store.put("a", Buffer.from("hello"), 3600);
    store.put("b", Buffer.from("world!"), 3600);

    const stats = store.getStats();
    expect(stats.count).toBe(2);
    expect(stats.totalBytes).toBe(11);
  });
});

describe("close", () => {
  it("stops cleanup interval", () => {
    vi.useFakeTimers();
    store = new MemoryStore();
    store.put("key", Buffer.from("data"), 1);

    store.close();

    // Advance time but cleanup should not run
    vi.advanceTimersByTime(60_000);

    // Entry is still in the map (not cleaned up) — though it's expired on access
    expect(store.keyCount).toBe(1);

    vi.useRealTimers();
  });
});
