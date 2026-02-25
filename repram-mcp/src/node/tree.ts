/**
 * TreeManager — substrate attachment state for Discovery Protocol v2.
 *
 * Manages the relationship between substrate nodes (routable infrastructure
 * in the flat HTTP gossip mesh) and transient nodes (NAT-bound MCP installs
 * that attach via outbound WebSocket).
 *
 * Node roles emerge from one property: whether the node can accept inbound
 * connections. Substrate nodes accept WS attachments and relay for their
 * children. Transient nodes attach to a substrate node and participate in
 * the network through that relay.
 *
 * Part of Discovery Protocol v2. See docs/internal/REPRAM-Discovery-Protocol-v2.md
 */

import * as net from "node:net";
import type { Logger } from "./logger.js";
import type { NodeInfo } from "./types.js";
import {
  WebSocketConnection,
  connectToSubstrate,
  type AttachmentMessage,
  type HelloPayload,
  type WelcomePayload,
  type GoodbyePayload,
} from "./ws-transport.js";
import type { GossipProtocol } from "./gossip.js";

// --- Constants ---

/** Timeout for inbound auto-detection TCP probe (ms). */
export const INBOUND_PROBE_TIMEOUT_MS = 3_000;

/** Default maximum number of transient node attachments. */
export const DEFAULT_MAX_CHILDREN = 100;

// --- Types ---

export type NodeRole = "substrate" | "transient";
export type InboundCapability = "auto" | "true" | "false";

export interface TreeManagerOptions {
  /** Whether this node can accept inbound connections. */
  inbound: InboundCapability;
  /** Maximum number of transient node attachments (0 = never accept). */
  maxChildren: number;
  /** Cluster secret for HMAC signing. */
  clusterSecret: string;
}

// --- TreeManager ---

export class TreeManager {
  /** Outbound WS attachment to a substrate node (null for substrate nodes). */
  private parentConnection: WebSocketConnection | null = null;

  /** Inbound WS attachments from transient nodes, keyed by node ID. */
  private children = new Map<string, WebSocketConnection>();

  /** Resolved role: substrate nodes stay in mesh, transient nodes attach. */
  private resolvedRole: NodeRole = "substrate";

  /** Whether this node was detected as inbound-capable. */
  private inboundCapable = true;

  private localNode: NodeInfo;
  private gossip: GossipProtocol;
  private logger: Logger;
  private options: TreeManagerOptions;

  /**
   * ACK routing table: messageId -> WebSocketConnection of the originating
   * transient node. Used by substrate nodes to forward ACKs back to the
   * child that initiated the write.
   */
  private ackRoutes = new Map<string, WebSocketConnection>();

  /** Timers for ACK route cleanup (keyed by messageId). */
  private ackRouteTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Callback invoked when a new parent connection is established during
   * reattachment. Allows the server layer to set up message routing.
   */
  private onReattachCallback: ((conn: WebSocketConnection) => void) | null = null;

  /** Whether a reattachment attempt is currently in progress. */
  private reattaching = false;

  constructor(
    localNode: NodeInfo,
    gossip: GossipProtocol,
    logger: Logger,
    options: TreeManagerOptions,
  ) {
    this.localNode = localNode;
    this.gossip = gossip;
    this.logger = logger;
    this.options = options;

    // Resolve initial role from config
    if (options.inbound === "true") {
      this.resolvedRole = "substrate";
      this.inboundCapable = true;
    } else if (options.inbound === "false") {
      this.resolvedRole = "transient";
      this.inboundCapable = false;
    }
    // "auto" stays substrate until attach() is called (transient nodes
    // call attach() after bootstrap, substrate nodes never do)
  }

  // --- Accessors ---

  get role(): NodeRole {
    return this.resolvedRole;
  }

  get parent(): WebSocketConnection | null {
    return this.parentConnection;
  }

  get childCount(): number {
    return this.children.size;
  }

  getChildren(): ReadonlyMap<string, WebSocketConnection> {
    return this.children;
  }

  isInboundCapable(): boolean {
    return this.inboundCapable;
  }

  /**
   * Register a callback for when a new parent connection is established
   * during reattachment. The server uses this to wire up message routing.
   */
  setReattachCallback(cb: (conn: WebSocketConnection) => void): void {
    this.onReattachCallback = cb;
  }

  // --- Server-side: handle incoming attachments ---

  /**
   * Handle a new WebSocket connection that sent a hello message.
   * Validates the attachment, performs inbound auto-detection if needed,
   * and sends a welcome response.
   *
   * Called by the server's handleUpgrade attachment handler.
   */
  async handleHello(
    conn: WebSocketConnection,
    hello: HelloPayload,
  ): Promise<boolean> {
    // Check max children
    if (
      this.options.maxChildren > 0 &&
      this.children.size >= this.options.maxChildren
    ) {
      this.logger.info(
        `Rejecting attachment from ${hello.node_id}: at capacity (${this.children.size}/${this.options.maxChildren})`,
      );
      this.sendRedirect(conn, hello);
      return false;
    }

    // Never accept attachments if maxChildren is 0
    if (this.options.maxChildren === 0) {
      this.logger.info(
        `Rejecting attachment from ${hello.node_id}: attachments disabled (REPRAM_MAX_CHILDREN=0)`,
      );
      this.sendRedirect(conn, hello);
      return false;
    }

    // Inbound auto-detection
    let inboundDetected = false;
    if (hello.capabilities.inbound === "true") {
      inboundDetected = true;
    } else if (hello.capabilities.inbound === "false") {
      inboundDetected = false;
    } else {
      // auto — probe
      inboundDetected = await this.probeInbound(
        hello.address,
        hello.http_port,
      );
    }

    // Register the child
    conn.remoteNodeId = hello.node_id;
    conn.remoteEnclave = hello.enclave;
    this.children.set(hello.node_id, conn);

    // Build topology for welcome
    const peers = this.gossip.getPeers();
    const topologyNodes = [...peers, this.localNode];

    const now = Math.floor(Date.now() / 1000);
    const welcome: WelcomePayload = {
      topology: topologyNodes.map((p) => ({
        type: "SYNC",
        from: this.localNode.id,
        timestamp: now,
        message_id: "",
        node_info: {
          id: p.id,
          address: p.address,
          port: p.port,
          http_port: p.httpPort,
          enclave: p.enclave,
        },
      })),
      your_position: {
        depth: 1, // direct child of substrate
        parent_id: this.localNode.id,
      },
      inbound_detected: inboundDetected,
    };

    conn.sendAttachmentMessage({
      type: "welcome",
      payload: welcome,
    });

    // Track child disconnection
    conn.on("close", () => {
      this.children.delete(hello.node_id);
      this.logger.info(
        `Transient node ${hello.node_id} detached (${this.children.size} remaining)`,
      );
    });

    this.logger.info(
      `Transient node ${hello.node_id} attached (enclave: ${hello.enclave}, ` +
        `inbound: ${inboundDetected}, children: ${this.children.size})`,
    );

    return true;
  }

  /**
   * Send a redirect/rejection to a connecting node when we can't accept
   * the attachment. Includes alternative substrate node suggestions.
   */
  private sendRedirect(conn: WebSocketConnection, hello: HelloPayload): void {
    const alternatives = this.getAlternativeSubstrates(hello.enclave);

    const goodbye: GoodbyePayload = {
      reason: "at capacity",
      alternative_parents: alternatives,
    };

    conn.sendAttachmentMessage({
      type: "goodbye",
      payload: goodbye,
    });

    // Close after a brief delay to let the message send
    setTimeout(() => {
      if (!conn.isClosed) {
        conn.close(1000, "redirected");
      }
    }, 500);
  }

  // --- Client-side: attach to substrate ---

  /**
   * Register an outbound WebSocket connection as our substrate attachment.
   * Sends hello, waits for welcome. Called by transient nodes after bootstrap.
   *
   * Returns the WelcomePayload on success, or null on failure.
   */
  async attach(
    conn: WebSocketConnection,
    timeoutMs = 10_000,
  ): Promise<WelcomePayload | null> {
    // Send hello
    const hello: HelloPayload = {
      node_id: this.localNode.id,
      enclave: this.localNode.enclave,
      address: this.localNode.address,
      http_port: this.localNode.httpPort,
      capabilities: {
        inbound: this.options.inbound,
      },
    };

    conn.sendAttachmentMessage({
      type: "hello",
      payload: hello,
    });

    // Wait for welcome or goodbye
    const welcome = await new Promise<WelcomePayload | null>((resolve) => {
      const timeout = setTimeout(() => {
        resolve(null);
      }, timeoutMs);

      const onAttachment = (msg: AttachmentMessage) => {
        if (msg.type === "welcome") {
          clearTimeout(timeout);
          conn.removeListener("attachment", onAttachment);
          conn.removeListener("close", onClose);
          resolve(msg.payload as WelcomePayload);
        } else if (msg.type === "goodbye") {
          clearTimeout(timeout);
          conn.removeListener("attachment", onAttachment);
          conn.removeListener("close", onClose);
          resolve(null);
        }
      };

      const onClose = () => {
        clearTimeout(timeout);
        conn.removeListener("attachment", onAttachment);
        resolve(null);
      };

      conn.on("attachment", onAttachment);
      conn.on("close", onClose);
    });

    if (!welcome) {
      this.logger.warn("Substrate attachment failed — no welcome received");
      return null;
    }

    // Register as our parent
    this.parentConnection = conn;
    this.resolvedRole = "transient";

    conn.remoteNodeId = welcome.your_position.parent_id;

    // Handle parent disconnection
    conn.on("close", () => {
      this.logger.warn(
        `Substrate attachment to ${conn.remoteNodeId ?? "unknown"} lost`,
      );
      this.parentConnection = null;
    });

    // Handle goodbye from parent (graceful shutdown → proactive migration)
    conn.on("attachment", (msg: AttachmentMessage) => {
      if (msg.type === "goodbye") {
        const payload = msg.payload as GoodbyePayload;
        this.logger.info(
          `Substrate node sent goodbye: ${payload.reason} ` +
            `(${payload.alternative_parents.length} alternatives)`,
        );
        this.parentConnection = null;

        // Proactive migration — try alternatives before falling back to bootstrap
        if (payload.alternative_parents.length > 0) {
          this.reattachToAlternative(payload.alternative_parents);
        }
      }
    });

    this.logger.info(
      `Attached to substrate node ${welcome.your_position.parent_id} ` +
        `(depth: ${welcome.your_position.depth}, ` +
        `inbound_detected: ${welcome.inbound_detected}, ` +
        `topology: ${welcome.topology.length} nodes)`,
    );

    // Update inbound capability from server's detection
    if (this.options.inbound === "auto") {
      this.inboundCapable = welcome.inbound_detected;
    }

    return welcome;
  }

  // --- Reattachment ---

  /**
   * Attempt to reattach to an alternative substrate node after receiving
   * a goodbye from the current parent. Tries each alternative in order,
   * falls back to logged warning if all fail.
   *
   * This is fire-and-forget — the transient node continues operating
   * with local storage while reattachment is in progress.
   */
  private async reattachToAlternative(
    alternatives: GoodbyePayload["alternative_parents"],
  ): Promise<void> {
    if (this.reattaching) return; // prevent concurrent reattachment
    this.reattaching = true;

    try {
      for (const alt of alternatives) {
        try {
          this.logger.info(
            `Attempting reattachment to ${alt.id} (${alt.address}:${alt.http_port})`,
          );

          const conn = await connectToSubstrate(
            alt.address,
            alt.http_port,
            this.options.clusterSecret,
            this.logger,
            10_000,
          );

          const welcome = await this.attach(conn);
          if (welcome) {
            this.logger.info(`Reattached to ${alt.id} — gossip resumed`);

            // Notify server to set up message routing on new connection
            this.onReattachCallback?.(conn);
            conn.startHeartbeat();
            return;
          }

          conn.close();
        } catch (err) {
          this.logger.warn(`Reattachment to ${alt.id} failed: ${err}`);
        }
      }

      this.logger.warn(
        "All alternative substrate nodes failed — operating in degraded mode " +
          "(local store only until heartbeat-based reattachment or restart)",
      );
    } finally {
      this.reattaching = false;
    }
  }

  // --- Relay: ACK routing ---

  /**
   * Record a route for ACKs to reach the originating transient node.
   * Called when a substrate node relays a PUT from an attached child.
   */
  recordAckRoute(
    messageId: string,
    conn: WebSocketConnection,
    timeoutMs: number,
  ): void {
    this.ackRoutes.set(messageId, conn);

    // Auto-cleanup after write timeout
    const timer = setTimeout(() => {
      this.ackRoutes.delete(messageId);
      this.ackRouteTimers.delete(messageId);
    }, timeoutMs);

    this.ackRouteTimers.set(messageId, timer);
  }

  /**
   * Look up which transient node should receive an ACK for a relayed write.
   * Returns null if the route doesn't exist (direct write, not relayed).
   */
  getAckRoute(messageId: string): WebSocketConnection | null {
    return this.ackRoutes.get(messageId) ?? null;
  }

  /**
   * Clean up a specific ACK route (e.g., when quorum is reached).
   */
  clearAckRoute(messageId: string): void {
    this.ackRoutes.delete(messageId);
    const timer = this.ackRouteTimers.get(messageId);
    if (timer) {
      clearTimeout(timer);
      this.ackRouteTimers.delete(messageId);
    }
  }

  // --- Inbound auto-detection ---

  /**
   * Probe whether a remote address:port is reachable by attempting a TCP
   * connection. Used during hello handshake to detect NAT-bound nodes.
   *
   * Known limitation: symmetric NAT may produce false positives — the probe
   * succeeds through a recent port mapping even though unsolicited inbound
   * would fail. REPRAM_INBOUND=false is the escape hatch.
   */
  async probeInbound(
    address: string,
    port: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect({ host: address, port }, () => {
        socket.destroy();
        resolve(true);
      });

      socket.setTimeout(INBOUND_PROBE_TIMEOUT_MS);

      socket.on("timeout", () => {
        socket.destroy();
        resolve(false);
      });

      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  // --- Helpers ---

  /**
   * Get alternative substrate node suggestions for redirects and goodbyes.
   * Prefers same-enclave nodes, returns up to 5.
   */
  getAlternativeSubstrates(
    enclave?: string,
  ): Array<{ id: string; address: string; http_port: number; enclave?: string }> {
    const peers = this.gossip.getPeers();

    // Prefer same-enclave peers, then any peer
    const sameEnclave = peers.filter((p) => p.enclave === (enclave ?? this.localNode.enclave));
    const otherEnclave = peers.filter((p) => p.enclave !== (enclave ?? this.localNode.enclave));
    const candidates = [...sameEnclave, ...otherEnclave];

    return candidates.slice(0, 5).map((p) => ({
      id: p.id,
      address: p.address,
      http_port: p.httpPort,
      enclave: p.enclave,
    }));
  }

  // --- Shutdown ---

  /**
   * Send goodbye to all attached transient nodes with alternative substrate
   * suggestions. Called during graceful server shutdown.
   */
  sendGoodbyeToChildren(reason = "shutdown"): void {
    if (this.children.size === 0) return;

    const alternatives = this.getAlternativeSubstrates();

    const goodbye: GoodbyePayload = {
      reason,
      alternative_parents: alternatives,
    };

    const goodbyeMsg: AttachmentMessage = {
      type: "goodbye",
      payload: goodbye,
    };

    this.logger.info(
      `Sending goodbye to ${this.children.size} attached transient nodes ` +
        `(${alternatives.length} alternatives)`,
    );

    for (const [nodeId, conn] of this.children) {
      try {
        conn.sendAttachmentMessage(goodbyeMsg);
      } catch (err) {
        this.logger.debug(`Failed to send goodbye to ${nodeId}: ${err}`);
      }
    }
  }

  /**
   * Clean shutdown: send goodbyes, clear state.
   */
  stop(): void {
    this.sendGoodbyeToChildren();

    // Clean up ACK route timers
    for (const timer of this.ackRouteTimers.values()) {
      clearTimeout(timer);
    }
    this.ackRouteTimers.clear();
    this.ackRoutes.clear();

    // Close parent connection if any
    if (this.parentConnection && !this.parentConnection.isClosed) {
      this.parentConnection.close(1000, "shutting down");
    }
    this.parentConnection = null;

    // Don't close children here — server.stop() handles that
    this.children.clear();
  }
}
