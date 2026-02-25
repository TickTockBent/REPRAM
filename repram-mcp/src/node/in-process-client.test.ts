import { describe, it, expect, afterEach, vi } from "vitest";
import { InProcessClient } from "../client.js";
import { ClusterNode } from "./cluster.js";
import { Logger } from "./logger.js";
import type { Transport } from "./gossip.js";
import type { Message, NodeInfo } from "./types.js";

function silentLogger(): Logger {
  return new Logger("error");
}

function mockTransport(): Transport {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    setMessageHandler: vi.fn(),
  };
}

function createNode(): ClusterNode {
  const node = new ClusterNode(
    {
      nodeId: "test-node",
      address: "localhost",
      gossipPort: 9090,
      httpPort: 8080,
      enclave: "default",
      replicationFactor: 3,
      writeTimeoutMs: 200,
    },
    silentLogger(),
  );
  node.setTransport(mockTransport());
  return node;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("InProcessClient", () => {
  it("store and retrieve round-trip", async () => {
    const node = createNode();
    const client = new InProcessClient(node);

    const storeResult = await client.store("key1", "hello world", 3600);
    expect(storeResult.status).toBe(201);
    expect(storeResult.statusText).toBe("Created");

    const retrieved = await client.retrieve("key1");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.data).toBe("hello world");
    expect(retrieved!.originalTtlSeconds).toBe(3600);
    expect(retrieved!.remainingTtlSeconds).toBeGreaterThan(0);
    expect(retrieved!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO format

    node.stop();
  });

  it("retrieve returns null for missing key", async () => {
    const node = createNode();
    const client = new InProcessClient(node);

    const result = await client.retrieve("nonexistent");
    expect(result).toBeNull();

    node.stop();
  });

  it("exists returns correct state", async () => {
    const node = createNode();
    const client = new InProcessClient(node);

    // Before storing
    const before = await client.exists("key1");
    expect(before.exists).toBe(false);
    expect(before.remainingTtlSeconds).toBe(0);

    // After storing
    await client.store("key1", "data", 3600);
    const after = await client.exists("key1");
    expect(after.exists).toBe(true);
    expect(after.remainingTtlSeconds).toBeGreaterThan(0);

    node.stop();
  });

  it("listKeys returns stored keys", async () => {
    const node = createNode();
    const client = new InProcessClient(node);

    await client.store("foo:1", "a", 3600);
    await client.store("foo:2", "b", 3600);
    await client.store("bar:1", "c", 3600);

    const all = await client.listKeys();
    expect(all.keys).toHaveLength(3);

    const filtered = await client.listKeys("foo:");
    expect(filtered.keys).toHaveLength(2);
    expect(filtered.keys.every((k) => k.startsWith("foo:"))).toBe(true);

    node.stop();
  });

  it("store returns 202 on quorum timeout", async () => {
    const node = new ClusterNode(
      {
        nodeId: "test-node",
        address: "localhost",
        gossipPort: 9090,
        httpPort: 8080,
        enclave: "default",
        replicationFactor: 3,
        writeTimeoutMs: 50, // very short
      },
      silentLogger(),
    );
    node.setTransport(mockTransport());

    // Add a peer so quorum > 1
    node.gossip.addPeer({
      id: "peer-1",
      address: "localhost",
      port: 9091,
      httpPort: 8081,
      enclave: "default",
    });

    const client = new InProcessClient(node);
    const result = await client.store("key1", "data", 3600);

    expect(result.status).toBe(202);
    expect(result.statusText).toBe("Accepted");

    // Data should still be stored locally
    const retrieved = await client.retrieve("key1");
    expect(retrieved).not.toBeNull();

    node.stop();
  });
});
