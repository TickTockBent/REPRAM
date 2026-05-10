import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { Logger } from "./logger.js";
import type { Message, NodeInfo, WireMessage } from "./types.js";

const mockRequest = vi.fn();

class MockAgent {
  destroy = vi.fn();
}

vi.mock("node:http", () => ({
  request: mockRequest,
  Agent: MockAgent,
}));

// Import after mock so the module picks up the mocked http
const { HTTPTransport, messageToWire, wireToMessage, httpPost } = await import("./transport.js");

afterEach(() => {
  vi.restoreAllMocks();
  mockRequest.mockReset();
});

function makeNodeInfo(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    id: "node-1",
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
    from: "node-1",
    to: "",
    key: "test-key",
    data: Buffer.from("hello"),
    ttl: 300,
    timestamp: new Date("2026-02-25T12:00:00Z"),
    messageId: "1740484800000000000-0",
    ...overrides,
  };
}

/**
 * Sets up mockRequest to simulate a successful or failing HTTP response.
 * Returns the fake request object for assertions.
 */
function setupMockRequest(statusCode: number, responseBody = "") {
  const req = new EventEmitter() as EventEmitter & {
    end: ReturnType<typeof vi.fn>;
    setTimeout: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  req.end = vi.fn();
  req.setTimeout = vi.fn();
  req.destroy = vi.fn();

  mockRequest.mockImplementation((_opts: unknown, callback: (res: unknown) => void) => {
    process.nextTick(() => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number };
      res.statusCode = statusCode;
      callback(res);
      process.nextTick(() => {
        if (responseBody) res.emit("data", Buffer.from(responseBody));
        res.emit("end");
      });
    });
    return req;
  });

  return req;
}

// --- Serialization ---

describe("messageToWire", () => {
  it("converts Message to WireMessage with base64 data", () => {
    const msg = makeMessage();
    const wire = messageToWire(msg);

    expect(wire.type).toBe("PUT");
    expect(wire.from).toBe("node-1");
    expect(wire.key).toBe("test-key");
    expect(wire.data).toBe(Buffer.from("hello").toString("base64"));
    expect(wire.ttl).toBe(300);
    expect(wire.timestamp).toBe(Math.floor(new Date("2026-02-25T12:00:00Z").getTime() / 1000));
    expect(wire.message_id).toBe("1740484800000000000-0");
  });

  it("omits empty optional fields", () => {
    const msg = makeMessage({ to: "", key: "", data: Buffer.alloc(0), ttl: 0, nodeInfo: undefined });
    const wire = messageToWire(msg);

    expect(wire.to).toBeUndefined();
    expect(wire.key).toBeUndefined();
    expect(wire.data).toBeUndefined();
    expect(wire.ttl).toBeUndefined();
    expect(wire.node_info).toBeUndefined();
  });

  it("includes node_info when present", () => {
    const msg = makeMessage({
      type: "SYNC",
      nodeInfo: makeNodeInfo({ id: "sender", enclave: "prod" }),
    });
    const wire = messageToWire(msg);

    expect(wire.node_info).toBeDefined();
    expect(wire.node_info!.id).toBe("sender");
    expect(wire.node_info!.http_port).toBe(8080);
    expect(wire.node_info!.enclave).toBe("prod");
  });

  it("omits enclave from node_info when empty", () => {
    const msg = makeMessage({
      type: "SYNC",
      nodeInfo: makeNodeInfo({ enclave: "" }),
    });
    const wire = messageToWire(msg);
    expect(wire.node_info!.enclave).toBeUndefined();
  });
});

describe("wireToMessage", () => {
  it("converts WireMessage to Message with decoded data", () => {
    const wire: WireMessage = {
      type: "PUT",
      from: "node-1",
      key: "test-key",
      data: Buffer.from("hello").toString("base64"),
      ttl: 300,
      timestamp: 1740484800,
      message_id: "123-0",
    };

    const msg = wireToMessage(wire);

    expect(msg.type).toBe("PUT");
    expect(msg.from).toBe("node-1");
    expect(msg.key).toBe("test-key");
    expect(msg.data.toString()).toBe("hello");
    expect(msg.ttl).toBe(300);
    expect(msg.timestamp.toISOString()).toBe("2025-02-25T12:00:00.000Z");
    expect(msg.messageId).toBe("123-0");
  });

  it("handles missing optional fields", () => {
    const wire: WireMessage = {
      type: "PING",
      from: "node-1",
      timestamp: 1740484800,
      message_id: "456-1",
    };

    const msg = wireToMessage(wire);

    expect(msg.to).toBe("");
    expect(msg.key).toBe("");
    expect(msg.data.length).toBe(0);
    expect(msg.ttl).toBe(0);
    expect(msg.nodeInfo).toBeUndefined();
  });

  it("parses node_info with default enclave", () => {
    const wire: WireMessage = {
      type: "SYNC",
      from: "node-1",
      timestamp: 1740484800,
      message_id: "789-2",
      node_info: {
        id: "node-2",
        address: "10.0.0.2",
        port: 9090,
        http_port: 8080,
      },
    };

    const msg = wireToMessage(wire);

    expect(msg.nodeInfo).toBeDefined();
    expect(msg.nodeInfo!.id).toBe("node-2");
    expect(msg.nodeInfo!.httpPort).toBe(8080);
    expect(msg.nodeInfo!.enclave).toBe("default");
  });
});

describe("round-trip serialization", () => {
  it("Message → Wire → Message preserves all fields", () => {
    const original = makeMessage({
      type: "PUT",
      from: "sender",
      to: "receiver",
      key: "round-trip-key",
      data: Buffer.from("binary\x00data\xff"),
      ttl: 600,
      nodeInfo: makeNodeInfo({ id: "sender", enclave: "test" }),
    });

    const wire = messageToWire(original);
    const restored = wireToMessage(wire);

    expect(restored.type).toBe(original.type);
    expect(restored.from).toBe(original.from);
    expect(restored.to).toBe(original.to);
    expect(restored.key).toBe(original.key);
    expect(restored.data).toEqual(original.data);
    expect(restored.ttl).toBe(original.ttl);
    expect(restored.messageId).toBe(original.messageId);
    expect(restored.nodeInfo?.id).toBe(original.nodeInfo?.id);
    expect(restored.nodeInfo?.enclave).toBe(original.nodeInfo?.enclave);
  });

  it("handles binary data correctly through base64", () => {
    const binaryData = Buffer.from([0x00, 0x01, 0xFF, 0xFE, 0x80]);
    const msg = makeMessage({ data: binaryData });

    const wire = messageToWire(msg);
    const restored = wireToMessage(wire);

    expect(restored.data).toEqual(binaryData);
  });
});

// --- HTTPTransport ---

describe("HTTPTransport.send", () => {
  it("sends POST with JSON body", async () => {
    const req = setupMockRequest(200);

    const logger = new Logger("error");
    const transport = new HTTPTransport(makeNodeInfo(), "", logger);
    const target = makeNodeInfo({ id: "target", address: "10.0.0.2", httpPort: 8081 });

    await transport.send(target, makeMessage());

    expect(mockRequest).toHaveBeenCalledTimes(1);
    const opts = mockRequest.mock.calls[0][0];
    expect(opts.hostname).toBe("10.0.0.2");
    expect(opts.port).toBe(8081);
    expect(opts.path).toBe("/v1/gossip/message");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(req.end.mock.calls[0][0]);
    expect(body.type).toBe("PUT");
    expect(body.message_id).toBeDefined();
  });

  it("includes HMAC signature when secret is set", async () => {
    setupMockRequest(200);

    const logger = new Logger("error");
    const transport = new HTTPTransport(makeNodeInfo(), "my-secret", logger);

    await transport.send(makeNodeInfo({ id: "target" }), makeMessage());

    const opts = mockRequest.mock.calls[0][0];
    expect(opts.headers["X-Repram-Signature"]).toBeDefined();
    expect(opts.headers["X-Repram-Signature"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("omits HMAC signature when secret is empty", async () => {
    setupMockRequest(200);

    const logger = new Logger("error");
    const transport = new HTTPTransport(makeNodeInfo(), "", logger);

    await transport.send(makeNodeInfo({ id: "target" }), makeMessage());

    const opts = mockRequest.mock.calls[0][0];
    expect(opts.headers["X-Repram-Signature"]).toBeUndefined();
  });

  it("rejects on request error", async () => {
    const req = new EventEmitter() as EventEmitter & {
      end: ReturnType<typeof vi.fn>;
      setTimeout: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    req.end = vi.fn();
    req.setTimeout = vi.fn();
    req.destroy = vi.fn();

    mockRequest.mockImplementation(() => {
      process.nextTick(() => req.emit("error", new Error("connection refused")));
      return req;
    });

    const logger = new Logger("error");
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    const transport = new HTTPTransport(makeNodeInfo(), "", logger);

    await expect(
      transport.send(makeNodeInfo({ id: "target" }), makeMessage()),
    ).rejects.toThrow("connection refused");
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("HTTPTransport.handleIncoming", () => {
  it("dispatches deserialized message to handler", () => {
    const logger = new Logger("error");
    const transport = new HTTPTransport(makeNodeInfo(), "", logger);

    let received: Message | null = null;
    transport.setMessageHandler((msg) => {
      received = msg;
    });

    const wire: WireMessage = {
      type: "PUT",
      from: "remote-node",
      key: "incoming-key",
      data: Buffer.from("payload").toString("base64"),
      ttl: 600,
      timestamp: 1740484800,
      message_id: "abc-1",
    };

    transport.handleIncoming(wire);

    expect(received).not.toBeNull();
    expect(received!.type).toBe("PUT");
    expect(received!.from).toBe("remote-node");
    expect(received!.data.toString()).toBe("payload");
  });

  it("does nothing when no handler is set", () => {
    const logger = new Logger("error");
    const transport = new HTTPTransport(makeNodeInfo(), "", logger);

    // Should not throw
    transport.handleIncoming({
      type: "PING",
      from: "node",
      timestamp: 0,
      message_id: "x",
    });
  });
});

// --- httpPost ---

describe("httpPost", () => {
  it("resolves with status code and body on success", async () => {
    const req = new EventEmitter() as EventEmitter & {
      end: ReturnType<typeof vi.fn>;
      setTimeout: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    req.end = vi.fn();
    req.setTimeout = vi.fn();
    req.destroy = vi.fn();

    mockRequest.mockImplementation((_opts: unknown, callback: (res: unknown) => void) => {
      process.nextTick(() => {
        const res = new EventEmitter() as EventEmitter & { statusCode: number };
        res.statusCode = 200;
        callback(res);
        process.nextTick(() => {
          res.emit("data", Buffer.from('{"ok":true}'));
          res.emit("end");
        });
      });
      return req;
    });

    const result = await httpPost("http://10.0.0.1:8080/v1/bootstrap", '{"test":1}', { "Content-Type": "application/json" });

    expect(result.statusCode).toBe(200);
    expect(result.body).toBe('{"ok":true}');
  });

  it("parses URL into hostname, port, and path", async () => {
    const req = new EventEmitter() as EventEmitter & {
      end: ReturnType<typeof vi.fn>;
      setTimeout: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    req.end = vi.fn();
    req.setTimeout = vi.fn();
    req.destroy = vi.fn();

    mockRequest.mockImplementation((_opts: unknown, callback: (res: unknown) => void) => {
      process.nextTick(() => {
        const res = new EventEmitter() as EventEmitter & { statusCode: number };
        res.statusCode = 200;
        callback(res);
        process.nextTick(() => res.emit("end"));
      });
      return req;
    });

    await httpPost("http://myhost:9090/v1/some/path?q=1", "{}", {});

    const opts = mockRequest.mock.calls[0][0];
    expect(opts.hostname).toBe("myhost");
    expect(String(opts.port)).toBe("9090");
    expect(opts.path).toBe("/v1/some/path?q=1");
    expect(opts.method).toBe("POST");
  });

  it("rejects on connection error", async () => {
    const req = new EventEmitter() as EventEmitter & {
      end: ReturnType<typeof vi.fn>;
      setTimeout: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    req.end = vi.fn();
    req.setTimeout = vi.fn();
    req.destroy = vi.fn();

    mockRequest.mockImplementation(() => {
      process.nextTick(() => req.emit("error", new Error("ECONNREFUSED")));
      return req;
    });

    await expect(httpPost("http://10.0.0.1:8080/v1/test", "{}", {})).rejects.toThrow("ECONNREFUSED");
  });

  it("rejects on timeout and destroys the request", async () => {
    const req = new EventEmitter() as EventEmitter & {
      end: ReturnType<typeof vi.fn>;
      setTimeout: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    req.end = vi.fn();
    req.destroy = vi.fn();

    let timeoutCb: () => void;
    req.setTimeout = vi.fn((_ms: number, cb: () => void) => { timeoutCb = cb; });

    mockRequest.mockImplementation(() => req);

    const promise = httpPost("http://10.0.0.1:8080/v1/test", "{}", {}, 100);

    // Trigger the timeout callback
    process.nextTick(() => timeoutCb());

    await expect(promise).rejects.toThrow("timeout");
    expect(req.destroy).toHaveBeenCalled();
  });

  it("settled guard prevents double-settlement on timeout after response start", async () => {
    const req = new EventEmitter() as EventEmitter & {
      end: ReturnType<typeof vi.fn>;
      setTimeout: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    req.end = vi.fn();
    req.destroy = vi.fn();

    let timeoutCb: () => void;
    req.setTimeout = vi.fn((_ms: number, cb: () => void) => { timeoutCb = cb; });

    const res = new EventEmitter() as EventEmitter & { statusCode: number };
    res.statusCode = 200;

    mockRequest.mockImplementation((_opts: unknown, callback: (r: unknown) => void) => {
      process.nextTick(() => {
        callback(res);
        // Response ends, then timeout fires — settled flag should prevent double-settlement
        process.nextTick(() => {
          res.emit("end");
          process.nextTick(() => timeoutCb());
        });
      });
      return req;
    });

    const result = await httpPost("http://10.0.0.1:8080/v1/test", "{}", {});
    expect(result.statusCode).toBe(200);
  });
});

// --- Peer connection lifecycle ---

describe("HTTPTransport peer connection lifecycle", () => {
  it("creates a dedicated agent per peer on first send", async () => {
    setupMockRequest(200);

    const logger = new Logger("error");
    const transport = new HTTPTransport(makeNodeInfo(), "", logger);

    const peer1 = makeNodeInfo({ id: "peer-1", address: "10.0.0.1", httpPort: 8080 });
    const peer2 = makeNodeInfo({ id: "peer-2", address: "10.0.0.2", httpPort: 8080 });

    await transport.send(peer1, makeMessage());
    await transport.send(peer2, makeMessage());
    await transport.send(peer1, makeMessage()); // reuses existing agent

    // Each call uses its own agent instance — 2 unique agents created
    const agents = mockRequest.mock.calls.map((c: unknown[]) => (c[0] as { agent: unknown }).agent);
    expect(agents[0]).toBe(agents[2]); // same peer-1 agent reused
    expect(agents[0]).not.toBe(agents[1]); // different agents for different peers
  });

  it("onPeerRemoved destroys the agent for that peer", async () => {
    setupMockRequest(200);

    const logger = new Logger("error");
    const transport = new HTTPTransport(makeNodeInfo(), "", logger);

    const peer = makeNodeInfo({ id: "peer-1", address: "10.0.0.1", httpPort: 8080 });
    await transport.send(peer, makeMessage());

    // The agent was created — now remove the peer
    transport.onPeerRemoved(peer);

    // Sending again should create a fresh agent
    await transport.send(peer, makeMessage());
    const agents = mockRequest.mock.calls.map((c: unknown[]) => (c[0] as { agent: unknown }).agent);
    expect(agents[0]).not.toBe(agents[1]);
  });

  it("destroy cleans up all peer agents", async () => {
    setupMockRequest(200);

    const logger = new Logger("error");
    const transport = new HTTPTransport(makeNodeInfo(), "", logger);

    await transport.send(makeNodeInfo({ id: "p1", address: "10.0.0.1" }), makeMessage());
    await transport.send(makeNodeInfo({ id: "p2", address: "10.0.0.2" }), makeMessage());

    transport.destroy();

    // After destroy, sending creates new agents
    await transport.send(makeNodeInfo({ id: "p1", address: "10.0.0.1" }), makeMessage());
    const agents = mockRequest.mock.calls.map((c: unknown[]) => (c[0] as { agent: unknown }).agent);
    expect(agents[0]).not.toBe(agents[2]); // new agent after destroy
  });
});
