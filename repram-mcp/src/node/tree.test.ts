import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createServer, type Server } from "node:http";
import * as net from "node:net";
import {
  TreeManager,
  INBOUND_PROBE_TIMEOUT_MS,
  DEFAULT_MAX_CHILDREN,
  type InboundCapability,
} from "./tree.js";
import {
  WebSocketConnection,
  type AttachmentMessage,
  type HelloPayload,
  type WelcomePayload,
  type GoodbyePayload,
} from "./ws-transport.js";
import { GossipProtocol } from "./gossip.js";
import { Logger } from "./logger.js";
import type { NodeInfo, WireMessage } from "./types.js";

// ─── Test infrastructure ─────────────────────────────────────────────

function silentLogger(): Logger {
  return new Logger("error");
}

function makeNodeInfo(id: string, overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    id,
    address: "127.0.0.1",
    port: 9090,
    httpPort: 8080,
    enclave: "default",
    ...overrides,
  };
}

function makeTreeManager(
  localNode: NodeInfo,
  gossip: GossipProtocol,
  options: Partial<{ inbound: InboundCapability; maxChildren: number; clusterSecret: string }> = {},
): TreeManager {
  return new TreeManager(localNode, gossip, silentLogger(), {
    inbound: options.inbound ?? "true",
    maxChildren: options.maxChildren ?? DEFAULT_MAX_CHILDREN,
    clusterSecret: options.clusterSecret ?? "",
  });
}

/**
 * Create a paired WebSocket connection (server + client) for testing.
 */
async function createPair(
  clusterSecret = "",
): Promise<{
  serverConn: WebSocketConnection;
  clientConn: WebSocketConnection;
  httpServer: Server;
  cleanup: () => Promise<void>;
}> {
  const logger = silentLogger();

  return new Promise((resolve) => {
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer });

    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      if (!addr || typeof addr === "string") throw new Error("no address");

      const serverConnPromise = new Promise<WebSocketConnection>(
        (resolveServer) => {
          wss.on("connection", (ws) => {
            const conn = new WebSocketConnection(ws, clusterSecret, logger);
            resolveServer(conn);
          });
        },
      );

      const clientWs = new WebSocket(`ws://127.0.0.1:${addr.port}`);

      clientWs.on("open", async () => {
        const clientConn = new WebSocketConnection(clientWs, clusterSecret, logger);
        const serverConn = await serverConnPromise;

        resolve({
          serverConn,
          clientConn,
          httpServer,
          cleanup: () =>
            new Promise<void>((done) => {
              clientConn.close();
              serverConn.close();
              wss.close();
              httpServer.close(() => done());
            }),
        });
      });
    });
  });
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("TreeManager", () => {
  describe("role detection", () => {
    it("REPRAM_INBOUND=true → substrate role", () => {
      const localNode = makeNodeInfo("substrate-1");
      const gossip = new GossipProtocol(localNode, 3, silentLogger());
      const tree = makeTreeManager(localNode, gossip, { inbound: "true" });

      expect(tree.role).toBe("substrate");
      expect(tree.isInboundCapable()).toBe(true);
      expect(tree.parent).toBeNull();
    });

    it("REPRAM_INBOUND=false → transient role", () => {
      const localNode = makeNodeInfo("transient-1");
      const gossip = new GossipProtocol(localNode, 3, silentLogger());
      const tree = makeTreeManager(localNode, gossip, { inbound: "false" });

      expect(tree.role).toBe("transient");
      expect(tree.isInboundCapable()).toBe(false);
    });

    it("REPRAM_INBOUND=auto → defaults to substrate until attached", () => {
      const localNode = makeNodeInfo("auto-1");
      const gossip = new GossipProtocol(localNode, 3, silentLogger());
      const tree = makeTreeManager(localNode, gossip, { inbound: "auto" });

      // Starts as substrate (before any attachment attempt)
      expect(tree.role).toBe("substrate");
    });
  });

  describe("hello/welcome handshake (server side)", () => {
    let pair: Awaited<ReturnType<typeof createPair>>;
    let substrateNode: NodeInfo;
    let gossip: GossipProtocol;
    let tree: TreeManager;

    beforeEach(async () => {
      pair = await createPair();
      substrateNode = makeNodeInfo("substrate-1");
      gossip = new GossipProtocol(substrateNode, 3, silentLogger());
      tree = makeTreeManager(substrateNode, gossip);
    });

    afterEach(async () => {
      tree.stop();
      await pair.cleanup();
    });

    it("accepts hello and sends welcome with topology", async () => {
      // Add a peer to the gossip layer
      const peerNode = makeNodeInfo("peer-1", { address: "10.0.0.2", httpPort: 8081 });
      gossip.addPeer(peerNode);

      const hello: HelloPayload = {
        node_id: "transient-1",
        enclave: "default",
        address: "192.168.1.100",
        http_port: 8080,
        capabilities: { inbound: "false" },
      };

      // Listen for welcome on client side
      const welcomePromise = new Promise<AttachmentMessage>((resolve) => {
        pair.clientConn.on("attachment", (msg) => {
          if (msg.type === "welcome") resolve(msg);
        });
      });

      const accepted = await tree.handleHello(pair.serverConn, hello);
      expect(accepted).toBe(true);

      const welcomeMsg = await welcomePromise;
      const payload = welcomeMsg.payload as WelcomePayload;

      expect(payload.your_position.parent_id).toBe("substrate-1");
      expect(payload.your_position.depth).toBe(1);
      expect(payload.inbound_detected).toBe(false);
      // Topology should include substrate-1 and peer-1
      expect(payload.topology.length).toBe(2);
    });

    it("registers child connection after hello", async () => {
      const hello: HelloPayload = {
        node_id: "transient-1",
        enclave: "default",
        address: "192.168.1.100",
        http_port: 8080,
        capabilities: { inbound: "false" },
      };

      await tree.handleHello(pair.serverConn, hello);

      expect(tree.childCount).toBe(1);
      expect(tree.getChildren().has("transient-1")).toBe(true);
      expect(pair.serverConn.remoteNodeId).toBe("transient-1");
      expect(pair.serverConn.remoteEnclave).toBe("default");
    });

    it("removes child on connection close", async () => {
      const hello: HelloPayload = {
        node_id: "transient-1",
        enclave: "default",
        address: "192.168.1.100",
        http_port: 8080,
        capabilities: { inbound: "false" },
      };

      await tree.handleHello(pair.serverConn, hello);
      expect(tree.childCount).toBe(1);

      // Close the client connection
      pair.clientConn.close();

      // Wait for close to propagate
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(tree.childCount).toBe(0);
    });
  });

  describe("max children enforcement", () => {
    it("rejects attachment when at capacity", async () => {
      const pair = await createPair();
      const substrateNode = makeNodeInfo("substrate-1");
      const gossip = new GossipProtocol(substrateNode, 3, silentLogger());
      const tree = makeTreeManager(substrateNode, gossip, { maxChildren: 1 });

      // First attachment succeeds
      const hello1: HelloPayload = {
        node_id: "transient-1",
        enclave: "default",
        address: "192.168.1.100",
        http_port: 8080,
        capabilities: { inbound: "false" },
      };

      const accepted1 = await tree.handleHello(pair.serverConn, hello1);
      expect(accepted1).toBe(true);
      expect(tree.childCount).toBe(1);

      // Second attachment rejected
      const pair2 = await createPair();

      const goodbyePromise = new Promise<AttachmentMessage>((resolve) => {
        pair2.clientConn.on("attachment", (msg) => {
          if (msg.type === "goodbye") resolve(msg);
        });
      });

      const hello2: HelloPayload = {
        node_id: "transient-2",
        enclave: "default",
        address: "192.168.1.101",
        http_port: 8080,
        capabilities: { inbound: "false" },
      };

      const accepted2 = await tree.handleHello(pair2.serverConn, hello2);
      expect(accepted2).toBe(false);
      expect(tree.childCount).toBe(1);

      const goodbyeMsg = await goodbyePromise;
      const payload = goodbyeMsg.payload as GoodbyePayload;
      expect(payload.reason).toBe("at capacity");

      tree.stop();
      await pair.cleanup();
      await pair2.cleanup();
    });

    it("rejects all attachments when maxChildren=0", async () => {
      const pair = await createPair();
      const substrateNode = makeNodeInfo("substrate-1");
      const gossip = new GossipProtocol(substrateNode, 3, silentLogger());
      const tree = makeTreeManager(substrateNode, gossip, { maxChildren: 0 });

      const goodbyePromise = new Promise<AttachmentMessage>((resolve) => {
        pair.clientConn.on("attachment", (msg) => {
          if (msg.type === "goodbye") resolve(msg);
        });
      });

      const hello: HelloPayload = {
        node_id: "transient-1",
        enclave: "default",
        address: "192.168.1.100",
        http_port: 8080,
        capabilities: { inbound: "false" },
      };

      const accepted = await tree.handleHello(pair.serverConn, hello);
      expect(accepted).toBe(false);

      const goodbye = await goodbyePromise;
      expect((goodbye.payload as GoodbyePayload).reason).toBe("at capacity");

      tree.stop();
      await pair.cleanup();
    });
  });

  describe("client-side attachment", () => {
    let substrateNode: NodeInfo;
    let substrateGossip: GossipProtocol;
    let substrateTree: TreeManager;
    let transientNode: NodeInfo;
    let transientGossip: GossipProtocol;
    let transientTree: TreeManager;
    let pair: Awaited<ReturnType<typeof createPair>>;

    beforeEach(async () => {
      pair = await createPair();

      substrateNode = makeNodeInfo("substrate-1");
      substrateGossip = new GossipProtocol(substrateNode, 3, silentLogger());
      substrateTree = makeTreeManager(substrateNode, substrateGossip);

      transientNode = makeNodeInfo("transient-1", { address: "192.168.1.100" });
      transientGossip = new GossipProtocol(transientNode, 3, silentLogger());
      transientTree = makeTreeManager(transientNode, transientGossip, { inbound: "false" });
    });

    afterEach(async () => {
      substrateTree.stop();
      transientTree.stop();
      await pair.cleanup();
    });

    it("completes hello/welcome handshake from client side", async () => {
      // Server side: listen for hello and respond
      pair.serverConn.on("attachment", (msg: AttachmentMessage) => {
        if (msg.type === "hello") {
          substrateTree.handleHello(pair.serverConn, msg.payload as HelloPayload);
        }
      });

      // Client side: attach
      const welcome = await transientTree.attach(pair.clientConn);

      expect(welcome).not.toBeNull();
      expect(welcome!.your_position.parent_id).toBe("substrate-1");
      expect(welcome!.your_position.depth).toBe(1);
      expect(transientTree.role).toBe("transient");
      expect(transientTree.parent).toBe(pair.clientConn);
    });

    it("returns null on timeout when substrate doesn't respond", async () => {
      // Don't set up server-side handler — simulate unresponsive substrate
      const welcome = await transientTree.attach(pair.clientConn, 500);

      expect(welcome).toBeNull();
      expect(transientTree.parent).toBeNull();
    });

    it("updates inbound capability from welcome (auto mode)", async () => {
      const autoTree = makeTreeManager(transientNode, transientGossip, { inbound: "auto" });

      pair.serverConn.on("attachment", (msg: AttachmentMessage) => {
        if (msg.type === "hello") {
          substrateTree.handleHello(pair.serverConn, msg.payload as HelloPayload);
        }
      });

      const welcome = await autoTree.attach(pair.clientConn);

      expect(welcome).not.toBeNull();
      // The probe will fail (192.168.1.100 isn't a real address in test)
      expect(autoTree.isInboundCapable()).toBe(false);

      autoTree.stop();
    });
  });

  describe("inbound auto-detection", () => {
    it("detects listening server as inbound-capable", async () => {
      // Start a TCP server to probe against
      const tcpServer = net.createServer();
      await new Promise<void>((resolve) => {
        tcpServer.listen(0, "127.0.0.1", () => resolve());
      });
      const addr = tcpServer.address() as net.AddressInfo;

      const localNode = makeNodeInfo("prober");
      const gossip = new GossipProtocol(localNode, 3, silentLogger());
      const tree = makeTreeManager(localNode, gossip);

      const result = await tree.probeInbound("127.0.0.1", addr.port);
      expect(result).toBe(true);

      tcpServer.close();
      tree.stop();
    });

    it("detects unreachable port as not inbound-capable", async () => {
      const localNode = makeNodeInfo("prober");
      const gossip = new GossipProtocol(localNode, 3, silentLogger());
      const tree = makeTreeManager(localNode, gossip);

      // Use a port that's almost certainly not listening
      const result = await tree.probeInbound("127.0.0.1", 1);
      expect(result).toBe(false);

      tree.stop();
    });

    it("hello with inbound=true skips probe", async () => {
      const pair = await createPair();
      const substrateNode = makeNodeInfo("substrate-1");
      const gossip = new GossipProtocol(substrateNode, 3, silentLogger());
      const tree = makeTreeManager(substrateNode, gossip);

      // Spy on probeInbound
      const probeSpy = vi.spyOn(tree, "probeInbound");

      const welcomePromise = new Promise<AttachmentMessage>((resolve) => {
        pair.clientConn.on("attachment", (msg) => {
          if (msg.type === "welcome") resolve(msg);
        });
      });

      const hello: HelloPayload = {
        node_id: "transient-1",
        enclave: "default",
        address: "192.168.1.100",
        http_port: 8080,
        capabilities: { inbound: "true" },
      };

      await tree.handleHello(pair.serverConn, hello);
      const welcomeMsg = await welcomePromise;
      const payload = welcomeMsg.payload as WelcomePayload;

      expect(payload.inbound_detected).toBe(true);
      expect(probeSpy).not.toHaveBeenCalled();

      tree.stop();
      await pair.cleanup();
    });

    it("hello with inbound=auto triggers probe", async () => {
      const pair = await createPair();
      const substrateNode = makeNodeInfo("substrate-1");
      const gossip = new GossipProtocol(substrateNode, 3, silentLogger());
      const tree = makeTreeManager(substrateNode, gossip);

      // Mock probeInbound to avoid real network calls
      vi.spyOn(tree, "probeInbound").mockResolvedValue(false);

      const welcomePromise = new Promise<AttachmentMessage>((resolve) => {
        pair.clientConn.on("attachment", (msg) => {
          if (msg.type === "welcome") resolve(msg);
        });
      });

      const hello: HelloPayload = {
        node_id: "transient-1",
        enclave: "default",
        address: "192.168.1.100",
        http_port: 8080,
        capabilities: { inbound: "auto" },
      };

      await tree.handleHello(pair.serverConn, hello);
      const welcomeMsg = await welcomePromise;
      const payload = welcomeMsg.payload as WelcomePayload;

      expect(payload.inbound_detected).toBe(false);
      expect(tree.probeInbound).toHaveBeenCalledWith("192.168.1.100", 8080);

      tree.stop();
      await pair.cleanup();
    });
  });

  describe("ACK routing", () => {
    it("records and retrieves ACK routes", () => {
      const localNode = makeNodeInfo("substrate-1");
      const gossip = new GossipProtocol(localNode, 3, silentLogger());
      const tree = makeTreeManager(localNode, gossip);

      const pair = { serverConn: {} as WebSocketConnection };

      tree.recordAckRoute("msg-1", pair.serverConn as WebSocketConnection, 5000);

      expect(tree.getAckRoute("msg-1")).toBe(pair.serverConn);
      expect(tree.getAckRoute("msg-nonexistent")).toBeNull();

      tree.stop();
    });

    it("auto-cleans ACK routes after timeout", async () => {
      const localNode = makeNodeInfo("substrate-1");
      const gossip = new GossipProtocol(localNode, 3, silentLogger());
      const tree = makeTreeManager(localNode, gossip);

      const mockConn = {} as WebSocketConnection;
      tree.recordAckRoute("msg-1", mockConn, 100); // 100ms timeout

      expect(tree.getAckRoute("msg-1")).toBe(mockConn);

      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(tree.getAckRoute("msg-1")).toBeNull();

      tree.stop();
    });

    it("clearAckRoute removes route and timer", () => {
      const localNode = makeNodeInfo("substrate-1");
      const gossip = new GossipProtocol(localNode, 3, silentLogger());
      const tree = makeTreeManager(localNode, gossip);

      const mockConn = {} as WebSocketConnection;
      tree.recordAckRoute("msg-1", mockConn, 5000);

      expect(tree.getAckRoute("msg-1")).toBe(mockConn);

      tree.clearAckRoute("msg-1");

      expect(tree.getAckRoute("msg-1")).toBeNull();

      tree.stop();
    });
  });

  describe("alternative substrates", () => {
    it("returns same-enclave peers first", () => {
      const localNode = makeNodeInfo("substrate-1");
      const gossip = new GossipProtocol(localNode, 3, silentLogger());
      const tree = makeTreeManager(localNode, gossip);

      // Add peers with mixed enclaves
      gossip.addPeer(makeNodeInfo("same-1", { enclave: "default" }));
      gossip.addPeer(makeNodeInfo("other-1", { enclave: "other" }));
      gossip.addPeer(makeNodeInfo("same-2", { enclave: "default" }));

      const alternatives = tree.getAlternativeSubstrates("default");

      expect(alternatives.length).toBe(3);
      expect(alternatives[0].id).toBe("same-1");
      expect(alternatives[1].id).toBe("same-2");
      expect(alternatives[2].id).toBe("other-1");

      tree.stop();
    });

    it("limits to 5 alternatives", () => {
      const localNode = makeNodeInfo("substrate-1");
      const gossip = new GossipProtocol(localNode, 3, silentLogger());
      const tree = makeTreeManager(localNode, gossip);

      for (let i = 0; i < 10; i++) {
        gossip.addPeer(makeNodeInfo(`peer-${i}`));
      }

      const alternatives = tree.getAlternativeSubstrates();
      expect(alternatives.length).toBe(5);

      tree.stop();
    });
  });

  describe("goodbye on shutdown", () => {
    it("sends goodbye to all children during stop()", async () => {
      const pair = await createPair();
      const substrateNode = makeNodeInfo("substrate-1");
      const gossip = new GossipProtocol(substrateNode, 3, silentLogger());
      const tree = makeTreeManager(substrateNode, gossip);

      // Attach a child
      const hello: HelloPayload = {
        node_id: "transient-1",
        enclave: "default",
        address: "192.168.1.100",
        http_port: 8080,
        capabilities: { inbound: "false" },
      };

      await tree.handleHello(pair.serverConn, hello);

      // Listen for goodbye on client side
      const goodbyePromise = new Promise<AttachmentMessage>((resolve) => {
        pair.clientConn.on("attachment", (msg) => {
          if (msg.type === "goodbye") resolve(msg);
        });
      });

      tree.sendGoodbyeToChildren();

      const goodbyeMsg = await goodbyePromise;
      const payload = goodbyeMsg.payload as GoodbyePayload;
      expect(payload.reason).toBe("shutdown");

      tree.stop();
      await pair.cleanup();
    });

    it("receives goodbye from substrate during attach", async () => {
      const pair = await createPair();

      const substrateNode = makeNodeInfo("substrate-1");
      const substrateGossip = new GossipProtocol(substrateNode, 3, silentLogger());
      const substrateTree = makeTreeManager(substrateNode, substrateGossip);

      const transientNode = makeNodeInfo("transient-1", { address: "192.168.1.100" });
      const transientGossip = new GossipProtocol(transientNode, 3, silentLogger());
      const transientTree = makeTreeManager(transientNode, transientGossip, { inbound: "false" });

      // Wire up hello handler
      pair.serverConn.on("attachment", (msg: AttachmentMessage) => {
        if (msg.type === "hello") {
          substrateTree.handleHello(pair.serverConn, msg.payload as HelloPayload);
        }
      });

      // Attach transient to substrate
      const welcome = await transientTree.attach(pair.clientConn);
      expect(welcome).not.toBeNull();
      expect(transientTree.parent).toBe(pair.clientConn);

      // Parent sends goodbye
      const goodbyeReceived = new Promise<void>((resolve) => {
        pair.clientConn.on("attachment", (msg) => {
          if (msg.type === "goodbye") resolve();
        });
      });

      substrateTree.sendGoodbyeToChildren("maintenance");
      await goodbyeReceived;

      // Parent reference should be cleared
      expect(transientTree.parent).toBeNull();

      substrateTree.stop();
      transientTree.stop();
      await pair.cleanup();
    });
  });
});
