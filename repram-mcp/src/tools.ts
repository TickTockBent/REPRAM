import { v4 as uuidv4 } from "uuid";
import { RepramClient } from "./client.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "repram_store",
    description: `Store ephemeral data in the REPRAM network. Data is replicated across nodes and automatically expires after the specified TTL. Use this for temporary coordination data, handoff payloads, scratchpad state, or any data that should not persist.

A unique key is generated automatically (UUID v4). You will receive the key in the response — save it or share it with other agents who need to retrieve this data.

All data on REPRAM is ephemeral. There is no way to extend a TTL or recover expired data. If you need the data to last longer, store it again with a new TTL before expiration.`,
    inputSchema: {
      type: "object",
      properties: {
        data: {
          type: "string",
          description: "The data to store. Can be any string — plain text, JSON, base64-encoded binary, etc.",
        },
        ttl_seconds: {
          type: "number",
          description:
            "Time-to-live in seconds. The data will be automatically deleted after this duration. Minimum 300 (5 minutes), maximum 86400 (24 hours). Default: 3600 (1 hour).",
        },
        key: {
          type: "string",
          description:
            "Optional custom key. If omitted, a UUID v4 key is generated automatically. Use a custom key when you need a predictable rendezvous point with another agent.",
        },
      },
      required: ["data"],
    },
  },
  {
    name: "repram_retrieve",
    description: `Retrieve ephemeral data from the REPRAM network by key. Returns the stored data along with TTL metadata.

Returns null if the key does not exist or has expired. Expired data is permanently gone — this is by design. Do not treat a null response as an error; it is the normal lifecycle of ephemeral data.`,
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "The key to retrieve. This is the key returned by repram_store or shared by another agent.",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "repram_list_keys",
    description: `List keys currently stored in the REPRAM network. Optionally filter by prefix.

Use this to discover what data is available, check if a coordination key exists, or enumerate keys in a namespace. Keys for expired data will not appear.`,
    inputSchema: {
      type: "object",
      properties: {
        prefix: {
          type: "string",
          description:
            "Optional prefix filter. Only keys starting with this string will be returned. Useful for namespacing (e.g., 'project-x/' to list all keys in that namespace).",
        },
      },
    },
  },
];

export async function handleToolCall(
  client: RepramClient,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (toolName) {
    case "repram_store": {
      const data = args.data as string;
      const ttlSeconds = (args.ttl_seconds as number) ?? 3600;
      const key = (args.key as string) ?? uuidv4();

      const result = await client.store(key, data, ttlSeconds);

      if (result.status !== 201) {
        return {
          error: `Store failed with status ${result.status}: ${result.statusText}`,
        };
      }

      const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

      return {
        key,
        ttl_seconds: ttlSeconds,
        expires_at: expiresAt,
      };
    }

    case "repram_retrieve": {
      const key = args.key as string;
      const result = await client.retrieve(key);

      if (result === null) {
        return null;
      }

      const expiresAt = new Date(
        Date.now() + result.remainingTtlSeconds * 1000
      ).toISOString();

      return {
        data: result.data,
        created_at: result.createdAt,
        remaining_ttl_seconds: result.remainingTtlSeconds,
        expires_at: expiresAt,
      };
    }

    case "repram_list_keys": {
      const prefix = args.prefix as string | undefined;
      const result = await client.listKeys(prefix);
      return { keys: result.keys };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
