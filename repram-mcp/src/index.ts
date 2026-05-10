#!/usr/bin/env node

/**
 * repram-mcp — unified REPRAM node + MCP server.
 *
 * Modes:
 *  - MCP (default): starts embedded REPRAM node + MCP stdio transport
 *  - MCP + external: set REPRAM_URL to connect to existing node via HTTP
 *  - Standalone: REPRAM_MODE=standalone or --standalone flag — HTTP server only, no MCP
 */

import { RepramClient, InProcessClient, type RepramClientInterface } from "./client.js";
import { HTTPServer, loadConfig, type ServerConfig } from "./node/server.js";
import { HTTPTransport } from "./node/transport.js";
import { Logger } from "./node/logger.js";
import { bootstrapFromPeers, resolveOmegaBootstrap } from "./node/bootstrap.js";
import { publicKeyFromBase64, SignedList } from "./node/trust/signed-list.js";
import { OMEGA_PUBKEY } from "./node/trust/omega.js";
import { Refresher } from "./node/trust/refresher.js";
import { resolveCacheDir } from "./node/trust/cache.js";
import { connectToSubstrate, type WebSocketConnection } from "./node/ws-transport.js";
import { enableProcessMetrics, gossipMetrics, setOmegaLastRefreshNow } from "./node/metrics.js";

const isStandalone =
  process.env.REPRAM_MODE === "standalone" ||
  process.argv.includes("--standalone");

let embeddedServer: HTTPServer | null = null;

// ─── Bootstrap ──────────────────────────────────────────────────────

async function bootstrap(server: HTTPServer, config: ServerConfig, logger: Logger): Promise<void> {
  // Resolve seed peers: REPRAM_PEERS env var first, then the omega signed
  // root list for the public network. Private networks never consult DNS.
  const seedPeers: string[] = [];

  const peersEnv = process.env.REPRAM_PEERS;
  if (peersEnv) {
    seedPeers.push(...peersEnv.split(",").map((p) => p.trim()).filter(Boolean));
  }

  let rootList: SignedList | null = null;
  if (config.network === "public" && seedPeers.length === 0) {
    rootList = await resolveOmegaBootstrap(logger);
    seedPeers.push(...rootList.nodes);
  } else if (config.network === "public" && seedPeers.length > 0) {
    // REPRAM_PEERS short-circuits omega resolution, which in turn leaves
    // isRoot() false and causes /v1/bootstrap to 403. Fine for local
    // testing; wrong for a real public-network root node.
    logger.warn(
      "REPRAM_NETWORK=public with REPRAM_PEERS set: skipping omega verification. " +
        "This node will not be recognized as a bootstrap root and will return 403 " +
        "for /v1/bootstrap requests.",
    );
  }

  // Self-recognition + refresh loop. Only public-network deployments with
  // a verified signed list participate.
  if (rootList) {
    const applyRootStatus = (list: SignedList) => {
      setOmegaLastRefreshNow();
      const selfAdvertised = `${config.address}:${config.httpPort}`;
      const wasRoot = server.clusterNode.isRoot();
      const isRoot = list.nodes.includes(selfAdvertised);
      server.clusterNode.setRoot(isRoot);
      if (isRoot !== wasRoot) {
        logger.info(
          isRoot
            ? "Root status changed: this node is now a bootstrap root"
            : "Root status changed: this node is no longer a bootstrap root",
        );
      }
    };
    applyRootStatus(rootList);
    const selfAdvertised = `${config.address}:${config.httpPort}`;
    if (server.clusterNode.isRoot()) {
      logger.info(`Initial root status: bootstrap root (advertised as ${selfAdvertised})`);
    } else {
      logger.info(
        `Initial root status: not a root (advertised as ${selfAdvertised}); /v1/bootstrap returns 403`,
      );
    }

    const { dir: cacheDir, usedLastResort } = resolveCacheDir();
    if (usedLastResort) {
      logger.warn(
        `Using ${cacheDir} as cache directory; this typically requires root write access. ` +
          "Set REPRAM_CACHE_DIR for a writable location if refresh writes start failing.",
      );
    }
    const refresher = new Refresher(
      {
        pubKey: publicKeyFromBase64(OMEGA_PUBKEY),
        cacheDir,
        onUpdate: applyRootStatus,
        onError: (err) => logger.warn(`Omega refresh: ${err}`),
      },
      rootList,
    );
    void refresher.run();

    // Public network: re-bootstrap pulls from the refresher's current
    // signed list, so a node that fully isolates picks up whatever
    // roots are live now, not whatever it started with (#85, F5).
    server.clusterNode.setRebootstrapFn(async () => {
      const list = refresher.currentList;
      if (list.nodes.length === 0) return [];
      return await bootstrapFromPeers(
        list.nodes,
        server.clusterNode.localNode,
        config.clusterSecret,
        logger,
      );
    });

    // Same source for the WS reattach loop: when a transient loses its
    // parent ungracefully and exhausts cached alternatives, fresh roots
    // come from the omega refresher's current list (#108).
    server.treeManager.setSeedProvider(() => refresher.currentList.nodes);
  } else if (seedPeers.length > 0) {
    // Private / REPRAM_PEERS: re-bootstrap reuses the static seed list
    // captured at startup. Operators who rotate seeds at runtime (e.g.,
    // replacing a decommissioned seed) need to restart the node — there
    // is no SIGHUP-style reload path today (#85, F5).
    const seedSnapshot = [...seedPeers];
    server.clusterNode.setRebootstrapFn(async () => {
      return await bootstrapFromPeers(
        seedSnapshot,
        server.clusterNode.localNode,
        config.clusterSecret,
        logger,
      );
    });

    // Same snapshot for the WS reattach loop (#108).
    server.treeManager.setSeedProvider(() => seedSnapshot);
  }

  if (seedPeers.length === 0) return;

  logger.info(`Bootstrapping from ${seedPeers.length} seed nodes`);

  const discovered = await bootstrapFromPeers(
    seedPeers,
    server.clusterNode.localNode,
    config.clusterSecret,
    logger,
  );

  for (const peer of discovered) {
    server.clusterNode.gossip.addPeer(peer);
  }

  // Substrate nodes stay in flat mesh — no WS attachment needed
  if (config.inbound === "true") return;

  // Transient nodes attach to substrate via WebSocket
  await attachToSubstrate(server, config, seedPeers, logger);
}

/**
 * After HTTP bootstrap, transient nodes open a persistent WebSocket
 * attachment to a substrate node. Gossip flows over this connection.
 * Falls back to HTTP-only if the bootstrap node doesn't support WS.
 */
async function attachToSubstrate(
  server: HTTPServer,
  config: ServerConfig,
  seedPeers: string[],
  logger: Logger,
): Promise<void> {
  // Same self-skip as bootstrapFromPeers (#87): the seed list may include
  // this node's own address (e.g., omega root list). Attaching to self
  // makes the node both substrate and transient for itself, routing all
  // PUTs through the self-WS connection instead of broadcasting (#120).
  const selfAdvertised = `${config.address}:${config.httpPort}`;

  // Try each seed peer for WS attachment
  for (const seed of seedPeers) {
    if (seed === selfAdvertised) {
      logger.debug(`Skipping self in WS attachment candidates (${seed})`);
      continue;
    }

    const [address, portStr] = seed.split(":");
    const port = parseInt(portStr, 10);
    if (!address || isNaN(port)) continue;

    try {
      logger.info(`Attempting WebSocket attachment to ${seed}`);
      const conn = await connectToSubstrate(
        address,
        port,
        config.clusterSecret,
        logger,
        10_000,
      );

      // Hello/welcome handshake
      const welcome = await server.treeManager.attach(conn);
      if (welcome) {
        logger.info(`WebSocket attachment established — transient node active`);

        // Route incoming gossip from substrate through cluster
        setupParentRouting(server, conn);
        conn.startHeartbeat();

        // Set up reattach callback for goodbye-triggered migration
        server.treeManager.setReattachCallback((newConn) => {
          setupParentRouting(server, newConn);
        });

        return; // attached successfully
      }

      // Welcome failed — close and try next
      conn.close();
    } catch (err) {
      logger.warn(
        `WebSocket attachment to ${seed} failed: ${err}` +
          ` — trying next seed`,
      );
    }
  }

  logger.warn(
    "No bootstrap node supports WebSocket — NAT traversal unavailable. " +
      "Operating with HTTP-only gossip (degraded for NAT-bound nodes).",
  );
}

/**
 * Wire up message routing on a parent (substrate) WebSocket connection.
 * Incoming gossip messages from the parent flow through the cluster node.
 */
function setupParentRouting(server: HTTPServer, conn: WebSocketConnection): void {
  conn.on("message", (msg) => {
    server.clusterNode.gossip.handleMessage(msg);
  });
}

// ─── Standalone mode (HTTP server only, no MCP) ─────────────────────

async function runStandalone(): Promise<void> {
  const config = loadConfig(false); // standalone defaults
  const logger = new Logger(config.logLevel);

  enableProcessMetrics();
  embeddedServer = new HTTPServer(config, logger);
  embeddedServer.clusterNode.gossip.enableMetrics(gossipMetrics);

  const transport = new HTTPTransport(
    embeddedServer.clusterNode.localNode,
    config.clusterSecret,
    logger,
  );
  embeddedServer.setTransport(transport);

  await embeddedServer.start();
  await bootstrap(embeddedServer, config, logger);
}

// ─── MCP mode (embedded node + MCP stdio) ───────────────────────────

async function runMCP(): Promise<void> {
  // Lazy import MCP deps — not needed in standalone mode
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { z } = await import("zod");
  const { toolDefinitions, handleToolCall } = await import("./tools.js");

  let client: RepramClientInterface;

  if (process.env.REPRAM_URL) {
    // External node — backwards compatible
    client = new RepramClient(process.env.REPRAM_URL);
  } else {
    // Embedded node with conservative defaults
    const config = loadConfig(true); // embedded defaults: port 0, 50MB, warn
    const logger = new Logger(config.logLevel);

    embeddedServer = new HTTPServer(config, logger);

    const transport = new HTTPTransport(
      embeddedServer.clusterNode.localNode,
      config.clusterSecret,
      logger,
    );
    embeddedServer.setTransport(transport);

    await embeddedServer.start();
    await bootstrap(embeddedServer, config, logger);

    client = new InProcessClient(embeddedServer.clusterNode);
  }

  const mcpServer = new McpServer({
    name: "repram-mcp",
    version: "2.1.0",
  });

  // Register repram_store
  mcpServer.tool(
    "repram_store",
    toolDefinitions.find((t) => t.name === "repram_store")!.description,
    {
      data: z.string().describe("The data to store."),
      ttl_seconds: z
        .number()
        .optional()
        .describe("Time-to-live in seconds (300-86400, default 3600)."),
      key: z
        .string()
        .optional()
        .describe("Optional custom key. If omitted, a UUID v4 is generated."),
    },
    async (args) => {
      const result = await handleToolCall(client, "repram_store", args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Register repram_retrieve
  mcpServer.tool(
    "repram_retrieve",
    toolDefinitions.find((t) => t.name === "repram_retrieve")!.description,
    {
      key: z.string().describe("The key to retrieve."),
    },
    async (args) => {
      const result = await handleToolCall(client, "repram_retrieve", args);
      return {
        content: [
          {
            type: "text" as const,
            text: result === null ? "null — key not found or expired" : JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // Register repram_exists
  mcpServer.tool(
    "repram_exists",
    toolDefinitions.find((t) => t.name === "repram_exists")!.description,
    {
      key: z.string().describe("The key to check."),
    },
    async (args) => {
      const result = await handleToolCall(client, "repram_exists", args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Register repram_list_keys
  mcpServer.tool(
    "repram_list_keys",
    toolDefinitions.find((t) => t.name === "repram_list_keys")!.description,
    {
      prefix: z
        .string()
        .optional()
        .describe("Optional prefix filter for key namespacing."),
    },
    async (args) => {
      const result = await handleToolCall(client, "repram_list_keys", args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  const mcpTransport = new StdioServerTransport();
  await mcpServer.connect(mcpTransport);
}

// ─── Graceful shutdown ───────────────────────────────────────────────

async function shutdown(): Promise<void> {
  if (embeddedServer) await embeddedServer.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ─── Entry point ─────────────────────────────────────────────────────

const entrypoint = isStandalone ? runStandalone : runMCP;
entrypoint().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
