import { describe, it, expect, vi, afterEach } from "vitest";
import { HTTPTransport, messageToWire, wireToMessage } from "./transport.js";
import { Logger } from "./logger.js";
import type { Message, NodeInfo, WireMessage } from "./types.js";

afterEach(() => {
  vi.restoreAllMocks();
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
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const logger = new Logger("error");
    const transport = new HTTPTransport(makeNodeInfo(), "", logger);
    const target = makeNodeInfo({ id: "target", address: "10.0.0.2", httpPort: 8081 });

    await transport.send(target, makeMessage());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://10.0.0.2:8081/v1/gossip/message");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(opts.body);
    expect(body.type).toBe("PUT");
    expect(body.message_id).toBeDefined();
  });

  it("includes HMAC signature when secret is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const logger = new Logger("error");
    const transport = new HTTPTransport(makeNodeInfo(), "my-secret", logger);

    await transport.send(makeNodeInfo({ id: "target" }), makeMessage());

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers["X-Repram-Signature"]).toBeDefined();
    expect(opts.headers["X-Repram-Signature"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("omits HMAC signature when secret is empty", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const logger = new Logger("error");
    const transport = new HTTPTransport(makeNodeInfo(), "", logger);

    await transport.send(makeNodeInfo({ id: "target" }), makeMessage());

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers["X-Repram-Signature"]).toBeUndefined();
  });

  it("handles fetch failure gracefully (no throw)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));

    const logger = new Logger("error");
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    const transport = new HTTPTransport(makeNodeInfo(), "", logger);

    // Should not throw
    await transport.send(makeNodeInfo({ id: "target" }), makeMessage());
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
