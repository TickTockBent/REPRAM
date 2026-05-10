import { describe, it, expect, vi, afterEach } from "vitest";
import { Logger } from "./logger.js";
import type { NodeInfo } from "./types.js";

const mockHttpPost = vi.fn();

vi.mock("./transport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transport.js")>();
  return {
    ...actual,
    httpPost: mockHttpPost,
  };
});

const { bootstrapFromPeers, notifyPeerAboutNewNode } = await import("./bootstrap.js");

afterEach(() => {
  vi.restoreAllMocks();
  mockHttpPost.mockReset();
});

function silentLogger(): Logger {
  return new Logger("error");
}

function makeLocalNode(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    id: "test-node",
    address: "localhost",
    port: 9090,
    httpPort: 8080,
    enclave: "default",
    ...overrides,
  };
}

function mockSuccessResponse(peers: unknown[]) {
  return { statusCode: 200, body: JSON.stringify({ success: true, peers }) };
}

// Note: the omega-based signed-root-list discovery path
// (resolveOmegaBootstrap) is exercised under src/node/trust/ — see
// resolver.test.ts, cache.test.ts, and refresher.test.ts. The legacy
// unsigned-DNS path was removed as part of REPRAM 2.1.

// --- Bootstrap handshake ---

describe("bootstrapFromPeers", () => {
  it("returns discovered peers on success", async () => {
    mockHttpPost.mockResolvedValue(mockSuccessResponse([
      { id: "peer-1", address: "10.0.0.1", port: 9090, http_port: 8080, enclave: "default" },
      { id: "peer-2", address: "10.0.0.2", port: 9090, http_port: 8080 },
    ]));

    const logger = silentLogger();
    vi.spyOn(logger, "info").mockImplementation(() => {});

    const peers = await bootstrapFromPeers(
      ["10.0.0.1:8080"],
      makeLocalNode(),
      "",
      logger,
    );

    expect(peers).toHaveLength(2);
    expect(peers[0].id).toBe("peer-1");
    expect(peers[1].enclave).toBe("default"); // defaults when missing
  });

  it("filters out self from discovered peers", async () => {
    mockHttpPost.mockResolvedValue(mockSuccessResponse([
      { id: "test-node", address: "localhost", port: 9090, http_port: 8080 },
      { id: "other-node", address: "10.0.0.2", port: 9090, http_port: 8080 },
    ]));

    const logger = silentLogger();
    vi.spyOn(logger, "info").mockImplementation(() => {});

    const peers = await bootstrapFromPeers(
      ["10.0.0.1:8080"],
      makeLocalNode({ id: "test-node" }),
      "",
      logger,
    );

    expect(peers).toHaveLength(1);
    expect(peers[0].id).toBe("other-node");
  });

  it("continues to next seed on failure", async () => {
    mockHttpPost
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce(mockSuccessResponse([
        { id: "peer-1", address: "10.0.0.3", port: 9090, http_port: 8080 },
      ]));

    const logger = silentLogger();
    vi.spyOn(logger, "info").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});

    const peers = await bootstrapFromPeers(
      ["10.0.0.1:8080", "10.0.0.2:8080"],
      makeLocalNode(),
      "",
      logger,
    );

    expect(peers).toHaveLength(1);
    expect(mockHttpPost).toHaveBeenCalledTimes(2);
  });

  // #82 (F3): the old loop returned after the first successful seed,
  // leaving later seeds unaware of the joiner until topology sync. The
  // fixed loop contacts every seed.
  it("contacts every seed even after the first succeeds", async () => {
    mockHttpPost.mockResolvedValue(mockSuccessResponse([
      { id: "shared", address: "10.0.0.9", port: 9090, http_port: 8080 },
    ]));

    const logger = silentLogger();
    vi.spyOn(logger, "info").mockImplementation(() => {});

    await bootstrapFromPeers(
      ["seed-a:8080", "seed-b:8080", "seed-c:8080"],
      makeLocalNode(),
      "",
      logger,
    );

    expect(mockHttpPost).toHaveBeenCalledTimes(3);
    const urls = mockHttpPost.mock.calls.map((c) => c[0]);
    expect(urls).toContain("http://seed-a:8080/v1/bootstrap");
    expect(urls).toContain("http://seed-b:8080/v1/bootstrap");
    expect(urls).toContain("http://seed-c:8080/v1/bootstrap");
  });

  // #87 (F7): when the seed list contains the bootstrapping node's own
  // advertised address (always true for omega-listed roots), the loop
  // must skip it — otherwise the node POSTs a bootstrap to itself and
  // pollutes its peer map with self.
  it("skips self in the seed list", async () => {
    mockHttpPost.mockResolvedValue(mockSuccessResponse([
      { id: "other", address: "10.0.0.2", port: 9090, http_port: 8080 },
    ]));

    const logger = silentLogger();
    vi.spyOn(logger, "info").mockImplementation(() => {});
    vi.spyOn(logger, "debug").mockImplementation(() => {});

    const local = makeLocalNode({ address: "10.0.0.1", httpPort: 8080 });
    await bootstrapFromPeers(
      ["10.0.0.1:8080", "real-seed:8080"],
      local,
      "",
      logger,
    );

    expect(mockHttpPost).toHaveBeenCalledTimes(1);
    expect(mockHttpPost.mock.calls[0][0]).toBe("http://real-seed:8080/v1/bootstrap");
  });

  // #82 (F4): when multiple seeds report the same peer, the caller
  // returns it once. (The seed legitimately includes its own localNode in
  // the response — that's how a single-seed bootstrap learns about the
  // seed at all — so dedup runs on the caller side.)
  it("dedupes peers reported by multiple seeds", async () => {
    mockHttpPost.mockResolvedValue(mockSuccessResponse([
      { id: "shared", address: "10.0.0.9", port: 9090, http_port: 8080 },
    ]));

    const logger = silentLogger();
    vi.spyOn(logger, "info").mockImplementation(() => {});

    const peers = await bootstrapFromPeers(
      ["seed-a:8080", "seed-b:8080", "seed-c:8080"],
      makeLocalNode(),
      "",
      logger,
    );

    expect(peers).toHaveLength(1);
    expect(peers[0].id).toBe("shared");
  });

  it("returns empty array when all seeds fail", async () => {
    mockHttpPost.mockRejectedValue(new Error("refused"));

    const logger = silentLogger();
    vi.spyOn(logger, "info").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});

    const peers = await bootstrapFromPeers(
      ["bad1:8080", "bad2:8080"],
      makeLocalNode(),
      "",
      logger,
    );

    expect(peers).toEqual([]);
  });

  it("includes HMAC signature in headers", async () => {
    mockHttpPost.mockResolvedValue(mockSuccessResponse([]));

    const logger = silentLogger();
    vi.spyOn(logger, "info").mockImplementation(() => {});

    await bootstrapFromPeers(
      ["10.0.0.1:8080"],
      makeLocalNode(),
      "cluster-secret",
      logger,
    );

    const headers = mockHttpPost.mock.calls[0][2];
    expect(headers["X-Repram-Signature"]).toBeDefined();
    expect(headers["X-Repram-Signature"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sends correct bootstrap request body", async () => {
    mockHttpPost.mockResolvedValue(mockSuccessResponse([]));

    const logger = silentLogger();
    vi.spyOn(logger, "info").mockImplementation(() => {});

    await bootstrapFromPeers(
      ["10.0.0.1:8080"],
      makeLocalNode({ id: "my-node", address: "192.168.1.1", port: 9091, httpPort: 8081, enclave: "prod" }),
      "",
      logger,
    );

    const [url, bodyStr] = mockHttpPost.mock.calls[0];
    expect(url).toBe("http://10.0.0.1:8080/v1/bootstrap");
    const body = JSON.parse(bodyStr);
    expect(body.node_id).toBe("my-node");
    expect(body.address).toBe("192.168.1.1");
    expect(body.gossip_port).toBe(9091);
    expect(body.http_port).toBe(8081);
    expect(body.enclave).toBe("prod");
  });
});

// --- Notify peers ---

describe("notifyPeerAboutNewNode", () => {
  it("sends bootstrap request to peer", async () => {
    mockHttpPost.mockResolvedValue({ statusCode: 200, body: "" });

    const logger = silentLogger();
    vi.spyOn(logger, "debug").mockImplementation(() => {});

    await notifyPeerAboutNewNode(
      "10.0.0.2:8080",
      { node_id: "new-node", address: "10.0.0.3", gossip_port: 9090, http_port: 8080 },
      "",
      logger,
    );

    expect(mockHttpPost).toHaveBeenCalledTimes(1);
    const [url] = mockHttpPost.mock.calls[0];
    expect(url).toBe("http://10.0.0.2:8080/v1/bootstrap");
  });

  it("retries on failure with backoff", async () => {
    vi.useFakeTimers();

    mockHttpPost
      .mockRejectedValueOnce(new Error("fail1"))
      .mockRejectedValueOnce(new Error("fail2"))
      .mockResolvedValueOnce({ statusCode: 200, body: "" });

    const logger = silentLogger();
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "debug").mockImplementation(() => {});

    const notifyPromise = notifyPeerAboutNewNode(
      "10.0.0.2:8080",
      { node_id: "new", address: "10.0.0.3", gossip_port: 9090, http_port: 8080 },
      "",
      logger,
      3,
    );

    // First attempt fails immediately, then 1s backoff
    await vi.advanceTimersByTimeAsync(1_000);
    // Second attempt fails, then 2s backoff
    await vi.advanceTimersByTimeAsync(2_000);
    // Third attempt succeeds

    await notifyPromise;

    expect(mockHttpPost).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(2); // 2 retries

    vi.useRealTimers();
  });

  it("logs error after all retries exhausted", async () => {
    vi.useFakeTimers();

    mockHttpPost.mockRejectedValue(new Error("permanent failure"));

    const logger = silentLogger();
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "error").mockImplementation(() => {});

    const notifyPromise = notifyPeerAboutNewNode(
      "10.0.0.2:8080",
      { node_id: "new", address: "10.0.0.3", gossip_port: 9090, http_port: 8080 },
      "",
      logger,
      2,
    );

    // 1st attempt fails, 1s backoff
    await vi.advanceTimersByTimeAsync(1_000);
    // 2nd attempt fails (last) — logs error

    await notifyPromise;

    expect(logger.error).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});
