import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { HTTPServer, type ServerConfig } from "./server.js";
import { Logger } from "./logger.js";
import type { Transport } from "./gossip.js";
import type { Message, NodeInfo } from "./types.js";
import http from "node:http";

// ─── Test infrastructure ─────────────────────────────────────────────

function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    httpPort: 0, // random port
    gossipPort: 9999,
    address: "localhost",
    nodeId: "test-node",
    network: "test",
    enclave: "default",
    replicationFactor: 3,
    minTTL: 60,
    maxTTL: 86400,
    writeTimeoutMs: 200,
    clusterSecret: "",
    rateLimit: 1000,
    trustProxy: false,
    maxStorageBytes: 0,
    logLevel: "error",
    ...overrides,
  };
}

function mockTransport(): Transport {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    setMessageHandler: vi.fn(),
  };
}

function silentLogger(): Logger {
  return new Logger("error");
}

/** Make an HTTP request to the test server. */
function request(
  server: HTTPServer,
  method: string,
  path: string,
  options: {
    body?: string | Buffer;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.getServer().address();
    if (!addr || typeof addr === "string") {
      reject(new Error("Server not started"));
      return;
    }

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        method,
        path,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ─── Tests ───────────────────────────────────────────────────────────

let server: HTTPServer;

beforeAll(async () => {
  server = new HTTPServer(testConfig(), silentLogger());
  server.setTransport(mockTransport());
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

// --- Health & Status ---

describe("health endpoint", () => {
  it("returns node info", async () => {
    const res = await request(server, "GET", "/v1/health");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("healthy");
    expect(body.node_id).toBe("test-node");
    expect(body.network).toBe("test");
    expect(body.enclave).toBe("default");
  });
});

describe("status endpoint", () => {
  it("returns uptime and memory", async () => {
    const res = await request(server, "GET", "/v1/status");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.node_id).toBe("test-node");
    expect(body.uptime).toBeDefined();
    expect(body.memory.rss).toBeGreaterThan(0);
    expect(body.memory.heap_used).toBeGreaterThan(0);
  });
});

// --- PUT/GET round-trip ---

describe("PUT handler", () => {
  it("returns 201 for single-node write", async () => {
    const res = await request(server, "PUT", "/v1/data/test-key", {
      body: "hello world",
      headers: { "X-TTL": "3600" },
    });
    expect(res.status).toBe(201);
    expect(res.body).toBe("OK");
  });

  it("reads TTL from query param", async () => {
    const res = await request(server, "PUT", "/v1/data/ttl-query?ttl=600", {
      body: "data",
    });
    expect(res.status).toBe(201);
  });

  it("clamps TTL to min bound", async () => {
    const res = await request(server, "PUT", "/v1/data/ttl-min?ttl=1", {
      body: "data",
    });
    expect(res.status).toBe(201);

    // Verify the actual TTL was clamped (minTTL=60)
    const getRes = await request(server, "GET", "/v1/data/ttl-min");
    expect(parseInt(getRes.headers["x-original-ttl"] as string)).toBe(60);
  });

  it("clamps TTL to max bound", async () => {
    await request(server, "PUT", "/v1/data/ttl-max?ttl=999999", {
      body: "data",
    });
    const getRes = await request(server, "GET", "/v1/data/ttl-max");
    expect(parseInt(getRes.headers["x-original-ttl"] as string)).toBe(86400);
  });
});

describe("GET handler", () => {
  it("returns stored data with metadata headers", async () => {
    await request(server, "PUT", "/v1/data/get-test", {
      body: "test-data",
      headers: { "X-TTL": "3600" },
    });

    const res = await request(server, "GET", "/v1/data/get-test");
    expect(res.status).toBe(200);
    expect(res.body).toBe("test-data");
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["x-created-at"]).toBeDefined();
    expect(res.headers["x-original-ttl"]).toBeDefined();
    expect(res.headers["x-remaining-ttl"]).toBeDefined();
    expect(parseInt(res.headers["content-length"] as string)).toBe(9);
  });

  it("returns 404 for missing key", async () => {
    const res = await request(server, "GET", "/v1/data/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("HEAD handler", () => {
  it("returns headers without body", async () => {
    await request(server, "PUT", "/v1/data/head-test", {
      body: "head-data",
      headers: { "X-TTL": "3600" },
    });

    const res = await request(server, "HEAD", "/v1/data/head-test");
    expect(res.status).toBe(200);
    expect(res.headers["x-original-ttl"]).toBeDefined();
    expect(res.body).toBe(""); // HEAD has no body
  });

  it("returns 404 for missing key", async () => {
    const res = await request(server, "HEAD", "/v1/data/missing-head");
    expect(res.status).toBe(404);
  });
});

// --- Keys with pagination ---

describe("keys handler", () => {
  it("lists all keys", async () => {
    // Store some keys
    await request(server, "PUT", "/v1/data/keys:a", { body: "a" });
    await request(server, "PUT", "/v1/data/keys:b", { body: "b" });
    await request(server, "PUT", "/v1/data/keys:c", { body: "c" });

    const res = await request(server, "GET", "/v1/keys?prefix=keys:");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.keys).toEqual(["keys:a", "keys:b", "keys:c"]);
  });

  it("filters by prefix", async () => {
    await request(server, "PUT", "/v1/data/pfx:x", { body: "x" });
    await request(server, "PUT", "/v1/data/other:y", { body: "y" });

    const res = await request(server, "GET", "/v1/keys?prefix=pfx:");
    const body = JSON.parse(res.body);
    expect(body.keys).toEqual(["pfx:x"]);
  });

  it("paginates with limit and cursor", async () => {
    await request(server, "PUT", "/v1/data/pg:1", { body: "1" });
    await request(server, "PUT", "/v1/data/pg:2", { body: "2" });
    await request(server, "PUT", "/v1/data/pg:3", { body: "3" });

    // First page
    const page1 = await request(server, "GET", "/v1/keys?prefix=pg:&limit=2");
    const body1 = JSON.parse(page1.body);
    expect(body1.keys).toEqual(["pg:1", "pg:2"]);
    expect(body1.next_cursor).toBe("pg:2");

    // Second page
    const page2 = await request(
      server,
      "GET",
      `/v1/keys?prefix=pg:&limit=2&cursor=${body1.next_cursor}`,
    );
    const body2 = JSON.parse(page2.body);
    expect(body2.keys).toEqual(["pg:3"]);
    expect(body2.next_cursor).toBeUndefined();
  });
});

// --- Topology ---

describe("topology endpoint", () => {
  it("returns node info and empty peer list", async () => {
    const res = await request(server, "GET", "/v1/topology");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.node_id).toBe("test-node");
    expect(body.enclave).toBe("default");
    expect(body.peers).toEqual([]);
  });
});

// --- CORS ---

describe("CORS", () => {
  it("OPTIONS returns 200 with CORS headers", async () => {
    const res = await request(server, "OPTIONS", "/v1/health", {
      headers: { Origin: "https://example.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://example.com");
    expect(res.headers["access-control-allow-methods"]).toContain("PUT");
  });

  it("GET responses include CORS headers", async () => {
    const res = await request(server, "GET", "/v1/health", {
      headers: { Origin: "https://example.com" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("https://example.com");
  });
});

// --- Security ---

describe("security headers", () => {
  it("includes security headers on responses", async () => {
    const res = await request(server, "GET", "/v1/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });
});

// --- Gossip signature verification ---

describe("gossip endpoint", () => {
  it("accepts gossip messages in open mode", async () => {
    const wireMsg = JSON.stringify({
      type: "PING",
      from: "remote-node",
      timestamp: Math.floor(Date.now() / 1000),
      message_id: "test-msg-1",
    });

    const res = await request(server, "POST", "/v1/gossip/message", {
      body: wireMsg,
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it("rejects invalid JSON", async () => {
    const res = await request(server, "POST", "/v1/gossip/message", {
      body: "not json",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });
});

describe("gossip with cluster secret", () => {
  let securedServer: HTTPServer;

  beforeAll(async () => {
    securedServer = new HTTPServer(
      testConfig({ httpPort: 0, clusterSecret: "test-secret" }),
      silentLogger(),
    );
    securedServer.setTransport(mockTransport());
    await securedServer.start();
  });

  afterAll(async () => {
    await securedServer.stop();
  });

  it("rejects gossip without signature", async () => {
    const res = await request(securedServer, "POST", "/v1/gossip/message", {
      body: JSON.stringify({ type: "PING", from: "x", timestamp: 0, message_id: "y" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain("Missing signature");
  });

  it("rejects gossip with bad signature", async () => {
    const res = await request(securedServer, "POST", "/v1/gossip/message", {
      body: JSON.stringify({ type: "PING", from: "x", timestamp: 0, message_id: "y" }),
      headers: {
        "Content-Type": "application/json",
        "X-Repram-Signature": "deadbeef",
      },
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain("Invalid signature");
  });
});

// --- 404 ---

describe("routing", () => {
  it("returns 404 for unknown paths", async () => {
    const res = await request(server, "GET", "/v1/unknown");
    expect(res.status).toBe(404);
  });
});
