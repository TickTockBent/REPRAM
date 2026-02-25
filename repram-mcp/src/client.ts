/**
 * REPRAM client — HTTP and in-process implementations.
 */

import type { ClusterNode } from "./node/cluster.js";

export interface StoreResult {
  status: number;
  statusText: string;
}

export interface RetrieveResult {
  data: string;
  createdAt: string;
  remainingTtlSeconds: number;
  originalTtlSeconds: number;
}

export interface ExistsResult {
  exists: boolean;
  remainingTtlSeconds: number;
}

export interface ListKeysResult {
  keys: string[];
}

/** Shared interface — both RepramClient (HTTP) and InProcessClient implement this. */
export interface RepramClientInterface {
  store(key: string, data: string, ttlSeconds: number): Promise<StoreResult>;
  retrieve(key: string): Promise<RetrieveResult | null>;
  exists(key: string): Promise<ExistsResult>;
  listKeys(prefix?: string): Promise<ListKeysResult>;
}

/**
 * In-process client — calls ClusterNode directly, no HTTP overhead.
 * Used when running as an embedded node (no REPRAM_URL configured).
 */
export class InProcessClient implements RepramClientInterface {
  private node: ClusterNode;

  constructor(node: ClusterNode) {
    this.node = node;
  }

  async store(key: string, data: string, ttlSeconds: number): Promise<StoreResult> {
    const result = await this.node.put(key, Buffer.from(data), ttlSeconds);
    return {
      status: result.status,
      statusText: result.status === 201 ? "Created" : "Accepted",
    };
  }

  async retrieve(key: string): Promise<RetrieveResult | null> {
    const entry = this.node.getWithMetadata(key);
    if (!entry) return null;

    const remainingMs = entry.expiresAt - Date.now();
    return {
      data: entry.data.toString(),
      createdAt: new Date(entry.createdAt).toISOString(),
      remainingTtlSeconds: Math.max(0, Math.floor(remainingMs / 1000)),
      originalTtlSeconds: entry.ttlSeconds,
    };
  }

  async exists(key: string): Promise<ExistsResult> {
    return this.node.exists(key);
  }

  async listKeys(prefix?: string): Promise<ListKeysResult> {
    const keys = this.node.scan(prefix);
    return { keys };
  }
}

/** HTTP client — connects to an external REPRAM node. */
export class RepramClient implements RepramClientInterface {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? process.env.REPRAM_URL ?? "http://localhost:8080").replace(
      /\/$/,
      ""
    );
  }

  async store(key: string, data: string, ttlSeconds: number): Promise<StoreResult> {
    const response = await fetch(`${this.baseUrl}/v1/data/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: {
        "X-TTL": String(ttlSeconds),
        "Content-Type": "application/octet-stream",
      },
      body: data,
    });

    return {
      status: response.status,
      statusText: response.statusText,
    };
  }

  async retrieve(key: string): Promise<RetrieveResult | null> {
    const response = await fetch(`${this.baseUrl}/v1/data/${encodeURIComponent(key)}`);

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`REPRAM retrieve failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.text();
    const createdAt = response.headers.get("X-Created-At") ?? "";
    const remainingTtlSeconds = parseInt(response.headers.get("X-Remaining-TTL") ?? "0", 10);
    const originalTtlSeconds = parseInt(response.headers.get("X-Original-TTL") ?? "0", 10);

    return {
      data,
      createdAt,
      remainingTtlSeconds,
      originalTtlSeconds,
    };
  }

  async exists(key: string): Promise<ExistsResult> {
    const response = await fetch(`${this.baseUrl}/v1/data/${encodeURIComponent(key)}`, {
      method: "HEAD",
    });

    if (response.status === 404) {
      return { exists: false, remainingTtlSeconds: 0 };
    }

    if (!response.ok) {
      throw new Error(`REPRAM exists check failed: ${response.status} ${response.statusText}`);
    }

    const remainingTtlSeconds = parseInt(response.headers.get("X-Remaining-TTL") ?? "0", 10);
    return { exists: true, remainingTtlSeconds };
  }

  async listKeys(prefix?: string): Promise<ListKeysResult> {
    const url = new URL(`${this.baseUrl}/v1/keys`);
    if (prefix) {
      url.searchParams.set("prefix", prefix);
    }

    const response = await fetch(url.toString());

    if (!response.ok) {
      throw new Error(`REPRAM list keys failed: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as { keys: string[] | null };
    return { keys: body.keys ?? [] };
  }
}
