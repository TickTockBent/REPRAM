import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ClusterNode,
  WRITE_STATUS_CREATED,
  WRITE_STATUS_ACCEPTED,
} from "./cluster.js";
import { Logger } from "./logger.js";
import type { Transport } from "./gossip.js";
import type { Message, NodeInfo } from "./types.js";

function silentLogger(): Logger {
  return new Logger("error");
}

/**
 * Create a mock transport that captures sent messages and can deliver
 * ACKs back to simulate peer responses.
 */
function createMockTransport() {
  let messageHandler: ((msg: Message) => void) | null = null;
  const sentMessages: { target: NodeInfo; msg: Message }[] = [];

  const transport: Transport = {
    send: vi.fn(async (target: NodeInfo, msg: Message) => {
      sentMessages.push({ target, msg });
    }),
    setMessageHandler(handler: (msg: Message) => void) {
      messageHandler = handler;
    },
  };

  return {
    transport,
    sentMessages,
    /** Deliver a message as if it arrived from the network. */
    deliverMessage(msg: Message) {
      messageHandler?.(msg);
    },
  };
}

function defaultOptions(overrides = {}) {
  return {
    nodeId: "node-1",
    address: "localhost",
    gossipPort: 9090,
    httpPort: 8080,
    enclave: "default",
    replicationFactor: 3,
    writeTimeoutMs: 200, // short timeout for tests
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Quorum calculation ---

describe("ClusterNode quorum", () => {
  it("returns 1 for single node (no peers)", () => {
    const node = new ClusterNode(defaultOptions(), silentLogger());
    // No peers, replication=3 → min(1,3)=1 → floor(1/2)+1 = 1
    expect(node.quorumSize()).toBe(1);
  });

  it("returns 2 for two nodes, replication 3", () => {
    const node = new ClusterNode(defaultOptions(), silentLogger());
    const { transport } = createMockTransport();
    node.setTransport(transport);

    node.gossip.addPeer({
      id: "node-2",
      address: "localhost",
      port: 9091,
      httpPort: 8081,
      enclave: "default",
    });

    // min(2, 3) = 2 → floor(2/2)+1 = 2
    expect(node.quorumSize()).toBe(2);
    node.stop();
  });

  it("returns 2 for three nodes, replication 3", () => {
    const node = new ClusterNode(defaultOptions(), silentLogger());
    const { transport } = createMockTransport();
    node.setTransport(transport);

    node.gossip.addPeer({
      id: "node-2", address: "localhost", port: 9091, httpPort: 8081, enclave: "default",
    });
    node.gossip.addPeer({
      id: "node-3", address: "localhost", port: 9092, httpPort: 8082, enclave: "default",
    });

    // min(3, 3) = 3 → floor(3/2)+1 = 2
    expect(node.quorumSize()).toBe(2);
    node.stop();
  });

  it("ignores peers in different enclaves", () => {
    const node = new ClusterNode(
      defaultOptions({ enclave: "prod" }),
      silentLogger(),
    );
    const { transport } = createMockTransport();
    node.setTransport(transport);

    node.gossip.addPeer({
      id: "node-2", address: "localhost", port: 9091, httpPort: 8081, enclave: "staging",
    });

    // Only local node in "prod" enclave → quorum = 1
    expect(node.quorumSize()).toBe(1);
    node.stop();
  });

  it("adjusts as peers join", () => {
    const node = new ClusterNode(defaultOptions(), silentLogger());
    const { transport } = createMockTransport();
    node.setTransport(transport);

    expect(node.quorumSize()).toBe(1); // solo

    node.gossip.addPeer({
      id: "node-2", address: "localhost", port: 9091, httpPort: 8081, enclave: "default",
    });
    expect(node.quorumSize()).toBe(2); // 2 nodes

    node.gossip.addPeer({
      id: "node-3", address: "localhost", port: 9092, httpPort: 8082, enclave: "default",
    });
    expect(node.quorumSize()).toBe(2); // 3 nodes, repl=3 → 2

    node.stop();
  });
});

// --- Single-node writes ---

describe("ClusterNode single-node writes", () => {
  it("returns 201 immediately (quorum=1)", async () => {
    const node = new ClusterNode(defaultOptions(), silentLogger());
    const { transport } = createMockTransport();
    node.setTransport(transport);

    const result = await node.put("key1", Buffer.from("data"), 300);
    expect(result.status).toBe(WRITE_STATUS_CREATED);
    node.stop();
  });

  it("data is readable after write", async () => {
    const node = new ClusterNode(defaultOptions(), silentLogger());
    const { transport } = createMockTransport();
    node.setTransport(transport);

    await node.put("key1", Buffer.from("hello"), 300);

    const data = node.get("key1");
    expect(data).not.toBeNull();
    expect(data!.toString()).toBe("hello");
    node.stop();
  });
});

// --- Multi-node writes with quorum ---

describe("ClusterNode multi-node writes", () => {
  it("returns 201 after receiving quorum ACKs", async () => {
    const node = new ClusterNode(
      defaultOptions({ writeTimeoutMs: 2000 }),
      silentLogger(),
    );
    const { transport, sentMessages } = createMockTransport();
    node.setTransport(transport);

    // Add a peer so quorum = 2
    node.gossip.addPeer({
      id: "node-2", address: "localhost", port: 9091, httpPort: 8081, enclave: "default",
    });

    const writePromise = node.put("key1", Buffer.from("data"), 300);

    // Wait for the broadcast to happen
    await new Promise((r) => setTimeout(r, 10));

    // Find the PUT message that was sent
    const putMsg = sentMessages.find((s) => s.msg.type === "PUT");
    expect(putMsg).toBeDefined();

    // Simulate ACK from peer
    node.gossip.handleMessage({
      type: "ACK",
      from: "node-2",
      to: "node-1",
      key: "key1",
      data: Buffer.alloc(0),
      ttl: 0,
      messageId: putMsg!.msg.messageId,
      timestamp: new Date(),
    });

    const result = await writePromise;
    expect(result.status).toBe(WRITE_STATUS_CREATED);
    node.stop();
  });

  it("returns 202 on timeout", async () => {
    const node = new ClusterNode(
      defaultOptions({ writeTimeoutMs: 50 }), // very short timeout
      silentLogger(),
    );
    const { transport } = createMockTransport();
    node.setTransport(transport);

    // Add a peer so quorum = 2
    node.gossip.addPeer({
      id: "node-2", address: "localhost", port: 9091, httpPort: 8081, enclave: "default",
    });

    const result = await node.put("key1", Buffer.from("data"), 300);
    expect(result.status).toBe(WRITE_STATUS_ACCEPTED);

    // Data should still be stored locally
    expect(node.get("key1")?.toString()).toBe("data");
    node.stop();
  });

  it("concurrent writes to same key track independently via MessageID", async () => {
    const node = new ClusterNode(
      defaultOptions({ writeTimeoutMs: 500 }),
      silentLogger(),
    );
    const { transport, sentMessages } = createMockTransport();
    node.setTransport(transport);

    node.gossip.addPeer({
      id: "node-2", address: "localhost", port: 9091, httpPort: 8081, enclave: "default",
    });

    // Start two concurrent writes to the same key
    const write1 = node.put("shared-key", Buffer.from("value-1"), 300);
    const write2 = node.put("shared-key", Buffer.from("value-2"), 300);

    await new Promise((r) => setTimeout(r, 10));

    // Find the two PUT messages (they should have different MessageIDs)
    const putMessages = sentMessages.filter((s) => s.msg.type === "PUT");
    expect(putMessages.length).toBeGreaterThanOrEqual(2);

    const msgId1 = putMessages[0].msg.messageId;
    const msgId2 = putMessages[1].msg.messageId;
    expect(msgId1).not.toBe(msgId2);

    // ACK only the first write
    node.gossip.handleMessage({
      type: "ACK",
      from: "node-2",
      to: "node-1",
      key: "shared-key",
      data: Buffer.alloc(0),
      ttl: 0,
      messageId: msgId1,
      timestamp: new Date(),
    });

    const result1 = await write1;
    expect(result1.status).toBe(WRITE_STATUS_CREATED);

    // Second write should timeout (no ACK sent for it)
    const result2 = await write2;
    expect(result2.status).toBe(WRITE_STATUS_ACCEPTED);
    node.stop();
  });
});

// --- Receiving replicated writes ---

describe("ClusterNode incoming PUT handling", () => {
  it("stores replicated data and sends ACK", async () => {
    const node = new ClusterNode(defaultOptions(), silentLogger());
    const { transport, sentMessages } = createMockTransport();
    node.setTransport(transport);

    // Add the originator as a known peer
    node.gossip.addPeer({
      id: "node-2", address: "localhost", port: 9091, httpPort: 8081, enclave: "default",
    });

    // Simulate receiving a PUT from node-2
    node.gossip.handleMessage({
      type: "PUT",
      from: "node-2",
      to: "",
      key: "replicated-key",
      data: Buffer.from("replicated-data"),
      ttl: 300,
      messageId: "msg-123",
      timestamp: new Date(),
    });

    // Data should be stored locally
    await new Promise((r) => setTimeout(r, 10));
    expect(node.get("replicated-key")?.toString()).toBe("replicated-data");

    // Should have sent an ACK back to node-2
    const ackMessages = sentMessages.filter((s) => s.msg.type === "ACK");
    expect(ackMessages.length).toBeGreaterThanOrEqual(1);
    expect(ackMessages[0].msg.messageId).toBe("msg-123");
    expect(ackMessages[0].target.id).toBe("node-2");
    node.stop();
  });

  it("deduplicates replicated PUTs", () => {
    const node = new ClusterNode(defaultOptions(), silentLogger());
    const { transport, sentMessages } = createMockTransport();
    node.setTransport(transport);

    node.gossip.addPeer({
      id: "node-2", address: "localhost", port: 9091, httpPort: 8081, enclave: "default",
    });

    const putMsg: Message = {
      type: "PUT",
      from: "node-2",
      to: "",
      key: "dedup-key",
      data: Buffer.from("data"),
      ttl: 300,
      messageId: "dedup-msg-1",
      timestamp: new Date(),
    };

    // First delivery
    node.gossip.handleMessage(putMsg);
    const firstAckCount = sentMessages.filter((s) => s.msg.type === "ACK").length;

    // Second delivery (duplicate)
    node.gossip.handleMessage(putMsg);
    const secondAckCount = sentMessages.filter((s) => s.msg.type === "ACK").length;

    // Should not have sent an additional ACK for the duplicate
    expect(secondAckCount).toBe(firstAckCount);
    node.stop();
  });
});

// --- ACK handling edge cases ---

describe("ClusterNode ACK handling", () => {
  it("ignores ACK for unknown MessageID", () => {
    const node = new ClusterNode(defaultOptions(), silentLogger());
    const { transport } = createMockTransport();
    node.setTransport(transport);

    // Should not throw
    node.gossip.handleMessage({
      type: "ACK",
      from: "node-2",
      to: "node-1",
      key: "unknown-key",
      data: Buffer.alloc(0),
      ttl: 0,
      messageId: "nonexistent-msg-id",
      timestamp: new Date(),
    });

    expect(node.pendingWriteCount()).toBe(0);
    node.stop();
  });
});

// --- Read operations ---

describe("ClusterNode read operations", () => {
  it("get returns null for missing key", () => {
    const node = new ClusterNode(defaultOptions(), silentLogger());
    expect(node.get("nope")).toBeNull();
    node.stop();
  });

  it("exists checks key presence", async () => {
    const node = new ClusterNode(defaultOptions(), silentLogger());
    const { transport } = createMockTransport();
    node.setTransport(transport);

    await node.put("key1", Buffer.from("data"), 300);
    expect(node.exists("key1").exists).toBe(true);
    expect(node.exists("nope").exists).toBe(false);
    node.stop();
  });

  it("scan lists keys with prefix filter", async () => {
    const node = new ClusterNode(defaultOptions(), silentLogger());
    const { transport } = createMockTransport();
    node.setTransport(transport);

    await node.put("foo:1", Buffer.from("a"), 300);
    await node.put("foo:2", Buffer.from("b"), 300);
    await node.put("bar:1", Buffer.from("c"), 300);

    expect(node.scan("foo:").sort()).toEqual(["foo:1", "foo:2"]);
    expect(node.scan()).toHaveLength(3);
    node.stop();
  });

  it("getWithMetadata returns entry with TTL info", async () => {
    const node = new ClusterNode(defaultOptions(), silentLogger());
    const { transport } = createMockTransport();
    node.setTransport(transport);

    await node.put("key1", Buffer.from("data"), 300);
    const entry = node.getWithMetadata("key1");
    expect(entry).not.toBeNull();
    expect(entry!.ttlSeconds).toBe(300);
    expect(entry!.data.toString()).toBe("data");
    node.stop();
  });
});

// --- Lifecycle ---

describe("ClusterNode lifecycle", () => {
  it("stop resolves pending writes as 202", async () => {
    const node = new ClusterNode(
      defaultOptions({ writeTimeoutMs: 10_000 }),
      silentLogger(),
    );
    const { transport } = createMockTransport();
    node.setTransport(transport);

    node.gossip.addPeer({
      id: "node-2", address: "localhost", port: 9091, httpPort: 8081, enclave: "default",
    });

    const writePromise = node.put("key1", Buffer.from("data"), 300);

    // Stop while write is pending
    await new Promise((r) => setTimeout(r, 10));
    node.stop();

    const result = await writePromise;
    expect(result.status).toBe(WRITE_STATUS_ACCEPTED);
    expect(node.pendingWriteCount()).toBe(0);
  });

  it("accessors return expected values", () => {
    const node = new ClusterNode(
      defaultOptions({ enclave: "prod", clusterSecret: "secret123" }),
      silentLogger(),
    );

    expect(node.getEnclave()).toBe("prod");
    expect(node.getClusterSecret()).toBe("secret123");
    expect(node.topology()).toEqual([]);
    node.stop();
  });
});
