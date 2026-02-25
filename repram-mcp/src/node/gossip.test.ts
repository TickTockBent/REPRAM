import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  GossipProtocol,
  fanoutSize,
  selectRandomPeers,
  generateMessageID,
  _resetMessageCounter,
  MAX_PING_FAILURES,
  FANOUT_THRESHOLD,
  MAX_SEEN_MESSAGES,
  SEEN_MESSAGE_TTL_MS,
  type Transport,
  type GossipMetrics,
} from "./gossip.js";
import { Logger } from "./logger.js";
import type { Message, NodeInfo } from "./types.js";

afterEach(() => {
  vi.restoreAllMocks();
  _resetMessageCounter();
});

function silentLogger(): Logger {
  return new Logger("error");
}

function makeNode(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    id: "local-node",
    address: "localhost",
    port: 9090,
    httpPort: 8080,
    enclave: "default",
    ...overrides,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    type: "PUT",
    from: "sender",
    to: "",
    key: "test-key",
    data: Buffer.from("hello"),
    ttl: 300,
    timestamp: new Date(),
    messageId: generateMessageID(),
    ...overrides,
  };
}

function mockTransport(): Transport & { send: ReturnType<typeof vi.fn> } {
  const handler = { fn: null as ((msg: Message) => void) | null };
  return {
    send: vi.fn().mockResolvedValue(undefined),
    setMessageHandler(h: (msg: Message) => void) {
      handler.fn = h;
    },
  };
}

function mockMetrics(): GossipMetrics & Record<string, ReturnType<typeof vi.fn>> {
  return {
    onPeersActive: vi.fn(),
    onPeerJoin: vi.fn(),
    onPeerEviction: vi.fn(),
    onPingFailure: vi.fn(),
  };
}

// --- fanoutSize ---

describe("fanoutSize", () => {
  it("returns 0 for empty or negative", () => {
    expect(fanoutSize(0)).toBe(0);
    expect(fanoutSize(-1)).toBe(0);
  });

  it("returns 1 for single peer", () => {
    expect(fanoutSize(1)).toBe(1);
  });

  it("returns ceil(sqrt(n))", () => {
    expect(fanoutSize(4)).toBe(2);  // sqrt(4) = 2
    expect(fanoutSize(10)).toBe(4); // sqrt(10) ≈ 3.16 → ceil = 4
    expect(fanoutSize(25)).toBe(5); // sqrt(25) = 5
    expect(fanoutSize(100)).toBe(10);
  });
});

// --- selectRandomPeers ---

describe("selectRandomPeers", () => {
  it("excludes the skip ID", () => {
    const peers = [
      makeNode({ id: "a" }),
      makeNode({ id: "b" }),
      makeNode({ id: "c" }),
    ];
    const selected = selectRandomPeers(peers, 10, "b");
    expect(selected).toHaveLength(2);
    expect(selected.map((p) => p.id)).not.toContain("b");
  });

  it("returns all candidates when n >= count", () => {
    const peers = [makeNode({ id: "a" }), makeNode({ id: "b" })];
    const selected = selectRandomPeers(peers, 5, "");
    expect(selected).toHaveLength(2);
  });

  it("returns exactly n when n < candidates", () => {
    const peers = Array.from({ length: 20 }, (_, i) =>
      makeNode({ id: `node-${i}` }),
    );
    const selected = selectRandomPeers(peers, 3, "");
    expect(selected).toHaveLength(3);
  });

  it("returns empty array when all peers are skipped", () => {
    const peers = [makeNode({ id: "only" })];
    expect(selectRandomPeers(peers, 5, "only")).toHaveLength(0);
  });
});

// --- generateMessageID ---

describe("generateMessageID", () => {
  it("produces unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateMessageID()));
    expect(ids.size).toBe(100);
  });

  it("matches expected format", () => {
    const id = generateMessageID();
    expect(id).toMatch(/^\d+-\d+$/);
  });
});

// --- Peer management ---

describe("GossipProtocol peer management", () => {
  it("adds and retrieves peers", () => {
    const proto = new GossipProtocol(makeNode(), 3, silentLogger());
    proto.addPeer(makeNode({ id: "peer-1" }));
    proto.addPeer(makeNode({ id: "peer-2" }));

    expect(proto.getPeers()).toHaveLength(2);
  });

  it("removes peers", () => {
    const proto = new GossipProtocol(makeNode(), 3, silentLogger());
    proto.addPeer(makeNode({ id: "peer-1" }));
    proto.addPeer(makeNode({ id: "peer-2" }));
    proto.removePeer("peer-1");

    expect(proto.getPeers()).toHaveLength(1);
    expect(proto.getPeers()[0].id).toBe("peer-2");
  });

  it("resets failure counter on re-add", () => {
    const proto = new GossipProtocol(makeNode(), 3, silentLogger());
    const transport = mockTransport();
    transport.send.mockRejectedValue(new Error("fail"));
    proto.setTransport(transport);

    proto.addPeer(makeNode({ id: "peer-1" }));
    // Simulate failure tracking
    proto.handleMessage(makeMessage({ type: "PING", from: "peer-1" }));
    // Re-add resets failures
    proto.addPeer(makeNode({ id: "peer-1" }));
    expect(proto.peerFailureCount("peer-1")).toBe(0);
  });

  it("getReplicationPeers filters by enclave", () => {
    const proto = new GossipProtocol(makeNode({ enclave: "prod" }), 3, silentLogger());
    proto.addPeer(makeNode({ id: "same-enclave", enclave: "prod" }));
    proto.addPeer(makeNode({ id: "diff-enclave", enclave: "staging" }));

    const replicationPeers = proto.getReplicationPeers();
    expect(replicationPeers).toHaveLength(1);
    expect(replicationPeers[0].id).toBe("same-enclave");
  });

  it("fires metrics callbacks on add/remove", () => {
    const proto = new GossipProtocol(makeNode(), 3, silentLogger());
    const metrics = mockMetrics();
    proto.enableMetrics(metrics);

    proto.addPeer(makeNode({ id: "peer-1" }));
    expect(metrics.onPeersActive).toHaveBeenCalledWith(1);
    expect(metrics.onPeerJoin).toHaveBeenCalledTimes(1);

    proto.removePeer("peer-1");
    expect(metrics.onPeersActive).toHaveBeenCalledWith(0);
  });
});

// --- Message routing ---

describe("GossipProtocol message handling", () => {
  it("responds to PING with PONG", () => {
    const proto = new GossipProtocol(makeNode({ id: "local" }), 3, silentLogger());
    const transport = mockTransport();
    proto.setTransport(transport);

    const peer = makeNode({ id: "sender-peer" });
    proto.addPeer(peer);

    proto.handleMessage(makeMessage({
      type: "PING",
      from: "sender-peer",
      to: "local",
    }));

    expect(transport.send).toHaveBeenCalledTimes(1);
    const [target, msg] = transport.send.mock.calls[0];
    expect(target.id).toBe("sender-peer");
    expect(msg.type).toBe("PONG");
    expect(msg.from).toBe("local");
    expect(msg.nodeInfo).toBeDefined();
  });

  it("ignores PING from unknown peer", () => {
    const proto = new GossipProtocol(makeNode(), 3, silentLogger());
    const transport = mockTransport();
    proto.setTransport(transport);

    proto.handleMessage(makeMessage({ type: "PING", from: "unknown" }));
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("PONG resets failure counter", () => {
    const proto = new GossipProtocol(makeNode(), 3, silentLogger());
    const transport = mockTransport();
    proto.setTransport(transport);
    proto.addPeer(makeNode({ id: "peer-1" }));

    // Simulate a failure
    (proto as any).peerFailures.set("peer-1", 2);
    expect(proto.peerFailureCount("peer-1")).toBe(2);

    proto.handleMessage(makeMessage({ type: "PONG", from: "peer-1" }));
    expect(proto.peerFailureCount("peer-1")).toBe(0);
  });

  it("PONG updates peer enclave if changed", () => {
    const proto = new GossipProtocol(makeNode(), 3, silentLogger());
    proto.addPeer(makeNode({ id: "peer-1", enclave: "default" }));

    proto.handleMessage(makeMessage({
      type: "PONG",
      from: "peer-1",
      nodeInfo: makeNode({ id: "peer-1", enclave: "prod" }),
    }));

    expect(proto.getPeers()[0].enclave).toBe("prod");
  });

  it("SYNC adds unknown peer", () => {
    const proto = new GossipProtocol(makeNode({ id: "local" }), 3, silentLogger());
    const transport = mockTransport();
    proto.setTransport(transport);

    proto.handleMessage(makeMessage({
      type: "SYNC",
      from: "new-peer",
      nodeInfo: makeNode({ id: "new-peer", enclave: "default" }),
    }));

    expect(proto.getPeers()).toHaveLength(1);
    expect(proto.getPeers()[0].id).toBe("new-peer");
  });

  it("SYNC ignores self", () => {
    const proto = new GossipProtocol(makeNode({ id: "local" }), 3, silentLogger());
    const transport = mockTransport();
    proto.setTransport(transport);

    proto.handleMessage(makeMessage({
      type: "SYNC",
      from: "local",
      nodeInfo: makeNode({ id: "local" }),
    }));

    expect(proto.getPeers()).toHaveLength(0);
  });

  it("SYNC updates enclave for existing peer", () => {
    const proto = new GossipProtocol(makeNode({ id: "local" }), 3, silentLogger());
    const transport = mockTransport();
    proto.setTransport(transport);
    proto.addPeer(makeNode({ id: "peer-1", enclave: "default" }));

    proto.handleMessage(makeMessage({
      type: "SYNC",
      from: "peer-1",
      nodeInfo: makeNode({ id: "peer-1", enclave: "prod" }),
    }));

    expect(proto.getPeers()[0].enclave).toBe("prod");
  });

  it("direct SYNC triggers respondWithPeerList", () => {
    const proto = new GossipProtocol(makeNode({ id: "local" }), 3, silentLogger());
    const transport = mockTransport();
    proto.setTransport(transport);

    // Add existing peer so we have something to respond with
    proto.addPeer(makeNode({ id: "existing-peer" }));

    // Receive a direct SYNC (From == NodeInfo.id)
    proto.handleMessage(makeMessage({
      type: "SYNC",
      from: "new-peer",
      nodeInfo: makeNode({ id: "new-peer" }),
    }));

    // Should have sent SYNC messages: one for "existing-peer" and one for "local" (ourselves)
    // Both sent to "new-peer"
    expect(transport.send.mock.calls.length).toBeGreaterThanOrEqual(2);
    const sentTypes = transport.send.mock.calls.map(
      ([, msg]: [NodeInfo, Message]) => msg.type,
    );
    expect(sentTypes.every((t: string) => t === "SYNC")).toBe(true);
  });

  it("propagated SYNC does NOT trigger respondWithPeerList (anti-amplification)", () => {
    const proto = new GossipProtocol(makeNode({ id: "local" }), 3, silentLogger());
    const transport = mockTransport();
    proto.setTransport(transport);
    proto.addPeer(makeNode({ id: "existing" }));

    // Propagated SYNC: From is different from NodeInfo.id
    proto.handleMessage(makeMessage({
      type: "SYNC",
      from: "relay-node",
      nodeInfo: makeNode({ id: "third-party" }),
    }));

    // Should NOT have sent any response messages
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("passes PUT messages to app handler", () => {
    const proto = new GossipProtocol(makeNode(), 3, silentLogger());
    let received: Message | null = null;
    proto.setMessageHandler((msg) => { received = msg; });

    const putMsg = makeMessage({ type: "PUT", key: "app-key" });
    proto.handleMessage(putMsg);

    expect(received).not.toBeNull();
    expect(received!.key).toBe("app-key");
  });

  it("passes ACK messages to app handler", () => {
    const proto = new GossipProtocol(makeNode(), 3, silentLogger());
    let received: Message | null = null;
    proto.setMessageHandler((msg) => { received = msg; });

    proto.handleMessage(makeMessage({ type: "ACK" }));
    expect(received).not.toBeNull();
    expect(received!.type).toBe("ACK");
  });

  it("does not crash when no handler is set", () => {
    const proto = new GossipProtocol(makeNode(), 3, silentLogger());
    // No handler set — should not throw
    proto.handleMessage(makeMessage({ type: "PUT" }));
  });
});

// --- Dedup cache ---

describe("markSeen", () => {
  it("returns false for new messages", () => {
    const proto = new GossipProtocol(makeNode(), 3, silentLogger());
    expect(proto.markSeen("msg-1")).toBe(false);
  });

  it("returns true for duplicate messages", () => {
    const proto = new GossipProtocol(makeNode(), 3, silentLogger());
    proto.markSeen("msg-1");
    expect(proto.markSeen("msg-1")).toBe(true);
  });

  it("evicts when exceeding MAX_SEEN_MESSAGES", () => {
    const proto = new GossipProtocol(makeNode(), 3, silentLogger());

    // Fill to capacity (this is a large loop but tests the eviction path)
    for (let i = 0; i < MAX_SEEN_MESSAGES; i++) {
      proto.markSeen(`msg-${i}`);
    }
    expect(proto.seenMessageCount()).toBe(MAX_SEEN_MESSAGES);

    // Adding one more triggers eviction
    proto.markSeen("overflow-msg");
    expect(proto.seenMessageCount()).toBeLessThan(MAX_SEEN_MESSAGES);
    // The new message should still be present
    expect(proto.markSeen("overflow-msg")).toBe(true);
  });
});

// --- Broadcasting ---

describe("broadcastToEnclave", () => {
  it("sends to all enclave peers when below threshold", async () => {
    const proto = new GossipProtocol(makeNode({ id: "local", enclave: "prod" }), 3, silentLogger());
    const transport = mockTransport();
    proto.setTransport(transport);

    // Add 3 same-enclave peers (below threshold of 10)
    for (let i = 0; i < 3; i++) {
      proto.addPeer(makeNode({ id: `peer-${i}`, enclave: "prod" }));
    }
    // Add 1 different-enclave peer
    proto.addPeer(makeNode({ id: "other-enclave", enclave: "staging" }));

    const msg = makeMessage({ messageId: "broadcast-1" });
    await proto.broadcastToEnclave(msg);

    // Should send to 3 same-enclave peers only
    expect(transport.send).toHaveBeenCalledTimes(3);
  });

  it("marks message as seen", async () => {
    const proto = new GossipProtocol(makeNode({ enclave: "default" }), 3, silentLogger());
    const transport = mockTransport();
    proto.setTransport(transport);

    const msg = makeMessage({ messageId: "should-be-seen" });
    await proto.broadcastToEnclave(msg);

    expect(proto.markSeen("should-be-seen")).toBe(true); // already seen
  });

  it("uses fanout for large enclaves", async () => {
    const proto = new GossipProtocol(makeNode({ id: "local", enclave: "default" }), 3, silentLogger());
    const transport = mockTransport();
    proto.setTransport(transport);

    // Add 20 same-enclave peers (above threshold of 10)
    for (let i = 0; i < 20; i++) {
      proto.addPeer(makeNode({ id: `peer-${i}`, enclave: "default" }));
    }

    const msg = makeMessage({ messageId: "fanout-1" });
    await proto.broadcastToEnclave(msg);

    // fanoutSize(20) = ceil(sqrt(20)) = 5
    expect(transport.send).toHaveBeenCalledTimes(5);
  });
});

describe("forwardToEnclave", () => {
  it("does nothing for small enclaves", async () => {
    const proto = new GossipProtocol(makeNode({ enclave: "default" }), 3, silentLogger());
    const transport = mockTransport();
    proto.setTransport(transport);

    proto.addPeer(makeNode({ id: "peer-1", enclave: "default" }));

    await proto.forwardToEnclave(makeMessage());
    expect(transport.send).not.toHaveBeenCalled();
  });

  it("forwards to √N peers in large enclaves, excluding sender", async () => {
    const proto = new GossipProtocol(makeNode({ id: "local", enclave: "default" }), 3, silentLogger());
    const transport = mockTransport();
    proto.setTransport(transport);

    for (let i = 0; i < 15; i++) {
      proto.addPeer(makeNode({ id: `peer-${i}`, enclave: "default" }));
    }

    const msg = makeMessage({ from: "peer-0" });
    await proto.forwardToEnclave(msg);

    // fanoutSize(15) = ceil(sqrt(15)) = 4
    expect(transport.send).toHaveBeenCalledTimes(4);
    // None of the targets should be the sender
    for (const call of transport.send.mock.calls) {
      const [target] = call as [NodeInfo, Message];
      expect(target.id).not.toBe("peer-0");
    }
  });
});

// --- Lifecycle ---

describe("GossipProtocol lifecycle", () => {
  it("start throws if transport not set", () => {
    const proto = new GossipProtocol(makeNode(), 3, silentLogger());
    expect(() => proto.start()).toThrow("transport not set");
  });

  it("start and stop manage timers", () => {
    vi.useFakeTimers();
    const proto = new GossipProtocol(makeNode(), 3, silentLogger());
    const transport = mockTransport();
    proto.setTransport(transport);

    proto.start();
    proto.stop();

    vi.useRealTimers();
  });

  it("health check pings peers periodically", async () => {
    vi.useFakeTimers();
    const proto = new GossipProtocol(makeNode({ id: "local" }), 3, silentLogger());
    const transport = mockTransport();
    proto.setTransport(transport);
    proto.addPeer(makeNode({ id: "peer-1" }));

    proto.start();

    // Advance 30s to trigger health check
    await vi.advanceTimersByTimeAsync(30_000);

    // Should have pinged peer-1
    const pingCalls = transport.send.mock.calls.filter(
      ([, msg]: [NodeInfo, Message]) => msg.type === "PING",
    );
    expect(pingCalls.length).toBeGreaterThanOrEqual(1);

    proto.stop();
    vi.useRealTimers();
  });

  it("evicts peer after MAX_PING_FAILURES", async () => {
    vi.useFakeTimers();
    const proto = new GossipProtocol(makeNode({ id: "local" }), 3, silentLogger());
    const logger = silentLogger();
    vi.spyOn(logger, "info").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});

    const transport = mockTransport();
    transport.send.mockRejectedValue(new Error("connection refused"));
    proto.setTransport(transport);
    proto.addPeer(makeNode({ id: "dead-peer" }));

    const metrics = mockMetrics();
    proto.enableMetrics(metrics);

    proto.start();

    // Advance through 3 health check intervals (3 × 30s = 90s)
    for (let i = 0; i < MAX_PING_FAILURES; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }

    expect(proto.getPeers()).toHaveLength(0);
    expect(metrics.onPeerEviction).toHaveBeenCalled();
    expect(metrics.onPingFailure).toHaveBeenCalled();

    proto.stop();
    vi.useRealTimers();
  });

  it("topology sync sends SYNC when peers < expected", async () => {
    vi.useFakeTimers();
    // replicationFactor=3 means we expect 2 peers
    const proto = new GossipProtocol(makeNode({ id: "local" }), 3, silentLogger());
    const transport = mockTransport();
    proto.setTransport(transport);

    // Only add 1 peer (below expected 2)
    proto.addPeer(makeNode({ id: "peer-1" }));

    proto.start();

    // Advance 30s to trigger topology sync
    await vi.advanceTimersByTimeAsync(30_000);

    // Should have sent a SYNC to peer-1 (from topology sync) and a PING (from health check)
    const syncCalls = transport.send.mock.calls.filter(
      ([, msg]: [NodeInfo, Message]) => msg.type === "SYNC",
    );
    expect(syncCalls.length).toBeGreaterThanOrEqual(1);

    // Verify the SYNC includes our node info
    const [, syncMsg] = syncCalls[0] as [NodeInfo, Message];
    expect(syncMsg.nodeInfo).toBeDefined();
    expect(syncMsg.nodeInfo!.id).toBe("local");

    proto.stop();
    vi.useRealTimers();
  });

  it("topology sync does NOT send when peers >= expected", async () => {
    vi.useFakeTimers();
    const proto = new GossipProtocol(makeNode({ id: "local" }), 3, silentLogger());
    const transport = mockTransport();
    proto.setTransport(transport);

    // Add 2 peers (meets expected replicationFactor - 1)
    proto.addPeer(makeNode({ id: "peer-1" }));
    proto.addPeer(makeNode({ id: "peer-2" }));

    proto.start();

    await vi.advanceTimersByTimeAsync(30_000);

    // Should only have PINGs, no SYNCs from topology sync
    const syncCalls = transport.send.mock.calls.filter(
      ([, msg]: [NodeInfo, Message]) => msg.type === "SYNC",
    );
    expect(syncCalls).toHaveLength(0);

    proto.stop();
    vi.useRealTimers();
  });
});
