import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleToolCall } from "./tools.js";
import type { RepramClient } from "./client.js";

// Mock client — each test configures the methods it needs.
function createMockClient(overrides: Partial<RepramClient> = {}): RepramClient {
  return {
    store: vi.fn().mockResolvedValue({ status: 201, statusText: "Created" }),
    retrieve: vi.fn().mockResolvedValue(null),
    exists: vi.fn().mockResolvedValue({ exists: false, remainingTtlSeconds: 0 }),
    listKeys: vi.fn().mockResolvedValue({ keys: [] }),
    ...overrides,
  } as unknown as RepramClient;
}

// --- repram_store ---

describe("repram_store", () => {
  it("generates a UUID key when none provided", async () => {
    const client = createMockClient();
    const result = (await handleToolCall(client, "repram_store", {
      data: "hello",
    })) as Record<string, unknown>;

    expect(result.key).toBeDefined();
    expect(typeof result.key).toBe("string");
    // UUID v4 format: 8-4-4-4-12 hex chars
    expect(result.key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(client.store).toHaveBeenCalledWith(result.key, "hello", 3600);
  });

  it("uses custom key when provided", async () => {
    const client = createMockClient();
    const result = (await handleToolCall(client, "repram_store", {
      data: "payload",
      key: "my-custom-key",
    })) as Record<string, unknown>;

    expect(result.key).toBe("my-custom-key");
    expect(client.store).toHaveBeenCalledWith("my-custom-key", "payload", 3600);
  });

  it("defaults TTL to 3600", async () => {
    const client = createMockClient();
    const result = (await handleToolCall(client, "repram_store", {
      data: "test",
    })) as Record<string, unknown>;

    expect(result.ttl_seconds).toBe(3600);
    expect(client.store).toHaveBeenCalledWith(expect.any(String), "test", 3600);
  });

  it("uses custom TTL when provided", async () => {
    const client = createMockClient();
    const result = (await handleToolCall(client, "repram_store", {
      data: "test",
      ttl_seconds: 600,
    })) as Record<string, unknown>;

    expect(result.ttl_seconds).toBe(600);
    expect(client.store).toHaveBeenCalledWith(expect.any(String), "test", 600);
  });

  it("returns expires_at as ISO 8601", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);

    const client = createMockClient();
    const result = (await handleToolCall(client, "repram_store", {
      data: "test",
      ttl_seconds: 300,
    })) as Record<string, unknown>;

    const expectedExpiry = new Date(now + 300 * 1000).toISOString();
    expect(result.expires_at).toBe(expectedExpiry);

    vi.restoreAllMocks();
  });

  it("accepts 202 (quorum timeout) as success", async () => {
    const client = createMockClient({
      store: vi.fn().mockResolvedValue({ status: 202, statusText: "Accepted" }),
    } as Partial<RepramClient>);

    const result = (await handleToolCall(client, "repram_store", {
      data: "test",
    })) as Record<string, unknown>;

    // Should return key, not error
    expect(result.key).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it("returns error on non-201/202 status", async () => {
    const client = createMockClient({
      store: vi.fn().mockResolvedValue({ status: 507, statusText: "Insufficient Storage" }),
    } as Partial<RepramClient>);

    const result = (await handleToolCall(client, "repram_store", {
      data: "test",
    })) as Record<string, unknown>;

    expect(result.error).toBeDefined();
    expect(result.error).toContain("507");
  });
});

// --- repram_retrieve ---

describe("repram_retrieve", () => {
  it("returns null for missing/expired key", async () => {
    const client = createMockClient({
      retrieve: vi.fn().mockResolvedValue(null),
    } as Partial<RepramClient>);

    const result = await handleToolCall(client, "repram_retrieve", {
      key: "nonexistent",
    });

    expect(result).toBeNull();
  });

  it("returns data with metadata for existing key", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);

    const client = createMockClient({
      retrieve: vi.fn().mockResolvedValue({
        data: "secret payload",
        createdAt: "2026-02-25T00:00:00Z",
        remainingTtlSeconds: 500,
        originalTtlSeconds: 3600,
      }),
    } as Partial<RepramClient>);

    const result = (await handleToolCall(client, "repram_retrieve", {
      key: "my-key",
    })) as Record<string, unknown>;

    expect(result.data).toBe("secret payload");
    expect(result.created_at).toBe("2026-02-25T00:00:00Z");
    expect(result.remaining_ttl_seconds).toBe(500);
    expect(result.expires_at).toBe(new Date(now + 500 * 1000).toISOString());

    vi.restoreAllMocks();
  });

  it("calls client with correct key", async () => {
    const client = createMockClient();
    await handleToolCall(client, "repram_retrieve", { key: "lookup-key" });
    expect(client.retrieve).toHaveBeenCalledWith("lookup-key");
  });
});

// --- repram_exists ---

describe("repram_exists", () => {
  it("returns exists: false for missing key", async () => {
    const client = createMockClient({
      exists: vi.fn().mockResolvedValue({ exists: false, remainingTtlSeconds: 0 }),
    } as Partial<RepramClient>);

    const result = (await handleToolCall(client, "repram_exists", {
      key: "gone",
    })) as Record<string, unknown>;

    expect(result.exists).toBe(false);
    expect(result.remaining_ttl_seconds).toBeUndefined();
  });

  it("returns exists: true with TTL for present key", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);

    const client = createMockClient({
      exists: vi.fn().mockResolvedValue({ exists: true, remainingTtlSeconds: 120 }),
    } as Partial<RepramClient>);

    const result = (await handleToolCall(client, "repram_exists", {
      key: "alive",
    })) as Record<string, unknown>;

    expect(result.exists).toBe(true);
    expect(result.remaining_ttl_seconds).toBe(120);
    expect(result.expires_at).toBe(new Date(now + 120 * 1000).toISOString());

    vi.restoreAllMocks();
  });
});

// --- repram_list_keys ---

describe("repram_list_keys", () => {
  it("returns keys without prefix filter", async () => {
    const client = createMockClient({
      listKeys: vi.fn().mockResolvedValue({ keys: ["key-a", "key-b", "key-c"] }),
    } as Partial<RepramClient>);

    const result = (await handleToolCall(client, "repram_list_keys", {})) as Record<
      string,
      unknown
    >;

    expect(result.keys).toEqual(["key-a", "key-b", "key-c"]);
    expect(client.listKeys).toHaveBeenCalledWith(undefined);
  });

  it("passes prefix to client", async () => {
    const client = createMockClient({
      listKeys: vi.fn().mockResolvedValue({ keys: ["ns-foo"] }),
    } as Partial<RepramClient>);

    const result = (await handleToolCall(client, "repram_list_keys", {
      prefix: "ns-",
    })) as Record<string, unknown>;

    expect(result.keys).toEqual(["ns-foo"]);
    expect(client.listKeys).toHaveBeenCalledWith("ns-");
  });

  it("returns empty array when no keys match", async () => {
    const client = createMockClient();
    const result = (await handleToolCall(client, "repram_list_keys", {
      prefix: "nothing-",
    })) as Record<string, unknown>;

    expect(result.keys).toEqual([]);
  });
});

// --- Unknown tool ---

describe("unknown tool", () => {
  it("throws for unrecognized tool name", async () => {
    const client = createMockClient();
    await expect(
      handleToolCall(client, "repram_delete", { key: "x" })
    ).rejects.toThrow("Unknown tool: repram_delete");
  });
});
