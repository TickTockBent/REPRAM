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
import { bootstrapFromPeers, resolveBootstrapDNS } from "./node/bootstrap.js";
import { connectToSubstrate } from "./node/ws-transport.js";

const isStandalone =
  process.env.REPRAM_MODE === "standalone" ||
  process.argv.includes("--standalone");

let embeddedServer: HTTPServer | null = null;

// ─── Bootstrap ──────────────────────────────────────────────────────

async function bootstrap(server: HTTPServer, config: ServerConfig, logger: Logger): Promise<void> {
  // Resolve seed peers: REPRAM_PEERS env var, then DNS for public network
  const seedPeers: string[] = [];

  const peersEnv = process.env.REPRAM_PEERS;
  if (peersEnv) {
    seedPeers.push(...peersEnv.split(",").map((p) => p.trim()).filter(Boolean));
  }

  // DNS-based bootstrap for public network (when no manual peers)
  if (config.network === "public" && seedPeers.length === 0) {
    const dnsResolved = await resolveBootstrapDNS(
      "bootstrap.repram.network",
      9090,
      logger,
    );
    seedPeers.push(...dnsResolved);
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

  // Transient nodes (or auto-detect) attach to substrate via WebSocket
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
  // Try each seed peer for WS attachment
  for (const seed of seedPeers) {
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
        conn.on("message", (msg) => {
          server.clusterNode.gossip.handleMessage(msg);
        });

        conn.startHeartbeat();
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

// ─── Standalone mode (HTTP server only, no MCP) ─────────────────────

async function runStandalone(): Promise<void> {
  const config = loadConfig(false); // standalone defaults
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
    version: "2.0.0",
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
