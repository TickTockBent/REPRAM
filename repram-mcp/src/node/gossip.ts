/**
 * Gossip protocol — peer management, message routing, and probabilistic fanout.
 *
 * Port of internal/gossip/protocol.go. Node.js is single-threaded so we
 * don't need the Go mutex machinery — all operations are synchronous between
 * awaits.
 */

import type { Logger } from "./logger.js";
import type { Message, NodeInfo } from "./types.js";

// --- Constants matching Go ---

/** Consecutive ping failures before a peer is evicted (~90s at 30s interval). */
export const MAX_PING_FAILURES = 3;

/** Enclave peer count above which gossip switches from full broadcast to √N fanout. */
export const FANOUT_THRESHOLD = 10;

/** How long a message ID stays in the dedup cache (ms). */
export const SEEN_MESSAGE_TTL_MS = 60_000;

/** Maximum entries in the dedup cache before eviction kicks in. */
export const MAX_SEEN_MESSAGES = 100_000;

// --- Transport interface ---

export interface Transport {
  send(target: NodeInfo, msg: Message): Promise<void>;
  setMessageHandler(handler: (msg: Message) => void): void;
}

// --- Message ID generation ---

let messageCounter = 0;

export function generateMessageID(): string {
  messageCounter++;
  // Match Go format: {UnixNano}-{counter}
  // JS doesn't have nanosecond precision — use ms * 1e6 for compatibility
  const nanos = BigInt(Date.now()) * 1_000_000n;
  return `${nanos}-${messageCounter}`;
}

/** Reset counter — test use only. */
export function _resetMessageCounter(): void {
  messageCounter = 0;
}

// --- Fanout helpers (exported for testing) ---

/** Returns √N (rounded up, minimum 1). Returns 0 for empty input. */
export function fanoutSize(peerCount: number): number {
  if (peerCount <= 0) return 0;
  const f = Math.ceil(Math.sqrt(peerCount));
  return Math.max(f, 1);
}

/** Pick n random peers from the list, excluding skipId. */
export function selectRandomPeers(
  peers: NodeInfo[],
  n: number,
  skipId: string,
): NodeInfo[] {
  const candidates = peers.filter((p) => p.id !== skipId);
  if (candidates.length <= n) return candidates;

  // Fisher-Yates shuffle then take first n
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, n);
}

// --- GossipProtocol ---

export class GossipProtocol {
  private localNode: NodeInfo;
  private replicationFactor: number;
  private logger: Logger;

  private peers = new Map<string, NodeInfo>();
  private peerFailures = new Map<string, number>();
  private transport: Transport | null = null;
  private messageHandler: ((msg: Message) => void) | null = null;

  /** Dedup cache: messageID → expiry timestamp (Date.now() + TTL). */
  private seenMessages = new Map<string, number>();

  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private topologySyncTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  /** Optional metrics callbacks for production use. */
  private metricsCallbacks: GossipMetrics | null = null;

  constructor(
    localNode: NodeInfo,
    replicationFactor: number,
    logger: Logger,
  ) {
    this.localNode = localNode;
    this.replicationFactor = replicationFactor;
    this.logger = logger;
  }

  // --- Lifecycle ---

  setTransport(transport: Transport): void {
    this.transport = transport;
    transport.setMessageHandler((msg) => this.handleMessage(msg));
  }

  setMessageHandler(handler: (msg: Message) => void): void {
    this.messageHandler = handler;
  }

  enableMetrics(metrics: GossipMetrics): void {
    this.metricsCallbacks = metrics;
  }

  start(): void {
    if (!this.transport) throw new Error("transport not set");
    this.stopped = false;

    this.healthCheckTimer = setInterval(() => {
      this.pingPeers();
      this.cleanupSeenMessages();
    }, 30_000);

    this.topologySyncTimer = setInterval(() => {
      this.performTopologySync();
    }, 30_000);

    this.logger.info(`[${this.localNode.id}] Gossip protocol started`);
  }

  stop(): void {
    this.stopped = true;
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    if (this.topologySyncTimer) {
      clearInterval(this.topologySyncTimer);
      this.topologySyncTimer = null;
    }
  }

  // --- Peer management ---

  addPeer(node: NodeInfo): void {
    this.peers.set(node.id, node);
    this.peerFailures.delete(node.id); // reset failure counter on (re-)add
    this.metricsCallbacks?.onPeersActive(this.peers.size);
    this.metricsCallbacks?.onPeerJoin();
  }

  removePeer(nodeId: string): void {
    this.peers.delete(nodeId);
    this.peerFailures.delete(nodeId);
    this.metricsCallbacks?.onPeersActive(this.peers.size);
  }

  getPeers(): NodeInfo[] {
    return Array.from(this.peers.values());
  }

  /** Returns only peers in the same enclave as the local node. */
  getReplicationPeers(): NodeInfo[] {
    return Array.from(this.peers.values()).filter(
      (p) => p.enclave === this.localNode.enclave,
    );
  }

  peerFailureCount(id: string): number {
    return this.peerFailures.get(id) ?? 0;
  }

  getLocalNode(): NodeInfo {
    return this.localNode;
  }

  // --- Message handling ---

  handleMessage(msg: Message): void {
    switch (msg.type) {
      case "PING":
        this.handlePing(msg);
        break;
      case "PONG":
        this.handlePong(msg);
        break;
      case "SYNC":
        this.handleSync(msg);
        break;
      case "PUT":
      case "ACK":
        // Application-level messages — pass to handler
        this.messageHandler?.(msg);
        break;
      default:
        // Unknown message type — pass to handler
        this.messageHandler?.(msg);
    }
  }

  private handlePing(msg: Message): void {
    const peer = this.peers.get(msg.from);
    if (!peer) return;

    const pong: Message = {
      type: "PONG",
      from: this.localNode.id,
      to: msg.from,
      key: "",
      data: Buffer.alloc(0),
      ttl: 0,
      timestamp: new Date(),
      messageId: generateMessageID(),
      nodeInfo: this.localNode, // include identity and enclave membership
    };

    this.transport?.send(peer, pong);
  }

  private handlePong(msg: Message): void {
    // Reset failure counter — peer is alive
    this.peerFailures.delete(msg.from);

    // Update peer's enclave membership if included
    if (msg.nodeInfo) {
      const enclave = msg.nodeInfo.enclave || "default";
      const existing = this.peers.get(msg.nodeInfo.id);
      if (existing && existing.enclave !== enclave) {
        existing.enclave = enclave;
        this.logger.debug(
          `[${this.localNode.id}] Updated peer ${msg.nodeInfo.id} enclave to ${enclave} via PONG`,
        );
      }
    }
  }

  private handleSync(msg: Message): void {
    this.logger.debug(`[${this.localNode.id}] Received SYNC from ${msg.from}`);

    if (msg.nodeInfo) {
      const nodeInfo = { ...msg.nodeInfo };
      if (!nodeInfo.enclave) nodeInfo.enclave = "default";

      // Don't add ourselves as a peer
      if (nodeInfo.id === this.localNode.id) return;

      const existing = this.peers.get(nodeInfo.id);
      if (!existing) {
        this.addPeer(nodeInfo);
        this.logger.info(
          `[${this.localNode.id}] Learned about new peer ${nodeInfo.id} (enclave: ${nodeInfo.enclave}) via SYNC from ${msg.from}`,
        );
      } else if (existing.enclave !== nodeInfo.enclave) {
        this.addPeer(nodeInfo);
        this.logger.info(
          `[${this.localNode.id}] Updated peer ${nodeInfo.id} enclave: ${existing.enclave} → ${nodeInfo.enclave} (via SYNC from ${msg.from})`,
        );
      } else {
        this.logger.debug(
          `[${this.localNode.id}] Already know peer ${nodeInfo.id} (SYNC from ${msg.from})`,
        );
      }
    } else {
      this.logger.debug(
        `[${this.localNode.id}] SYNC from ${msg.from} has no NodeInfo`,
      );
    }

    // Respond with peer list — only for direct SYNCs (From == NodeInfo.id)
    // to prevent amplification loops
    if (msg.nodeInfo && msg.nodeInfo.id === msg.from) {
      this.respondWithPeerList(msg.from);
    }
  }

  /** Send a SYNC for each known peer (+ ourselves) to the target. */
  private respondWithPeerList(targetId: string): void {
    const target = this.peers.get(targetId);
    if (!target) return;

    const allNodes = [...this.getPeers(), this.localNode];
    for (const node of allNodes) {
      // Don't tell the target about itself
      if (node.id === targetId) continue;

      const syncMsg: Message = {
        type: "SYNC",
        from: this.localNode.id,
        to: "",
        key: "",
        data: Buffer.alloc(0),
        ttl: 0,
        timestamp: new Date(),
        messageId: generateMessageID(),
        nodeInfo: node,
      };

      this.transport?.send(target, syncMsg).catch((err) => {
        this.logger.debug(
          `[${this.localNode.id}] Failed to send peer info for ${node.id} to ${targetId}: ${err}`,
        );
      });
    }
  }

  // --- Dedup cache ---

  /**
   * Records a message ID in the dedup cache. Returns true if already seen
   * (duplicate), false if new. Evicts when cache exceeds capacity.
   */
  markSeen(messageId: string): boolean {
    if (this.seenMessages.has(messageId)) return true;

    // Enforce capacity bound
    if (this.seenMessages.size >= MAX_SEEN_MESSAGES) {
      this.evictSeen();
    }

    this.seenMessages.set(messageId, Date.now() + SEEN_MESSAGE_TTL_MS);
    return false;
  }

  /** Remove expired entries, then drop oldest half if still at capacity. */
  private evictSeen(): void {
    const now = Date.now();

    // Phase 1: remove expired
    for (const [id, expiry] of this.seenMessages) {
      if (now >= expiry) {
        this.seenMessages.delete(id);
      }
    }

    // Phase 2: if still over limit, drop oldest half
    if (this.seenMessages.size >= MAX_SEEN_MESSAGES) {
      let earliest = now + SEEN_MESSAGE_TTL_MS;
      let latest = 0;
      for (const expiry of this.seenMessages.values()) {
        if (expiry < earliest) earliest = expiry;
        if (expiry > latest) latest = expiry;
      }
      const midpoint = earliest + (latest - earliest) / 2;

      for (const [id, expiry] of this.seenMessages) {
        if (expiry < midpoint) {
          this.seenMessages.delete(id);
        }
      }
    }
  }

  private cleanupSeenMessages(): void {
    const now = Date.now();
    for (const [id, expiry] of this.seenMessages) {
      if (now >= expiry) {
        this.seenMessages.delete(id);
      }
    }
  }

  /** Exposed for testing: current dedup cache size. */
  seenMessageCount(): number {
    return this.seenMessages.size;
  }

  // --- Broadcasting ---

  /**
   * Send a message to enclave peers. Small enclaves (≤ threshold) get full
   * broadcast. Larger enclaves get √N probabilistic fanout.
   */
  async broadcastToEnclave(msg: Message): Promise<void> {
    if (!this.transport) throw new Error("transport not set");

    // Mark as seen by the originator
    this.markSeen(msg.messageId);

    const peers = this.getReplicationPeers();

    if (peers.length <= FANOUT_THRESHOLD) {
      // Small enclave: full broadcast
      this.logger.debug(
        `[${this.localNode.id}] Broadcasting ${msg.type} to ${peers.length} enclave peers (${this.localNode.enclave})`,
      );
      for (const peer of peers) {
        try {
          await this.transport.send(peer, msg);
        } catch (err) {
          this.logger.warn(
            `[${this.localNode.id}] Failed to send to enclave peer ${peer.id}: ${err}`,
          );
        }
      }
    } else {
      // Large enclave: √N probabilistic fanout
      const count = fanoutSize(peers.length);
      const targets = selectRandomPeers(peers, count, "");
      this.logger.debug(
        `[${this.localNode.id}] Fanout ${msg.type} to ${targets.length}/${peers.length} enclave peers (${this.localNode.enclave})`,
      );
      for (const peer of targets) {
        try {
          await this.transport.send(peer, msg);
        } catch (err) {
          this.logger.warn(
            `[${this.localNode.id}] Failed to send to enclave peer ${peer.id}: ${err}`,
          );
        }
      }
    }
  }

  /**
   * Forward a received message to √N random enclave peers (excluding sender).
   * Only forwards if the enclave is above the fanout threshold — for small
   * enclaves, the originator already sent to everyone.
   */
  async forwardToEnclave(msg: Message): Promise<void> {
    const peers = this.getReplicationPeers();
    if (peers.length <= FANOUT_THRESHOLD) return;

    const count = fanoutSize(peers.length);
    const targets = selectRandomPeers(peers, count, msg.from);
    if (targets.length === 0) return;

    this.logger.debug(
      `[${this.localNode.id}] Forwarding ${msg.type} (key: ${msg.key}) to ${targets.length} enclave peers`,
    );
    for (const peer of targets) {
      try {
        await this.transport!.send(peer, msg);
      } catch (err) {
        this.logger.warn(
          `[${this.localNode.id}] Failed to forward to enclave peer ${peer.id}: ${err}`,
        );
      }
    }
  }

  /** Send a message to a specific node. */
  async send(target: NodeInfo, msg: Message): Promise<void> {
    if (!this.transport) throw new Error("transport not set");
    await this.transport.send(target, msg);
  }

  /** Broadcast to ALL known peers (not enclave-scoped). Used by topology sync. */
  async broadcast(msg: Message): Promise<void> {
    if (!this.transport) throw new Error("transport not set");

    const peers = this.getPeers();
    this.logger.debug(
      `[${this.localNode.id}] Broadcasting ${msg.type} to ${peers.length} peers`,
    );
    for (const peer of peers) {
      try {
        await this.transport.send(peer, msg);
      } catch (err) {
        this.logger.warn(
          `[${this.localNode.id}] Failed to send to peer ${peer.id}: ${err}`,
        );
      }
    }
  }

  // --- Health checks ---

  /** Ping all peers, track failures, evict after MaxPingFailures. */
  private async pingPeers(): Promise<void> {
    const peers = this.getPeers();
    const evictions: string[] = [];

    for (const peer of peers) {
      const ping: Message = {
        type: "PING",
        from: this.localNode.id,
        to: peer.id,
        key: "",
        data: Buffer.alloc(0),
        ttl: 0,
        timestamp: new Date(),
        messageId: generateMessageID(),
      };

      try {
        await this.transport!.send(peer, ping);
      } catch (err) {
        const failures = (this.peerFailures.get(peer.id) ?? 0) + 1;
        this.peerFailures.set(peer.id, failures);
        this.metricsCallbacks?.onPingFailure();

        this.logger.warn(
          `[${this.localNode.id}] Ping failed for peer ${peer.id} (${failures}/${MAX_PING_FAILURES}): ${err}`,
        );

        if (failures >= MAX_PING_FAILURES) {
          evictions.push(peer.id);
        }
      }
    }

    for (const id of evictions) {
      this.removePeer(id);
      this.metricsCallbacks?.onPeerEviction();
      this.logger.info(
        `[${this.localNode.id}] Evicted peer ${id} after ${MAX_PING_FAILURES} consecutive ping failures`,
      );
    }
  }

  // --- Topology sync ---

  private async performTopologySync(): Promise<void> {
    const expectedPeers = this.replicationFactor - 1;
    if (this.peers.size >= expectedPeers) return;

    this.logger.debug(
      `[${this.localNode.id}] Topology sync: have ${this.peers.size} peers, expected ${expectedPeers} - requesting peer lists`,
    );

    const msg: Message = {
      type: "SYNC",
      from: this.localNode.id,
      to: "",
      key: "",
      data: Buffer.alloc(0),
      ttl: 0,
      timestamp: new Date(),
      messageId: generateMessageID(),
      nodeInfo: this.localNode,
    };

    await this.broadcast(msg);
  }
}

// --- Metrics interface ---

export interface GossipMetrics {
  onPeersActive(count: number): void;
  onPeerJoin(): void;
  onPeerEviction(): void;
  onPingFailure(): void;
}
