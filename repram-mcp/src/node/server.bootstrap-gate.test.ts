import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { HTTPServer, type ServerConfig } from "./server.js";
import { Logger } from "./logger.js";
import type { Transport } from "./gossip.js";

function silentLogger(): Logger {
  return new Logger("error");
}

function mockTransport(): Transport {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    setMessageHandler: vi.fn(),
  };
}

function publicConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    httpPort: 0,
    gossipPort: 9999,
    address: "localhost",
    nodeId: "bootstrap-gate-test",
    network: "public",
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
    inbound: "false",
    maxChildren: 100,
    pprofEnabled: false,
    pprofAddr: "127.0.0.1:0",
    ...overrides,
  };
}

function request(
  server: HTTPServer,
  method: string,
  path: string,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.getServer().address();
    if (!addr || typeof addr === "string") return reject(new Error("server not started"));
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        method,
        path,
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const bootstrapBody = JSON.stringify({
  node_id: "joiner",
  address: "x",
  gossip_port: 9090,
  http_port: 8080,
});

describe("bootstrap 403 gate (public network)", () => {
  let server: HTTPServer;

  beforeEach(async () => {
    server = new HTTPServer(publicConfig(), silentLogger());
    server.setTransport(mockTransport());
    await server.start();
  });
  afterEach(async () => {
    await server.stop();
  });

  it("rejects with 403 when the node is not a root", async () => {
    // Default state: isRoot() === false.
    expect(server.clusterNode.isRoot()).toBe(false);
    const res = await request(server, "POST", "/v1/bootstrap", bootstrapBody);
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: "not a bootstrap root" });
  });

  it("answers normally once the node is marked root", async () => {
    server.clusterNode.setRoot(true);
    const res = await request(server, "POST", "/v1/bootstrap", bootstrapBody);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.success).toBe(true);
  });
});

describe("bootstrap 403 gate (private network bypass)", () => {
  let server: HTTPServer;

  beforeEach(async () => {
    server = new HTTPServer(publicConfig({ network: "private" }), silentLogger());
    server.setTransport(mockTransport());
    await server.start();
  });
  afterEach(async () => {
    await server.stop();
  });

  it("answers bootstrap without a root flag — private networks bypass", async () => {
    expect(server.clusterNode.isRoot()).toBe(false);
    const res = await request(server, "POST", "/v1/bootstrap", bootstrapBody);
    expect(res.status).toBe(200);
  });
});
