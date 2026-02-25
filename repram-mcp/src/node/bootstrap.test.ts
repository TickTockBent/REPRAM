import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveBootstrapDNS, bootstrapFromPeers, notifyPeerAboutNewNode } from "./bootstrap.js";
import type { DnsResolver } from "./bootstrap.js";
import { Logger } from "./logger.js";
import type { NodeInfo } from "./types.js";

afterEach(() => {
  vi.restoreAllMocks();
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

// --- DNS resolution ---

describe("resolveBootstrapDNS", () => {
  it("resolves SRV records", async () => {
    const resolver: DnsResolver = {
      resolveSrv: vi.fn().mockResolvedValue([
        { name: "node1.example.com.", port: 8080 },
        { name: "node2.example.com.", port: 9090 },
      ]),
      resolve4: vi.fn(),
    };

    const logger = silentLogger();
    vi.spyOn(logger, "info").mockImplementation(() => {});

    const result = await resolveBootstrapDNS("example.com", 8080, logger, resolver);

    expect(result).toEqual(["node1.example.com:8080", "node2.example.com:9090"]);
  });

  it("falls back to A records when SRV fails", async () => {
    const resolver: DnsResolver = {
      resolveSrv: vi.fn().mockRejectedValue(new Error("ENOTFOUND")),
      resolve4: vi.fn().mockResolvedValue(["10.0.0.1", "10.0.0.2"]),
    };

    const logger = silentLogger();
    vi.spyOn(logger, "info").mockImplementation(() => {});

    const result = await resolveBootstrapDNS("example.com", 8080, logger, resolver);

    expect(result).toEqual(["10.0.0.1:8080", "10.0.0.2:8080"]);
  });

  it("returns empty array when all DNS fails", async () => {
    const resolver: DnsResolver = {
      resolveSrv: vi.fn().mockRejectedValue(new Error("ENOTFOUND")),
      resolve4: vi.fn().mockRejectedValue(new Error("ENOTFOUND")),
    };

    const logger = silentLogger();
    vi.spyOn(logger, "warn").mockImplementation(() => {});

    const result = await resolveBootstrapDNS("bogus.local", 8080, logger, resolver);

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("strips trailing dot from SRV target", async () => {
    const resolver: DnsResolver = {
      resolveSrv: vi.fn().mockResolvedValue([
        { name: "host.example.com.", port: 8080 },
      ]),
      resolve4: vi.fn(),
    };

    const logger = silentLogger();
    vi.spyOn(logger, "info").mockImplementation(() => {});

    const result = await resolveBootstrapDNS("example.com", 8080, logger, resolver);
    expect(result[0]).toBe("host.example.com:8080");
  });
});

// --- Bootstrap handshake ---

describe("bootstrapFromPeers", () => {
  it("returns discovered peers on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        peers: [
          { id: "peer-1", address: "10.0.0.1", port: 9090, http_port: 8080, enclave: "default" },
          { id: "peer-2", address: "10.0.0.2", port: 9090, http_port: 8080 },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        peers: [
          { id: "test-node", address: "localhost", port: 9090, http_port: 8080 },
          { id: "other-node", address: "10.0.0.2", port: 9090, http_port: 8080 },
        ],
      }),
    }));

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

  it("tries next seed on failure", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          peers: [{ id: "peer-1", address: "10.0.0.3", port: 9090, http_port: 8080 }],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

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
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns empty array when all seeds fail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("refused")));

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

  it("includes HMAC signature when secret is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, peers: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const logger = silentLogger();
    vi.spyOn(logger, "info").mockImplementation(() => {});

    await bootstrapFromPeers(
      ["10.0.0.1:8080"],
      makeLocalNode(),
      "cluster-secret",
      logger,
    );

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers["X-Repram-Signature"]).toBeDefined();
    expect(opts.headers["X-Repram-Signature"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sends correct bootstrap request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, peers: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const logger = silentLogger();
    vi.spyOn(logger, "info").mockImplementation(() => {});

    await bootstrapFromPeers(
      ["10.0.0.1:8080"],
      makeLocalNode({ id: "my-node", address: "192.168.1.1", port: 9091, httpPort: 8081, enclave: "prod" }),
      "",
      logger,
    );

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://10.0.0.1:8080/v1/bootstrap");
    const body = JSON.parse(opts.body);
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
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const logger = silentLogger();
    vi.spyOn(logger, "debug").mockImplementation(() => {});

    await notifyPeerAboutNewNode(
      "10.0.0.2:8080",
      { node_id: "new-node", address: "10.0.0.3", gossip_port: 9090, http_port: 8080 },
      "",
      logger,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("http://10.0.0.2:8080/v1/bootstrap");
  });

  it("retries on failure with backoff", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("fail1"))
      .mockRejectedValueOnce(new Error("fail2"))
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

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

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(2); // 2 retries

    vi.useRealTimers();
  });

  it("logs error after all retries exhausted", async () => {
    vi.useFakeTimers();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("permanent failure")));

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
