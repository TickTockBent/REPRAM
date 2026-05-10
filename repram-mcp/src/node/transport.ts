/**
 * HTTP transport for gossip messages.
 *
 * Port of internal/gossip/http_transport.go. Handles serialization
 * between internal Message objects and the JSON wire format (WireMessage),
 * including base64 encoding of binary data for Go compatibility.
 *
 * Uses node:http with one dedicated Agent per peer — a persistent
 * connection that's always warm, no pool contention, no burst queuing.
 * Gossip talks to a fixed, known set of peers for the lifetime of the
 * process; a connection pool is the wrong abstraction (#116, #117).
 */

import { request as httpRequest, Agent } from "node:http";
import { signBody } from "./auth.js";
import type { Logger } from "./logger.js";
import type { Message, NodeInfo, WireMessage, WireNodeInfo } from "./types.js";

const bootstrapAgent = new Agent({ keepAlive: true, maxSockets: 2 });

export class HTTPTransport {
  private localNode: NodeInfo;
  private clusterSecret: string;
  private logger: Logger;
  private messageHandler: ((msg: Message) => void) | null = null;
  private peerAgents = new Map<string, Agent>();

  constructor(localNode: NodeInfo, clusterSecret: string, logger: Logger) {
    this.localNode = localNode;
    this.clusterSecret = clusterSecret;
    this.logger = logger;
  }

  private agentFor(target: NodeInfo): Agent {
    const key = `${target.address}:${target.httpPort}`;
    let agent = this.peerAgents.get(key);
    if (!agent) {
      agent = new Agent({ keepAlive: true, maxSockets: 8 });
      this.peerAgents.set(key, agent);
      this.logger.debug(`Created dedicated connection for peer ${target.id} (${key})`);
    }
    return agent;
  }

  onPeerRemoved(peer: NodeInfo): void {
    const key = `${peer.address}:${peer.httpPort}`;
    const agent = this.peerAgents.get(key);
    if (agent) {
      agent.destroy();
      this.peerAgents.delete(key);
      this.logger.debug(`Closed dedicated connection for evicted peer ${peer.id} (${key})`);
    }
  }

  destroy(): void {
    for (const agent of this.peerAgents.values()) {
      agent.destroy();
    }
    this.peerAgents.clear();
  }

  async send(target: NodeInfo, msg: Message): Promise<void> {
    const wireMsg = messageToWire(msg);
    const jsonBody = JSON.stringify(wireMsg);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(jsonBody)),
    };

    if (this.clusterSecret) {
      headers["X-Repram-Signature"] = signBody(this.clusterSecret, Buffer.from(jsonBody));
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const req = httpRequest(
        {
          hostname: target.address,
          port: target.httpPort,
          path: "/v1/gossip/message",
          method: "POST",
          headers,
          agent: this.agentFor(target),
        },
        (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => { body += chunk; });
          res.on("end", () => {
            if (settled) return;
            settled = true;
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              this.logger.debug(`Sent ${msg.type} message to ${target.id}`);
            } else {
              this.logger.warn(`Message rejected by ${target.id} with status ${res.statusCode}: ${body.slice(0, 200)}`);
            }
            resolve();
          });
        },
      );

      req.on("error", (err) => {
        if (settled) return;
        settled = true;
        this.logger.warn(`Failed to send message to ${target.id}: ${err}`);
        reject(err);
      });

      req.setTimeout(5_000, () => {
        req.destroy();
        if (settled) return;
        settled = true;
        this.logger.warn(`Send to ${target.id} timed out`);
        reject(new Error("timeout"));
      });

      req.end(jsonBody);
    });
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

// --- Shared HTTP helper ---

export interface HttpPostResult {
  statusCode: number;
  body: string;
}

export function httpPost(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs = 5_000,
): Promise<HttpPostResult> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
        agent: bootstrapAgent,
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk: Buffer) => { responseBody += chunk; });
        res.on("end", () => {
          if (!settled) { settled = true; resolve({ statusCode: res.statusCode ?? 0, body: responseBody }); }
        });
      },
    );

    req.on("error", (err) => { if (!settled) { settled = true; reject(err); } });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      if (!settled) { settled = true; reject(new Error("timeout")); }
    });
    req.end(body);
  });
}
