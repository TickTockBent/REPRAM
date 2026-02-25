/**
 * HTTP transport for gossip messages.
 *
 * Port of internal/gossip/http_transport.go. Handles serialization
 * between internal Message objects and the JSON wire format (WireMessage),
 * including base64 encoding of binary data for Go compatibility.
 */

import { signBody } from "./auth.js";
import type { Logger } from "./logger.js";
import type { Message, NodeInfo, WireMessage, WireNodeInfo } from "./types.js";

export class HTTPTransport {
  private localNode: NodeInfo;
  private clusterSecret: string;
  private logger: Logger;
  private messageHandler: ((msg: Message) => void) | null = null;

  constructor(localNode: NodeInfo, clusterSecret: string, logger: Logger) {
    this.localNode = localNode;
    this.clusterSecret = clusterSecret;
    this.logger = logger;
  }

  async send(target: NodeInfo, msg: Message): Promise<void> {
    const wireMsg = messageToWire(msg);
    const jsonBody = JSON.stringify(wireMsg);
    const bodyBuffer = Buffer.from(jsonBody);

    const url = `http://${target.address}:${target.httpPort}/v1/gossip/message`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.clusterSecret) {
      headers["X-Repram-Signature"] = signBody(this.clusterSecret, bodyBuffer);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: jsonBody,
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.warn(`Message rejected by ${target.id} with status ${response.status}`);
      } else {
        this.logger.debug(`Sent ${msg.type} message to ${target.id} at ${url}`);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        this.logger.warn(`Send to ${target.id} timed out`);
      } else {
        this.logger.warn(`Failed to send message to ${target.id}: ${err}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  setMessageHandler(handler: (msg: Message) => void): void {
    this.messageHandler = handler;
  }

  /**
   * Called by the HTTP server when a gossip message is received.
   * Deserializes the wire format and dispatches to the handler.
   */
  handleIncoming(wireMsg: WireMessage): void {
    if (!this.messageHandler) return;
    const msg = wireToMessage(wireMsg);
    this.messageHandler(msg);
  }
}

// --- Serialization ---

export function messageToWire(msg: Message): WireMessage {
  const wire: WireMessage = {
    type: msg.type,
    from: msg.from,
    timestamp: Math.floor(msg.timestamp.getTime() / 1000),
    message_id: msg.messageId,
  };

  if (msg.to) wire.to = msg.to;
  if (msg.key) wire.key = msg.key;
  if (msg.data && msg.data.length > 0) wire.data = msg.data.toString("base64");
  if (msg.ttl) wire.ttl = msg.ttl;

  if (msg.nodeInfo) {
    wire.node_info = nodeInfoToWire(msg.nodeInfo);
  }

  return wire;
}

export function wireToMessage(wire: WireMessage): Message {
  return {
    type: wire.type as Message["type"],
    from: wire.from,
    to: wire.to ?? "",
    key: wire.key ?? "",
    data: wire.data ? Buffer.from(wire.data, "base64") : Buffer.alloc(0),
    ttl: wire.ttl ?? 0,
    timestamp: new Date(wire.timestamp * 1000),
    messageId: wire.message_id,
    nodeInfo: wire.node_info ? wireToNodeInfo(wire.node_info) : undefined,
  };
}

function nodeInfoToWire(info: NodeInfo): WireNodeInfo {
  const wire: WireNodeInfo = {
    id: info.id,
    address: info.address,
    port: info.port,
    http_port: info.httpPort,
  };
  if (info.enclave) wire.enclave = info.enclave;
  return wire;
}

function wireToNodeInfo(wire: WireNodeInfo): NodeInfo {
  return {
    id: wire.id,
    address: wire.address,
    port: wire.port,
    httpPort: wire.http_port,
    enclave: wire.enclave ?? "default",
  };
}
