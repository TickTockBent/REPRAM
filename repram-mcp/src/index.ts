#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RepramClient, InProcessClient, type RepramClientInterface } from "./client.js";
import { toolDefinitions, handleToolCall } from "./tools.js";
import { z } from "zod";
import { HTTPServer, loadConfig } from "./node/server.js";
import { HTTPTransport } from "./node/transport.js";
import { Logger } from "./node/logger.js";

let client: RepramClientInterface;
let embeddedServer: HTTPServer | null = null;

async function createClient(): Promise<RepramClientInterface> {
  // If REPRAM_URL is set, connect to an external node (backwards compatible)
  if (process.env.REPRAM_URL) {
    return new RepramClient(process.env.REPRAM_URL);
  }

  // Otherwise, start an embedded REPRAM node
  const config = loadConfig();
  const logger = new Logger(config.logLevel);

  embeddedServer = new HTTPServer(config, logger);

  // Set up gossip transport
  const transport = new HTTPTransport(
    embeddedServer.clusterNode.localNode,
    config.clusterSecret,
    logger,
  );
  embeddedServer.setTransport(transport);

  await embeddedServer.start();

  return new InProcessClient(embeddedServer.clusterNode);
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

async function main() {
  client = await createClient();

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  if (embeddedServer) await embeddedServer.stop();
  process.exit(0);
});

process.on("SIGINT", async () => {
  if (embeddedServer) await embeddedServer.stop();
  process.exit(0);
});

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
