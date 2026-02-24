#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RepramClient } from "./client.js";
import { toolDefinitions, handleToolCall } from "./tools.js";
import { z } from "zod";

const client = new RepramClient(process.env.REPRAM_URL);

const server = new McpServer({
  name: "repram-mcp",
  version: "1.0.0",
});

// Register repram_store
server.tool(
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
server.tool(
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

// Register repram_list_keys
server.tool(
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
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
