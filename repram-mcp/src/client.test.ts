import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RepramClient } from "./client.js";

// --- Helpers ---

function mockFetch(response: {
  status: number;
  statusText?: string;
  ok?: boolean;
  headers?: Record<string, string>;
  body?: string;
  json?: unknown;
}) {
  const headers = new Map(Object.entries(response.headers ?? {}));
  const fetchMock = vi.fn().mockResolvedValue({
    status: response.status,
    statusText: response.statusText ?? "OK",
    ok: response.ok ?? (response.status >= 200 && response.status < 300),
    headers: {
      get: (name: string) => headers.get(name) ?? null,
    },
    text: async () => response.body ?? "",
    json: async () => response.json ?? {},
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Constructor ---

describe("RepramClient constructor", () => {
  it("uses provided baseUrl", () => {
    const client = new RepramClient("http://custom:9090");
    // Exercise the client to check the URL
    mockFetch({ status: 200, json: { keys: [] } });
    client.listKeys();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      expect.stringContaining("http://custom:9090/v1/keys")
    );
  });

  it("strips trailing slash from baseUrl", () => {
    const client = new RepramClient("http://example.com/");
    mockFetch({ status: 200, json: { keys: [] } });
    client.listKeys();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      expect.stringContaining("http://example.com/v1/keys")
    );
  });

  it("defaults to localhost:8080 when no url provided", () => {
    const originalEnv = process.env.REPRAM_URL;
    delete process.env.REPRAM_URL;

    const client = new RepramClient();
    mockFetch({ status: 200, json: { keys: [] } });
    client.listKeys();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      expect.stringContaining("http://localhost:8080/v1/keys")
    );

    if (originalEnv !== undefined) process.env.REPRAM_URL = originalEnv;
  });
});

// --- store ---

describe("store", () => {
  it("sends PUT with correct URL, headers, and body", async () => {
    const fetchMock = mockFetch({ status: 201, statusText: "Created" });
    const client = new RepramClient("http://localhost:8080");

    const result = await client.store("my-key", "my-data", 600);

    expect(result).toEqual({ status: 201, statusText: "Created" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/v1/data/my-key",
      {
        method: "PUT",
        headers: {
          "X-TTL": "600",
          "Content-Type": "application/octet-stream",
        },
        body: "my-data",
      }
    );
  });

  it("encodes special characters in key", async () => {
    const fetchMock = mockFetch({ status: 201, statusText: "Created" });
    const client = new RepramClient("http://localhost:8080");

    await client.store("key with spaces", "data", 300);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/v1/data/key%20with%20spaces",
      expect.any(Object)
    );
  });

  it("returns 202 for quorum timeout", async () => {
    mockFetch({ status: 202, statusText: "Accepted" });
    const client = new RepramClient("http://localhost:8080");

    const result = await client.store("key", "data", 300);
    expect(result).toEqual({ status: 202, statusText: "Accepted" });
  });
});

// --- retrieve ---

describe("retrieve", () => {
  it("returns data with parsed headers on success", async () => {
    mockFetch({
      status: 200,
      headers: {
        "X-Created-At": "2026-02-25T12:00:00Z",
        "X-Remaining-TTL": "450",
        "X-Original-TTL": "3600",
      },
      body: "stored payload",
    });
    const client = new RepramClient("http://localhost:8080");

    const result = await client.retrieve("test-key");

    expect(result).toEqual({
      data: "stored payload",
      createdAt: "2026-02-25T12:00:00Z",
      remainingTtlSeconds: 450,
      originalTtlSeconds: 3600,
    });
  });

  it("returns null on 404", async () => {
    mockFetch({ status: 404, ok: false });
    const client = new RepramClient("http://localhost:8080");

    const result = await client.retrieve("missing-key");
    expect(result).toBeNull();
  });

  it("throws on non-404 error", async () => {
    mockFetch({ status: 500, statusText: "Internal Server Error", ok: false });
    const client = new RepramClient("http://localhost:8080");

    await expect(client.retrieve("bad-key")).rejects.toThrow("REPRAM retrieve failed: 500");
  });

  it("handles missing headers gracefully", async () => {
    mockFetch({
      status: 200,
      headers: {},
      body: "data",
    });
    const client = new RepramClient("http://localhost:8080");

    const result = await client.retrieve("key");

    expect(result).toEqual({
      data: "data",
      createdAt: "",
      remainingTtlSeconds: 0,
      originalTtlSeconds: 0,
    });
  });
});

// --- exists ---

describe("exists", () => {
  it("returns exists: true with TTL on success", async () => {
    mockFetch({
      status: 200,
      headers: { "X-Remaining-TTL": "120" },
    });
    const client = new RepramClient("http://localhost:8080");

    const result = await client.exists("present-key");
    expect(result).toEqual({ exists: true, remainingTtlSeconds: 120 });
  });

  it("sends HEAD request", async () => {
    const fetchMock = mockFetch({ status: 200, headers: { "X-Remaining-TTL": "60" } });
    const client = new RepramClient("http://localhost:8080");

    await client.exists("check-key");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/v1/data/check-key",
      { method: "HEAD" }
    );
  });

  it("returns exists: false on 404", async () => {
    mockFetch({ status: 404, ok: false });
    const client = new RepramClient("http://localhost:8080");

    const result = await client.exists("gone-key");
    expect(result).toEqual({ exists: false, remainingTtlSeconds: 0 });
  });

  it("throws on non-404 error", async () => {
    mockFetch({ status: 503, statusText: "Service Unavailable", ok: false });
    const client = new RepramClient("http://localhost:8080");

    await expect(client.exists("bad-key")).rejects.toThrow("REPRAM exists check failed: 503");
  });
});

// --- listKeys ---

describe("listKeys", () => {
  it("returns parsed keys array", async () => {
    mockFetch({ status: 200, json: { keys: ["key-1", "key-2"] } });
    const client = new RepramClient("http://localhost:8080");

    const result = await client.listKeys();
    expect(result).toEqual({ keys: ["key-1", "key-2"] });
  });

  it("sends prefix as query parameter", async () => {
    const fetchMock = mockFetch({ status: 200, json: { keys: ["ns-foo"] } });
    const client = new RepramClient("http://localhost:8080");

    await client.listKeys("ns-");

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("prefix=ns-");
  });

  it("omits prefix param when not provided", async () => {
    const fetchMock = mockFetch({ status: 200, json: { keys: [] } });
    const client = new RepramClient("http://localhost:8080");

    await client.listKeys();

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).not.toContain("prefix");
  });

  it("handles null keys in response body", async () => {
    mockFetch({ status: 200, json: { keys: null } });
    const client = new RepramClient("http://localhost:8080");

    const result = await client.listKeys();
    expect(result).toEqual({ keys: [] });
  });

  it("throws on error response", async () => {
    mockFetch({ status: 500, statusText: "Internal Server Error", ok: false });
    const client = new RepramClient("http://localhost:8080");

    await expect(client.listKeys()).rejects.toThrow("REPRAM list keys failed: 500");
  });
});
