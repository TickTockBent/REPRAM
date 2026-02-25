/**
 * HTTP server — routes, handlers, config, graceful shutdown.
 *
 * Port of cmd/repram/main.go. Uses Node.js native http module with
 * manual routing (no Express/Fastify — matches Go's minimal-deps approach).
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { Logger } from "./logger.js";
import { ClusterNode, WRITE_STATUS_ACCEPTED } from "./cluster.js";
import { SecurityMiddleware, applyCorsHeaders } from "./middleware.js";
import { wireToMessage } from "./transport.js";
import { verifyBody } from "./auth.js";
import { StoreFull } from "./storage.js";
import { WebSocketConnection, type AttachmentMessage, type HelloPayload } from "./ws-transport.js";
import type { WireMessage } from "./types.js";
import type { Transport } from "./gossip.js";
import { TreeManager, type InboundCapability } from "./tree.js";

// ─── Configuration ───────────────────────────────────────────────────

export interface ServerConfig {
  httpPort: number;
  gossipPort: number;
  address: string;
  nodeId: string;
  network: string;
  enclave: string;
  replicationFactor: number;
  minTTL: number;
  maxTTL: number;
  writeTimeoutMs: number;
  clusterSecret: string;
  rateLimit: number;
  trustProxy: boolean;
  maxStorageBytes: number;
  logLevel: string;
  /** Whether this node can accept inbound connections: auto, true, or false. */
  inbound: InboundCapability;
  /** Maximum transient node attachments (0 = never accept). */
  maxChildren: number;
}

/**
 * Load config from REPRAM_* env vars. When `embedded` is true (MCP mode),
 * defaults are conservative: port 0 (auto-select), 50MB storage cap, warn log level.
 */
export function loadConfig(embedded = false): ServerConfig {
  return {
    httpPort: envInt("REPRAM_HTTP_PORT", embedded ? 0 : 8080),
    gossipPort: envInt("REPRAM_GOSSIP_PORT", embedded ? 0 : 9090),
    address: process.env.REPRAM_ADDRESS ?? "localhost",
    nodeId: process.env.REPRAM_NODE_ID ?? `node-${Date.now()}`,
    network: process.env.REPRAM_NETWORK ?? "public",
    enclave: process.env.REPRAM_ENCLAVE ?? "default",
    replicationFactor: envInt("REPRAM_REPLICATION", 3),
    minTTL: envInt("REPRAM_MIN_TTL", 300),
    maxTTL: envInt("REPRAM_MAX_TTL", 86400),
    writeTimeoutMs: envInt("REPRAM_WRITE_TIMEOUT", 5) * 1000,
    clusterSecret: process.env.REPRAM_CLUSTER_SECRET ?? "",
    rateLimit: envInt("REPRAM_RATE_LIMIT", 100),
    trustProxy: (process.env.REPRAM_TRUST_PROXY ?? "").toLowerCase() === "true",
    maxStorageBytes: envInt("REPRAM_MAX_STORAGE_MB", embedded ? 50 : 0) * 1024 * 1024,
    logLevel: process.env.REPRAM_LOG_LEVEL ?? (embedded ? "warn" : "info"),
    inbound: (process.env.REPRAM_INBOUND ?? "auto") as InboundCapability,
    maxChildren: envInt("REPRAM_MAX_CHILDREN", 100),
  };
}

function envInt(key: string, defaultVal: number): number {
  const value = process.env[key];
  if (value) {
    const parsed = parseInt(value, 10);
    if (!isNaN(parsed)) return parsed;
  }
  return defaultVal;
}

// ─── HTTP Server ─────────────────────────────────────────────────────

export class HTTPServer {
  readonly clusterNode: ClusterNode;
  readonly treeManager: TreeManager;
  private server: Server;
  private wss: WebSocketServer;
  private logger: Logger;
  private config: ServerConfig;
  private securityMW: SecurityMiddleware;
  private startTime = Date.now();

  /** Active WebSocket connections from attached transient nodes. */
  private wsConnections = new Set<WebSocketConnection>();

  constructor(config: ServerConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;

    this.clusterNode = new ClusterNode(
      {
        nodeId: config.nodeId,
        address: config.address,
        gossipPort: config.gossipPort,
        httpPort: config.httpPort,
        enclave: config.enclave,
        replicationFactor: config.replicationFactor,
        maxStorageBytes: config.maxStorageBytes,
        writeTimeoutMs: config.writeTimeoutMs,
        clusterSecret: config.clusterSecret,
      },
      logger,
    );

    this.treeManager = new TreeManager(
      this.clusterNode.localNode,
      this.clusterNode.gossip,
      logger,
      {
        inbound: config.inbound,
        maxChildren: config.maxChildren,
        clusterSecret: config.clusterSecret,
      },
    );

    // Wire ClusterNode ↔ TreeManager for relay forwarding and ACK routing
    this.clusterNode.setTreeManager(this.treeManager);

    this.securityMW = new SecurityMiddleware({
      rateLimit: config.rateLimit,
      burst: config.rateLimit * 2,
      maxRequestSize: 10 * 1024 * 1024, // 10MB
      trustProxy: config.trustProxy,
    });

    this.server = createServer((req, res) => this.handleRequest(req, res));

    // WebSocket server — no auto-accept, we handle upgrades manually on /v1/ws
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.handleUpgrade(req, socket, head);
    });
  }

  setTransport(transport: Transport): void {
    this.clusterNode.setTransport(transport);
  }

  /** Return active WebSocket connections (for testing and tree management). */
  getWSConnections(): ReadonlySet<WebSocketConnection> {
    return this.wsConnections;
  }

  // ─── WebSocket upgrade ──────────────────────────────────────────

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname !== "/v1/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = new WebSocketConnection(ws, this.config.clusterSecret, this.logger);
      this.wsConnections.add(conn);

      this.logger.info(`WebSocket connection accepted from ${req.socket.remoteAddress}`);

      // Route incoming gossip messages — PUTs from attached children go
      // through relay, everything else through normal gossip handling
      conn.on("message", (msg) => {
        if (msg.type === "PUT" && conn.remoteNodeId && this.treeManager.getChildren().has(conn.remoteNodeId)) {
          // Relay: child PUT → store locally, fan out to mesh, forward to siblings
          this.clusterNode.handleRelayPut(msg, conn);
        } else {
          this.clusterNode.gossip.handleMessage(msg);
        }
      });

      // Handle attachment lifecycle messages
      conn.on("attachment", (attachMsg: AttachmentMessage) => {
        if (attachMsg.type === "hello") {
          const hello = attachMsg.payload as HelloPayload;
          this.treeManager.handleHello(conn, hello).catch((err) => {
            this.logger.warn(`Failed to handle hello from ${hello.node_id}: ${err}`);
          });
        }
      });

      conn.on("close", () => {
        this.wsConnections.delete(conn);
        this.logger.info(`WebSocket connection closed (${this.wsConnections.size} remaining)`);
      });

      conn.on("error", (err) => {
        this.logger.warn(`WebSocket connection error: ${err.message}`);
      });

      conn.startHeartbeat();
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.clusterNode.start();
      this.server.listen(this.config.httpPort, () => {
        this.logger.info(
          `REPRAM node online. HTTP: :${this.config.httpPort}  Network: ${this.config.network}`,
        );
        this.logger.info(
          `  Node ID: ${this.config.nodeId}  Enclave: ${this.config.enclave}`,
        );
        this.logger.info(
          `  Replication: ${this.config.replicationFactor}  TTL range: ${this.config.minTTL}-${this.config.maxTTL}s`,
        );
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.logger.info("Shutting down — draining in-flight requests...");

    // Send goodbye to all attached transient nodes before closing
    this.treeManager.sendGoodbyeToChildren();

    // Brief grace period for goodbye messages to send
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Clean up tree manager state
    this.treeManager.stop();

    // Close all WebSocket connections
    for (const conn of this.wsConnections) {
      conn.close(1001, "server shutting down");
    }
    this.wsConnections.clear();

    this.wss.close();

    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      // Force close after 10s drain timeout
      setTimeout(() => resolve(), 10_000);
    });

    this.securityMW.close();
    this.clusterNode.stop();
    this.logger.info("Shutdown complete.");
  }

  /** Return the underlying http.Server (for testing). */
  getServer(): Server {
    return this.server;
  }

  // ─── Request router ──────────────────────────────────────────────

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // CORS on all requests
    applyCorsHeaders(req, res);

    // OPTIONS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    // Security checks (rate limit, scanner, size)
    const clientIP = this.securityMW.check(req, res);
    if (!clientIP) return; // rejected

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    // Route matching
    const dataMatch = path.match(/^\/v1\/data\/(.+)$/);
    if (dataMatch) {
      const key = decodeURIComponent(dataMatch[1]);
      if (method === "PUT") {
        this.putHandler(req, res, key);
        return;
      }
      if (method === "GET" || method === "HEAD") {
        this.getHandler(req, res, key);
        return;
      }
    }

    if (path === "/v1/keys" && method === "GET") {
      this.keysHandler(req, res, url);
      return;
    }
    if (path === "/v1/health" && method === "GET") {
      this.healthHandler(req, res);
      return;
    }
    if (path === "/v1/status" && method === "GET") {
      this.statusHandler(req, res);
      return;
    }
    if (path === "/v1/topology" && method === "GET") {
      this.topologyHandler(req, res);
      return;
    }
    if (path === "/v1/gossip/message" && method === "POST") {
      this.gossipHandler(req, res);
      return;
    }
    if (path === "/v1/bootstrap" && method === "POST") {
      this.bootstrapHandler(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }

  // ─── Handlers ────────────────────────────────────────────────────

  private putHandler(req: IncomingMessage, res: ServerResponse, key: string): void {
    readBody(req, (err, body) => {
      if (err) {
        const status = err.message === "Request body too large" ? 413 : 400;
        res.writeHead(status, { "Content-Type": "text/plain" });
        res.end(err.message);
        return;
      }

      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      // TTL: query param → header → default 3600
      let ttl = 3600;
      const ttlQuery = url.searchParams.get("ttl");
      const ttlHeader = req.headers["x-ttl"] as string | undefined;
      if (ttlQuery) {
        const parsed = parseInt(ttlQuery, 10);
        if (!isNaN(parsed) && parsed > 0) ttl = parsed;
      } else if (ttlHeader) {
        const parsed = parseInt(ttlHeader, 10);
        if (!isNaN(parsed) && parsed > 0) ttl = parsed;
      }

      // Clamp TTL
      ttl = Math.max(this.config.minTTL, Math.min(this.config.maxTTL, ttl));

      this.clusterNode
        .put(key, body, ttl)
        .then((result) => {
          if (result.status === WRITE_STATUS_ACCEPTED) {
            res.writeHead(202, { "Content-Type": "text/plain" });
            res.end("Accepted (quorum pending)");
          } else {
            res.writeHead(201, { "Content-Type": "text/plain" });
            res.end("OK");
          }
        })
        .catch((writeErr) => {
          if (writeErr instanceof StoreFull) {
            res.writeHead(507, { "Content-Type": "text/plain" });
            res.end("Node storage capacity exceeded");
          } else {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end(`Write failed: ${writeErr}`);
          }
        });
    });
  }

  private getHandler(
    _req: IncomingMessage,
    res: ServerResponse,
    key: string,
  ): void {
    const entry = this.clusterNode.getWithMetadata(key);
    if (!entry) {
      res.writeHead(404);
      res.end();
      return;
    }

    const remainingMs = entry.expiresAt - Date.now();
    const remainingTtl = Math.max(0, Math.floor(remainingMs / 1000));

    res.setHeader("X-Created-At", new Date(entry.createdAt).toISOString());
    res.setHeader("X-Original-TTL", String(entry.ttlSeconds));
    res.setHeader("X-Remaining-TTL", String(remainingTtl));
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(entry.data.length));
    res.writeHead(200);
    res.end(entry.data);
  }

  private keysHandler(
    _req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): void {
    const prefix = url.searchParams.get("prefix") ?? undefined;
    let keys = this.clusterNode.scan(prefix);

    // Sort for stable cursor-based pagination
    keys.sort();

    // Cursor: skip keys <= cursor value
    const cursor = url.searchParams.get("cursor");
    if (cursor) {
      const idx = binarySearch(keys, cursor);
      keys = keys.slice(idx);
    }

    // Limit
    let nextCursor: string | undefined;
    const limitStr = url.searchParams.get("limit");
    if (limitStr) {
      const limit = parseInt(limitStr, 10);
      if (!isNaN(limit) && limit > 0 && keys.length > limit) {
        nextCursor = keys[limit - 1];
        keys = keys.slice(0, limit);
      }
    }

    const body: Record<string, unknown> = { keys };
    if (nextCursor) body.next_cursor = nextCursor;

    sendJSON(res, 200, body);
  }

  private healthHandler(_req: IncomingMessage, res: ServerResponse): void {
    sendJSON(res, 200, {
      status: "healthy",
      node_id: this.config.nodeId,
      network: this.config.network,
      enclave: this.clusterNode.getEnclave(),
    });
  }

  private statusHandler(_req: IncomingMessage, res: ServerResponse): void {
    const mem = process.memoryUsage();
    sendJSON(res, 200, {
      status: "healthy",
      node_id: this.config.nodeId,
      network: this.config.network,
      enclave: this.clusterNode.getEnclave(),
      uptime: `${Math.floor(process.uptime())}s`,
      memory: {
        rss: mem.rss,
        heap_used: mem.heapUsed,
        heap_total: mem.heapTotal,
        external: mem.external,
      },
    });
  }

  private topologyHandler(_req: IncomingMessage, res: ServerResponse): void {
    const peers = this.clusterNode.topology();
    sendJSON(res, 200, {
      node_id: this.config.nodeId,
      enclave: this.clusterNode.getEnclave(),
      peers: peers.map((p) => ({
        id: p.id,
        address: p.address,
        http_port: p.httpPort,
        enclave: p.enclave,
      })),
    });
  }

  private gossipHandler(req: IncomingMessage, res: ServerResponse): void {
    readBody(req, (err, body) => {
      if (err) {
        const status = err.message === "Request body too large" ? 413 : 400;
        res.writeHead(status, { "Content-Type": "text/plain" });
        res.end(err.message);
        return;
      }

      if (!this.verifySignature(req, res, body)) return;

      let wireMsg: WireMessage;
      try {
        wireMsg = JSON.parse(body.toString());
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid JSON");
        return;
      }

      const msg = wireToMessage(wireMsg);
      this.clusterNode.gossip.handleMessage(msg);

      sendJSON(res, 200, { success: true });
    });
  }

  private bootstrapHandler(req: IncomingMessage, res: ServerResponse): void {
    readBody(req, (err, body) => {
      if (err) {
        const status = err.message === "Request body too large" ? 413 : 400;
        res.writeHead(status, { "Content-Type": "text/plain" });
        res.end(err.message);
        return;
      }

      if (!this.verifySignature(req, res, body)) return;

      let bootstrapReq: {
        node_id: string;
        address: string;
        gossip_port: number;
        http_port: number;
        enclave?: string;
      };
      try {
        bootstrapReq = JSON.parse(body.toString());
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid JSON");
        return;
      }

      const enclave = bootstrapReq.enclave || "default";
      const newPeer = {
        id: bootstrapReq.node_id,
        address: bootstrapReq.address,
        port: bootstrapReq.gossip_port,
        httpPort: bootstrapReq.http_port,
        enclave,
      };

      // Add the new node as a peer
      this.clusterNode.gossip.addPeer(newPeer);
      this.logger.info(`[${this.config.nodeId}] Node ${newPeer.id} joined via bootstrap`);

      // Return current topology (all peers + ourselves)
      const peers = this.clusterNode.gossip.getPeers();
      const allPeers = [...peers, this.clusterNode.localNode];

      sendJSON(res, 200, {
        success: true,
        peers: allPeers.map((p) => ({
          id: p.id,
          address: p.address,
          port: p.port,
          http_port: p.httpPort,
          enclave: p.enclave,
        })),
      });
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  private verifySignature(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
  ): boolean {
    const secret = this.clusterNode.getClusterSecret();
    if (!secret) return true; // open mode

    const sig = req.headers["x-repram-signature"] as string | undefined;
    if (!sig) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Missing signature");
      return false;
    }
    if (!verifyBody(secret, body, sig)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Invalid signature");
      return false;
    }
    return true;
  }
}

// ─── Utilities ───────────────────────────────────────────────────────

function sendJSON(
  res: ServerResponse,
  status: number,
  data: unknown,
): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}

function readBody(
  req: IncomingMessage,
  callback: (err: Error | null, body: Buffer) => void,
  maxBytes = 10 * 1024 * 1024, // 10MB default, matches SecurityMiddleware
): void {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let exceeded = false;

  req.on("data", (chunk: Buffer) => {
    if (exceeded) return; // stop accumulating, let stream drain
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      exceeded = true;
      // Resume to drain remaining data so the socket stays usable for the response.
      // Don't destroy — that kills the shared socket and prevents writing 413.
      req.resume();
      callback(new Error("Request body too large"), Buffer.alloc(0));
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (!exceeded) callback(null, Buffer.concat(chunks));
  });
  req.on("error", (err) => {
    if (!exceeded) callback(err, Buffer.alloc(0));
  });
}

/**
 * Binary search for cursor pagination. Returns the index of the first
 * key AFTER the cursor value (skip past cursor key itself).
 */
function binarySearch(sortedKeys: string[], cursor: string): number {
  let lo = 0;
  let hi = sortedKeys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedKeys[mid] <= cursor) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}
