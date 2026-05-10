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

/** Default maximum number of transient node attachments. */
export const DEFAULT_MAX_CHILDREN = 100;

/** Initial backoff before retrying a failed reattach cycle. */
export const REATTACH_BACKOFF_INITIAL_MS = 5_000;

/** Cap on exponential backoff between full reattach cycles. */
export const REATTACH_BACKOFF_MAX_MS = 60_000;

/**
 * Per-attempt connect timeout for cached-topology alternatives. Shorter
 * than seed-list timeout because cached entries are speculative — they
 * may have left the substrate since the cache was taken (#108).
 */
export const CACHED_ALT_CONNECT_TIMEOUT_MS = 5_000;

/** Per-attempt connect timeout for fresh seed-list alternatives. */
export const SEED_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Total deadline for the cached-topology layer of a single reattach cycle.
 * Without this cap, a stale cache with N entries could waste
 * N × CACHED_ALT_CONNECT_TIMEOUT_MS before falling through to fresh seeds.
 */
export const CACHED_LAYER_DEADLINE_MS = 30_000;

/** Alternative-parent shape used for reattach (matches goodbye payload). */
export interface AlternativeParent {
  id: string;
  address: string;
  http_port: number;
  enclave?: string;
}

// --- Types ---

export type NodeRole = "substrate" | "transient";
export type InboundCapability = "true" | "false";

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

  /**
   * Snapshot of the substrate's topology captured from welcome at attach
   * time. Used as the cached-alternatives layer for ungraceful-disconnect
   * reattach (#108). Stale by definition — entries may have left the
   * cluster since attach — so per-attempt and total-layer timeouts are
   * shorter than the seed-list layer. Refreshing this during attach is
   * out of scope and tracked by #67/#68.
   */
  private lastKnownAlternatives: AlternativeParent[] = [];

  /**
   * Returns the current bootstrap seed list (host:http-port). Used as
   * the freshest reattach fallback when cached alternatives are exhausted.
   * Wired in index.ts; mirrors the seedProvider pattern in ClusterNode (#85).
   */
  private seedProvider: (() => string[]) | null = null;

  /** Set in stop(); causes the reattach loop and any sleeps to exit. */
  private stopping = false;

  /**
   * Resolves when stop() is called. The reattach loop's backoff sleep
   * races against this so a shutdown wakes it within milliseconds rather
   * than waiting up to a full backoff interval. setTimeout naturally fires
   * if shutdown doesn't intervene.
   */
  private stopSignal: Promise<void>;
  private resolveStopSignal!: () => void;

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
    this.stopSignal = new Promise<void>((resolve) => {
      this.resolveStopSignal = resolve;
    });

    // Resolve role from config: true = substrate, false = transient
    if (options.inbound === "true") {
      this.resolvedRole = "substrate";
      this.inboundCapable = true;
    } else {
      this.resolvedRole = "transient";
      this.inboundCapable = false;
    }
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

  /**
   * Wire the seed-list provider used as the freshest reattach fallback.
   * For public-network deployments this typically closes over the omega
   * refresher's currentList; for private it snapshots REPRAM_PEERS.
   * Null disables the seed-list layer (#108).
   */
  setSeedProvider(fn: (() => string[]) | null): void {
    this.seedProvider = fn;
  }

  // --- Server-side: handle incoming attachments ---

  /**
   * Handle a new WebSocket connection that sent a hello message.
   * Validates the attachment and sends a welcome response.
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
        `children: ${this.children.size})`,
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

    // Snapshot the substrate's topology as cached reattach alternatives.
    // Excludes self. Stale by definition; deadline + per-attempt-timeout
    // bound the cost of trying ghosts before falling through to seeds (#108).
    this.lastKnownAlternatives = [];
    for (const sync of welcome.topology) {
      const info = sync.node_info;
      if (!info || info.id === this.localNode.id) continue;
      this.lastKnownAlternatives.push({
        id: info.id,
        address: info.address,
        http_port: info.http_port,
        enclave: info.enclave,
      });
    }

    // Handle goodbye from parent (graceful shutdown → proactive migration).
    // Identity-aware: only fires reattach if this conn is still our parent
    // (a stale handler from a previous attach must not clobber a successful
    // reattach to a new parent).
    conn.on("attachment", (msg: AttachmentMessage) => {
      if (msg.type === "goodbye") {
        if (this.parentConnection !== conn) return;
        const payload = msg.payload as GoodbyePayload;
        this.logger.info(
          `Substrate node sent goodbye: ${payload.reason} ` +
            `(${payload.alternative_parents.length} alternatives)`,
        );
        this.parentConnection = null;
        void this.triggerReattach(payload.alternative_parents);
      }
    });

    // Handle parent disconnection (graceful close after goodbye, or
    // ungraceful TCP drop / crash / NAT rebind). The `!== conn` guard
    // catches two cases:
    //   1. Stale handler: this conn was replaced by a successful reattach
    //      to a new parent — parentConnection now points at the new conn.
    //   2. Post-goodbye close: the goodbye handler already nulled
    //      parentConnection, so `null !== conn` short-circuits triggering
    //      a duplicate reattach (the single-flight flag would block it
    //      anyway, but this avoids the spurious entry).
    // For ungraceful disconnects there are no fresh goodbye-supplied
    // alternatives, so triggerReattach falls through to cached topology
    // and then the seed list (#108).
    conn.on("close", () => {
      if (this.parentConnection !== conn) return;
      this.logger.warn(
        `Substrate attachment to ${conn.remoteNodeId ?? "unknown"} lost`,
      );
      this.parentConnection = null;
      void this.triggerReattach(undefined);
    });

    this.logger.info(
      `Attached to substrate node ${welcome.your_position.parent_id} ` +
        `(depth: ${welcome.your_position.depth}, ` +
        `topology: ${welcome.topology.length} nodes)`,
    );

    return welcome;
  }

  // --- Reattachment ---

  /**
   * Entry point for reattach. Single-flight via the `reattaching` flag —
   * concurrent calls (e.g., goodbye handler and close handler firing
   * back-to-back) collapse to one running loop. Pass goodbye-supplied
   * alternatives if available; pass undefined for ungraceful disconnect
   * (the loop will use cached topology and the seed list).
   *
   * Fire-and-forget — the transient node continues serving local reads
   * while reattach is in progress (#108).
   */
  private async triggerReattach(
    suppliedAlternatives: AlternativeParent[] | undefined,
  ): Promise<void> {
    if (this.reattaching || this.stopping) return;
    this.reattaching = true;
    try {
      await this.reattachLoop(suppliedAlternatives);
    } finally {
      this.reattaching = false;
    }
  }

  /**
   * Full reattach loop with three layers, exponential backoff, and
   * stop-aware sleeps. Runs until success or stop() (#108):
   *
   *   1. Goodbye payload alternatives (if any) — freshest, single-shot.
   *   2. Cached `welcome.topology` from attach time — local, fast,
   *      possibly stale. Bounded by per-attempt timeout AND total layer
   *      deadline so a fully-stale cache can't waste minutes before
   *      falling through.
   *   3. Seed list from seedProvider — slowest but guaranteed-fresh.
   *
   * Between full cycles, sleeps with exponential backoff capped at
   * REATTACH_BACKOFF_MAX_MS. Backoff resets implicitly on success
   * (the loop returns).
   */
  private async reattachLoop(
    suppliedAlternatives: AlternativeParent[] | undefined,
  ): Promise<void> {
    let backoffMs = REATTACH_BACKOFF_INITIAL_MS;

    while (!this.stopping) {
      // Layer 1: supplied alternatives (goodbye payload). Used once on
      // the first iteration if present; subsequent iterations skip this
      // layer because the goodbye payload is no fresher than the cached
      // topology by then.
      if (suppliedAlternatives && suppliedAlternatives.length > 0) {
        if (await this.tryAlternatives(suppliedAlternatives, SEED_CONNECT_TIMEOUT_MS, undefined)) {
          return;
        }
        suppliedAlternatives = undefined;
      }

      // Layer 2: cached welcome topology. Per-attempt 5s, layer total 30s.
      if (this.lastKnownAlternatives.length > 0) {
        const deadline = Date.now() + CACHED_LAYER_DEADLINE_MS;
        if (await this.tryAlternatives(this.lastKnownAlternatives, CACHED_ALT_CONNECT_TIMEOUT_MS, deadline)) {
          return;
        }
      }

      // Layer 3: seed list. Per-attempt 10s; small N (typically 2-5).
      const seeds = this.seedProvider?.() ?? [];
      const seedAlts: AlternativeParent[] = [];
      for (const seed of seeds) {
        const parsed = this.parseSeedAddress(seed);
        if (parsed !== null) seedAlts.push(parsed);
      }
      if (seedAlts.length > 0) {
        if (await this.tryAlternatives(seedAlts, SEED_CONNECT_TIMEOUT_MS, undefined)) {
          return;
        }
      }

      this.logger.warn(
        `All reattach paths failed — sleeping ${backoffMs}ms before retry ` +
          "(local store still serves reads; quorum writes degraded until reattach)",
      );
      await this.sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, REATTACH_BACKOFF_MAX_MS);
    }
  }

  /**
   * Walk a list of alternative substrates, attempting WebSocket attach
   * to each. Returns true on the first success. Honors stopping flag and
   * an optional layer deadline for the cached-topology case.
   */
  private async tryAlternatives(
    alts: AlternativeParent[],
    perAttemptTimeoutMs: number,
    deadlineMs: number | undefined,
  ): Promise<boolean> {
    for (const alt of alts) {
      if (this.stopping) return false;
      if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
        this.logger.warn(
          "Cached-alternatives layer hit deadline; falling through to seed list",
        );
        return false;
      }

      // Skip self — seed-list layer uses synthetic IDs so the ID filter
      // in welcome-topology population doesn't catch it. Address+port is
      // the reliable self-check across all layers (#120). Literal match
      // only — loopback aliases (0.0.0.0 vs 127.0.0.1) are not normalized;
      // config.address is always the routable IP in practice.
      if (alt.address === this.localNode.address && alt.http_port === this.localNode.httpPort) {
        continue;
      }

      this.logger.info(
        `Attempting reattachment to ${alt.id} (${alt.address}:${alt.http_port})`,
      );
      try {
        const conn = await connectToSubstrate(
          alt.address,
          alt.http_port,
          this.options.clusterSecret,
          this.logger,
          perAttemptTimeoutMs,
        );
        const welcome = await this.attach(conn);
        if (welcome) {
          // Race guard: the conn could have dropped between welcome
          // receipt and now. If its close handler already fired, it
          // tried to triggerReattach but was blocked by the single-flight
          // `reattaching` flag (we hold it). Returning true here would
          // mark the cycle a success and exit the outer loop, leaving
          // the node parentless with no further retry. Detect via
          // identity + isClosed and treat as a per-alternative failure
          // so the outer loop continues.
          if (this.parentConnection !== conn || conn.isClosed) {
            this.logger.warn(
              `Reattachment to ${alt.id} dropped before activation; trying next`,
            );
            continue;
          }
          this.logger.info(`Reattached to ${alt.id} — gossip resumed`);
          this.onReattachCallback?.(conn);
          conn.startHeartbeat();
          return true;
        }
        if (!conn.isClosed) conn.close();
      } catch (err) {
        this.logger.warn(`Reattachment to ${alt.id} failed: ${err}`);
      }
    }
    return false;
  }

  /**
   * Parse a seed string of the form "host:http-port" into an
   * AlternativeParent. Returns null on malformed input. The id is a
   * synthetic label since seeds carry no node identity until attach.
   */
  private parseSeedAddress(seed: string): AlternativeParent | null {
    const idx = seed.lastIndexOf(":");
    if (idx <= 0 || idx === seed.length - 1) return null;
    const address = seed.slice(0, idx);
    const portStr = seed.slice(idx + 1);
    const http_port = parseInt(portStr, 10);
    if (isNaN(http_port) || http_port <= 0 || http_port > 65535) return null;
    return { id: `seed-${seed}`, address, http_port };
  }

  /**
   * Sleep for ms or until stop() is called, whichever comes first. Races
   * a setTimeout against stopSignal so a shutdown wakes the reattach
   * loop within milliseconds rather than at end-of-backoff.
   */
  private sleep(ms: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return Promise.race([
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
      this.stopSignal,
    ]);
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
   * Clean shutdown: send goodbyes, clear state, cancel any in-flight
   * reattach loop and pending backoff sleeps.
   */
  stop(): void {
    // Set stopping first so any close handlers that fire during teardown
    // (when we close the parent below) short-circuit at triggerReattach.
    this.stopping = true;

    // Wake any sleeping backoff in the reattach loop so it observes
    // stopping and exits promptly. setTimeout still fires later but its
    // resolved promise is now harmless — the loop is gone.
    this.resolveStopSignal();

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
