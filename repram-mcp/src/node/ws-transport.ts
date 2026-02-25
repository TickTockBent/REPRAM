/**
 * WebSocket transport for substrate-transient connections.
 *
 * Provides persistent bidirectional connections between transient nodes
 * (NAT-bound MCP installs) and substrate nodes (routable infrastructure).
 * Messages use the same WireMessage JSON format as HTTP gossip — a node
 * processes a PUT identically regardless of whether it arrived over HTTP
 * or WebSocket.
 *
 * Part of Discovery Protocol v2. See docs/internal/REPRAM-Discovery-Protocol-v2.md
 */

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { signBody, verifyBody } from "./auth.js";
import type { Logger } from "./logger.js";
import type { Message, WireMessage } from "./types.js";
import { messageToWire, wireToMessage } from "./transport.js";

// --- Constants ---

/** How often to send WebSocket ping frames (ms). */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** How many consecutive missed pongs before declaring the connection dead. */
export const MAX_MISSED_PONGS = 3;

// --- Attachment message types (superset of gossip wire format) ---

/**
 * Messages carried on a substrate-transient WebSocket attachment.
 *
 * Gossip messages (put, ack, ping, pong, topology_sync) use the same
 * WireMessage payload as HTTP gossip. The hello, welcome, and goodbye
 * types handle attachment lifecycle.
 */
export type AttachmentMessageType =
  | "put"
  | "ack"
  | "ping"
  | "pong"
  | "topology_sync"
  | "hello"
  | "welcome"
  | "goodbye";

export interface AttachmentMessage {
  type: AttachmentMessageType;
  signature?: string;
  payload: WireMessage | HelloPayload | WelcomePayload | GoodbyePayload;
}

export interface HelloPayload {
  node_id: string;
  enclave: string;
  address: string;
  http_port: number;
  capabilities: { inbound: "auto" | "true" | "false" };
}

export interface WelcomePayload {
  topology: WireMessage[];
  your_position: { depth: number; parent_id: string };
  inbound_detected: boolean;
}

export interface GoodbyePayload {
  reason: string;
  alternative_parents: Array<{
    id: string;
    address: string;
    http_port: number;
    enclave?: string;
  }>;
}

// --- WebSocketConnection ---

export interface WebSocketConnectionEvents {
  message: [msg: Message];
  attachment: [msg: AttachmentMessage];
  close: [code: number, reason: string];
  error: [err: Error];
}

/**
 * Wraps a WebSocket (both server-accepted and client-initiated) with:
 * - WireMessage serialization matching HTTP gossip
 * - HMAC signing/verification when cluster secret is set
 * - Heartbeat ping/pong with dead connection detection
 * - Event emission for messages, close, and errors
 */
export class WebSocketConnection extends EventEmitter<WebSocketConnectionEvents> {
  private ws: WebSocket;
  private clusterSecret: string;
  private logger: Logger;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private missedPongs = 0;
  private closed = false;

  /** Remote node ID, populated after hello/welcome handshake. */
  remoteNodeId: string | null = null;

  /** Remote enclave, populated after hello/welcome handshake. */
  remoteEnclave: string | null = null;

  constructor(ws: WebSocket, clusterSecret: string, logger: Logger) {
    super();
    this.ws = ws;
    this.clusterSecret = clusterSecret;
    this.logger = logger;

    this.ws.on("message", (data: WebSocket.RawData) => {
      this.handleRawMessage(data);
    });

    this.ws.on("pong", () => {
      this.missedPongs = 0;
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      this.closed = true;
      this.stopHeartbeat();
      this.emit("close", code, reason.toString());
    });

    this.ws.on("error", (err: Error) => {
      this.logger.warn(`WebSocket error: ${err.message}`);
      this.emit("error", err);
    });
  }

  // --- Lifecycle ---

  /** Start sending heartbeat pings at the configured interval. */
  startHeartbeat(): void {
    if (this.heartbeatTimer) return;

    this.missedPongs = 0;
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) {
        this.stopHeartbeat();
        return;
      }

      this.missedPongs++;
      if (this.missedPongs > MAX_MISSED_PONGS) {
        this.logger.warn(
          `WebSocket to ${this.remoteNodeId ?? "unknown"}: ${this.missedPongs} missed pongs, closing`,
        );
        this.stopHeartbeat();
        this.ws.terminate();
        return;
      }

      this.ws.ping();
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Gracefully close the connection. */
  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    this.ws.close(code, reason);
  }

  /** Forcefully terminate (no close handshake). */
  terminate(): void {
    this.closed = true;
    this.stopHeartbeat();
    this.ws.terminate();
  }

  get isClosed(): boolean {
    return this.closed || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING;
  }

  get readyState(): number {
    return this.ws.readyState;
  }

  // --- Sending ---

  /**
   * Send a gossip Message over the WebSocket.
   * Serializes to WireMessage JSON, wraps in AttachmentMessage, signs if needed.
   */
  sendGossipMessage(msg: Message): void {
    const wireMsg = messageToWire(msg);
    const attachMsg: AttachmentMessage = {
      type: wireMessageTypeToAttachmentType(wireMsg.type),
      payload: wireMsg,
    };

    this.sendAttachmentMessage(attachMsg);
  }

  /**
   * Send a raw AttachmentMessage (hello, welcome, goodbye, or gossip).
   * Signs the payload if cluster secret is set.
   */
  sendAttachmentMessage(msg: AttachmentMessage): void {
    if (this.closed) return;

    const toSend = { ...msg };

    if (this.clusterSecret) {
      const payloadJson = JSON.stringify(msg.payload);
      toSend.signature = signBody(
        this.clusterSecret,
        Buffer.from(payloadJson),
      );
    }

    this.ws.send(JSON.stringify(toSend));
  }

  // --- Receiving ---

  private handleRawMessage(data: WebSocket.RawData): void {
    let json: string;
    if (Buffer.isBuffer(data)) {
      json = data.toString("utf-8");
    } else if (data instanceof ArrayBuffer) {
      json = Buffer.from(data).toString("utf-8");
    } else {
      // Array of Buffers
      json = Buffer.concat(data as Buffer[]).toString("utf-8");
    }

    let attachMsg: AttachmentMessage;
    try {
      attachMsg = JSON.parse(json) as AttachmentMessage;
    } catch {
      this.logger.warn("WebSocket received invalid JSON, ignoring");
      return;
    }

    if (!attachMsg.type || !attachMsg.payload) {
      this.logger.warn("WebSocket received malformed AttachmentMessage, ignoring");
      return;
    }

    // Verify HMAC if cluster secret is set
    if (this.clusterSecret) {
      if (!attachMsg.signature) {
        this.logger.warn("WebSocket message missing signature, rejecting");
        return;
      }

      const payloadJson = JSON.stringify(attachMsg.payload);
      if (
        !verifyBody(
          this.clusterSecret,
          Buffer.from(payloadJson),
          attachMsg.signature,
        )
      ) {
        this.logger.warn("WebSocket message signature invalid, rejecting");
        return;
      }
    }

    // Emit the raw attachment message for lifecycle handlers (hello/welcome/goodbye)
    this.emit("attachment", attachMsg);

    // For gossip message types, also deserialize and emit as a Message
    if (isGossipType(attachMsg.type)) {
      const wireMsg = attachMsg.payload as WireMessage;
      const msg = wireToMessage(wireMsg);
      this.emit("message", msg);
    }
  }
}

// --- Client factory ---

/**
 * Open an outbound WebSocket connection to a substrate node.
 * Returns a WebSocketConnection once the connection is established.
 */
export function connectToSubstrate(
  address: string,
  port: number,
  clusterSecret: string,
  logger: Logger,
  timeoutMs = 10_000,
): Promise<WebSocketConnection> {
  return new Promise((resolve, reject) => {
    const url = `ws://${address}:${port}/v1/ws`;
    const ws = new WebSocket(url);

    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error(`WebSocket connection to ${url} timed out`));
    }, timeoutMs);

    ws.on("open", () => {
      clearTimeout(timeout);
      const conn = new WebSocketConnection(ws, clusterSecret, logger);
      resolve(conn);
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// --- Helpers ---

const GOSSIP_TYPES: Set<AttachmentMessageType> = new Set([
  "put",
  "ack",
  "ping",
  "pong",
  "topology_sync",
]);

function isGossipType(type: AttachmentMessageType): boolean {
  return GOSSIP_TYPES.has(type);
}

function wireMessageTypeToAttachmentType(wireType: string): AttachmentMessageType {
  switch (wireType) {
    case "PUT":
      return "put";
    case "ACK":
      return "ack";
    case "PING":
      return "ping";
    case "PONG":
      return "pong";
    case "SYNC":
      return "topology_sync";
    default:
      return "put"; // fallback — shouldn't happen
  }
}
