/**
 * ClusterNode — quorum-based write coordination over gossip.
 *
 * Port of internal/cluster/node.go. Ties together MemoryStore, GossipProtocol,
 * and Transport to form a fully operational REPRAM node.
 *
 * Write flow:
 *  1. Store locally in MemoryStore (counts as 1 confirmation)
 *  2. Broadcast PUT to enclave peers via gossip
 *  3. Await quorum ACKs (or timeout → 202 Accepted)
 *
 * Quorum = floor(min(enclaveNodes, replicationFactor) / 2) + 1
 * where enclaveNodes includes the local node.
 */

import { MemoryStore } from "./storage.js";
import { GossipProtocol, generateMessageID } from "./gossip.js";
import type { Transport } from "./gossip.js"; // used by setTransport
import type { Logger } from "./logger.js";
import type { Message, NodeInfo } from "./types.js";
import type { TreeManager } from "./tree.js";
import type { WebSocketConnection } from "./ws-transport.js";

/** Quorum reached — all replicas confirmed. */
export const WRITE_STATUS_CREATED = 201;

/** Stored locally, replication pending (timeout or single-node fallback). */
export const WRITE_STATUS_ACCEPTED = 202;

export interface WriteResult {
  status: typeof WRITE_STATUS_CREATED | typeof WRITE_STATUS_ACCEPTED;
}

interface WriteOperation {
  resolve: (result: WriteResult) => void;
  confirmations: number;
  quorumNeeded: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface ClusterNodeOptions {
  nodeId: string;
  address: string;
  gossipPort: number;
  httpPort: number;
  enclave?: string;
  replicationFactor?: number;
  maxStorageBytes?: number;
  writeTimeoutMs?: number;
  clusterSecret?: string;
}

export class ClusterNode {
  readonly localNode: NodeInfo;
  readonly store: MemoryStore;
  readonly gossip: GossipProtocol;

  private replicationFactor: number;
  private writeTimeoutMs: number;
  private clusterSecret: string;
  private pendingWrites = new Map<string, WriteOperation>();
  private logger: Logger;
  private treeManager: TreeManager | null = null;

  constructor(options: ClusterNodeOptions, logger: Logger) {
    const enclave = options.enclave || "default";
    this.localNode = {
      id: options.nodeId,
      address: options.address,
      port: options.gossipPort,
      httpPort: options.httpPort,
      enclave,
    };

    this.replicationFactor = options.replicationFactor ?? 3;
    this.writeTimeoutMs = options.writeTimeoutMs ?? 5_000;
    this.clusterSecret = options.clusterSecret ?? "";
    this.logger = logger;

    this.store = new MemoryStore(options.maxStorageBytes ?? 0);
    this.gossip = new GossipProtocol(
      this.localNode,
      this.replicationFactor,
      logger,
    );

    // Wire up gossip to route application messages to us
    this.gossip.setMessageHandler((msg) => this.handleGossipMessage(msg));
  }

  // --- Lifecycle ---

  setTransport(transport: Transport): void {
    this.gossip.setTransport(transport);
  }

  setTreeManager(tree: TreeManager): void {
    this.treeManager = tree;
  }

  start(): void {
    this.gossip.start();
    this.logger.info(`[${this.localNode.id}] Cluster node started`);
  }

  stop(): void {
    // Resolve all pending writes as 202 (timeout)
    for (const [messageId, op] of this.pendingWrites) {
      clearTimeout(op.timer);
      op.resolve({ status: WRITE_STATUS_ACCEPTED });
    }
    this.pendingWrites.clear();

    this.gossip.stop();
    this.store.close();
  }

  // --- Read operations ---

  get(key: string): Buffer | null {
    return this.store.get(key);
  }

  getWithMetadata(key: string) {
    return this.store.getWithMetadata(key);
  }

  exists(key: string) {
    return this.store.exists(key);
  }

  scan(prefix?: string): string[] {
    return this.store.scan(prefix);
  }

  // --- Write operation ---

  /**
   * Store a value and replicate to enclave peers. Returns a Promise that
   * resolves with 201 (quorum reached) or 202 (timeout — stored locally,
   * replication pending).
   */
  async put(
    key: string,
    data: Buffer,
    ttlSeconds: number,
  ): Promise<WriteResult> {
    const quorumNeeded = this.quorumSize();

    const messageId = `${key}-${Date.now()}-${generateMessageID()}`;

    // Step 1: Store locally
    this.store.put(key, data, ttlSeconds);

    // Step 2: If single-node quorum, done immediately
    if (quorumNeeded <= 1) {
      this.logger.debug(
        `Write completed locally (quorum=${quorumNeeded}, confirmations=1)`,
      );
      return { status: WRITE_STATUS_CREATED };
    }

    // Step 3: Create PUT message for gossip
    const msg: Message = {
      type: "PUT",
      from: this.localNode.id,
      to: "",
      key,
      data,
      ttl: ttlSeconds,
      timestamp: new Date(),
      messageId,
    };

    // Step 4: Create quorum promise with timeout
    const writePromise = new Promise<WriteResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingWrites.delete(messageId);
        resolve({ status: WRITE_STATUS_ACCEPTED });
      }, this.writeTimeoutMs);

      this.pendingWrites.set(messageId, {
        resolve,
        confirmations: 1, // local write counts as 1
        quorumNeeded,
        timer,
      });
    });

    // Step 5: Broadcast PUT to enclave peers (async, non-blocking)
    this.logger.debug(
      `[${this.localNode.id}] Broadcasting PUT for key ${key} to enclave peers`,
    );
    this.gossip.broadcastToEnclave(msg).catch((err) => {
      this.logger.warn(
        `[${this.localNode.id}] Failed to broadcast write to enclave: ${err}`,
      );
    });

    return writePromise;
  }

  // --- Relay: substrate receives PUT from attached transient node ---

  /**
   * Handle a PUT that arrived from an attached transient node over WebSocket.
   * The substrate node acts as a relay: stores locally, fans out to the mesh,
   * forwards to other children, and records the ACK route back to the child.
   *
   * The PUT retains its original messageId but uses the substrate's ID as
   * `from` when broadcasting to the mesh — mesh peers ACK back to the
   * substrate, which forwards ACKs to the child over WS.
   */
  handleRelayPut(msg: Message, originConn: WebSocketConnection): void {
    // Dedup: skip if already processed
    if (this.gossip.markSeen(msg.messageId)) {
      this.logger.debug(
        `[${this.localNode.id}] Skipping duplicate relay PUT for key ${msg.key}`,
      );
      return;
    }

    this.logger.debug(
      `[${this.localNode.id}] Relay PUT from ${msg.from} for key ${msg.key}`,
    );

    // Step 1: Store locally (substrate is an enclave peer too)
    this.store.put(msg.key, msg.data, msg.ttl);

    // Step 2: Record ACK route for reverse-routing (#63)
    if (this.treeManager) {
      this.treeManager.recordAckRoute(
        msg.messageId,
        originConn,
        this.writeTimeoutMs,
      );
    }

    // Step 3: Send ACK to child immediately — substrate's local store counts
    const ack: Message = {
      type: "ACK",
      from: this.localNode.id,
      to: msg.from,
      key: msg.key,
      data: Buffer.alloc(0),
      ttl: 0,
      messageId: msg.messageId,
      timestamp: new Date(),
    };
    originConn.sendGossipMessage(ack);

    // Step 4: Broadcast to mesh peers (rewrite `from` so ACKs come back here)
    const meshMsg: Message = {
      ...msg,
      from: this.localNode.id,
    };
    this.gossip.broadcastToEnclave(meshMsg).catch((err) => {
      this.logger.warn(
        `[${this.localNode.id}] Failed to relay PUT to enclave: ${err}`,
      );
    });

    // Step 5: Forward to other attached children in same enclave
    if (this.treeManager) {
      for (const [childId, childConn] of this.treeManager.getChildren()) {
        if (childId !== msg.from && childConn.remoteEnclave === this.localNode.enclave) {
          childConn.sendGossipMessage(msg);
        }
      }
    }
  }

  // --- Gossip message handling ---

  /**
   * Called by GossipProtocol for application-level messages (PUT, ACK).
   * Protocol-level messages (PING, PONG, SYNC) are handled by gossip itself.
   */
  private handleGossipMessage(msg: Message): void {
    switch (msg.type) {
      case "PUT":
        this.handlePutMessage(msg);
        break;
      case "ACK":
        this.handleAckMessage(msg);
        break;
      default:
        this.logger.warn(
          `[${this.localNode.id}] Unexpected ${msg.type} message in cluster handler`,
        );
    }
  }

  private handlePutMessage(msg: Message): void {
    // Dedup: skip if already processed
    if (this.gossip.markSeen(msg.messageId)) {
      this.logger.debug(
        `[${this.localNode.id}] Skipping duplicate PUT for key ${msg.key} (msg ${msg.messageId})`,
      );
      return;
    }

    this.logger.debug(
      `[${this.localNode.id}] Received PUT for key ${msg.key} from ${msg.from}`,
    );

    // Store the replicated data
    this.store.put(msg.key, msg.data, msg.ttl);

    this.logger.debug(
      `[${this.localNode.id}] Stored replicated data for key ${msg.key}`,
    );

    // Send ACK directly to the originator
    const ack: Message = {
      type: "ACK",
      from: this.localNode.id,
      to: msg.from,
      key: msg.key,
      data: Buffer.alloc(0),
      ttl: 0,
      messageId: msg.messageId,
      timestamp: new Date(),
    };

    const peers = this.gossip.getPeers();
    const originator = peers.find((p) => p.id === msg.from);
    if (originator) {
      this.logger.debug(
        `[${this.localNode.id}] Sending ACK for key ${msg.key} to ${originator.id}`,
      );
      this.gossip.send(originator, ack).catch((err) => {
        this.logger.debug(
          `[${this.localNode.id}] Failed to send ACK to ${originator.id}: ${err}`,
        );
      });
    }

    // Continue epidemic forwarding to other enclave peers
    this.gossip.forwardToEnclave(msg).catch((err) => {
      this.logger.debug(
        `[${this.localNode.id}] Forward to enclave failed: ${err}`,
      );
    });

    // Forward to attached children in same enclave (they need the data too)
    if (this.treeManager) {
      for (const [, childConn] of this.treeManager.getChildren()) {
        if (childConn.remoteEnclave === this.localNode.enclave) {
          childConn.sendGossipMessage(msg);
        }
      }
    }
  }

  private handleAckMessage(msg: Message): void {
    // Check if this ACK should be relayed to an attached transient node (#63)
    if (this.treeManager) {
      const routeConn = this.treeManager.getAckRoute(msg.messageId);
      if (routeConn && !routeConn.isClosed) {
        this.logger.debug(
          `[${this.localNode.id}] Relaying ACK for ${msg.messageId} to attached child`,
        );
        routeConn.sendGossipMessage(msg);
        // Don't return — more ACKs may arrive from other mesh peers
        // and the route auto-cleans via timeout
        return;
      }
    }

    // Normal local handling
    const writeOp = this.pendingWrites.get(msg.messageId);
    if (!writeOp) return; // already resolved or unknown

    writeOp.confirmations++;

    if (writeOp.confirmations >= writeOp.quorumNeeded) {
      clearTimeout(writeOp.timer);
      this.pendingWrites.delete(msg.messageId);
      writeOp.resolve({ status: WRITE_STATUS_CREATED });
    }
  }

  // --- Quorum ---

  /**
   * Dynamic quorum: floor(min(enclaveNodes, replicationFactor) / 2) + 1
   * where enclaveNodes includes the local node.
   */
  quorumSize(): number {
    const enclaveNodes = this.gossip.getReplicationPeers().length + 1; // +1 for self
    const effective = Math.min(enclaveNodes, this.replicationFactor);
    const quorum = Math.floor(effective / 2) + 1;
    return Math.max(quorum, 1);
  }

  // --- Accessors ---

  getClusterSecret(): string {
    return this.clusterSecret;
  }

  getEnclave(): string {
    return this.localNode.enclave;
  }

  topology(): NodeInfo[] {
    return this.gossip.getPeers();
  }

  pendingWriteCount(): number {
    return this.pendingWrites.size;
  }
}
