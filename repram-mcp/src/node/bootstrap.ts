/**
 * Bootstrap — DNS resolution and cluster join handshake.
 *
 * Port of internal/gossip/bootstrap.go and resolveBootstrapDNS from cmd/repram/main.go.
 */

import * as dns from "node:dns/promises";
import { signBody } from "./auth.js";
import type { Logger } from "./logger.js";
import type { NodeInfo } from "./types.js";

export interface DnsResolver {
  resolveSrv(hostname: string): Promise<{ name: string; port: number }[]>;
  resolve4(hostname: string): Promise<string[]>;
}

const defaultResolver: DnsResolver = {
  resolveSrv: (hostname) => dns.resolveSrv(hostname),
  resolve4: (hostname) => dns.resolve4(hostname),
};

// --- Wire format for bootstrap handshake ---

export interface BootstrapRequest {
  node_id: string;
  address: string;
  gossip_port: number;
  http_port: number;
  enclave?: string;
}

export interface BootstrapResponse {
  success: boolean;
  peers: WireBootstrapPeer[];
}

interface WireBootstrapPeer {
  id: string;
  address: string;
  port: number;       // gossip port
  http_port: number;
  enclave?: string;
}

// --- DNS resolution ---

export async function resolveBootstrapDNS(
  hostname: string,
  defaultPort: number,
  logger: Logger,
  resolver: DnsResolver = defaultResolver,
): Promise<string[]> {
  // Try SRV records first
  try {
    const srvRecords = await resolver.resolveSrv(`_gossip._tcp.${hostname}`);
    if (srvRecords.length > 0) {
      const peers = srvRecords.map(
        (srv) => `${srv.name.replace(/\.$/, "")}:${srv.port}`,
      );
      logger.info(`Resolved ${peers.length} bootstrap peers via SRV`);
      return peers;
    }
  } catch {
    // SRV lookup failed — fall through to A records
  }

  // Fall back to A/AAAA records
  try {
    const addrs = await resolver.resolve4(hostname);
    const peers = addrs.map((addr) => `${addr}:${defaultPort}`);
    logger.info(`Resolved ${peers.length} bootstrap peers via DNS`);
    return peers;
  } catch {
    logger.warn(`DNS bootstrap resolution failed for ${hostname} (starting as first node)`);
    return [];
  }
}

// --- Bootstrap handshake ---

export async function bootstrapFromPeers(
  seedPeers: string[],
  localNode: NodeInfo,
  clusterSecret: string,
  logger: Logger,
): Promise<NodeInfo[]> {
  logger.info(`Starting bootstrap process with ${seedPeers.length} seed nodes`);

  const request: BootstrapRequest = {
    node_id: localNode.id,
    address: localNode.address,
    gossip_port: localNode.port,
    http_port: localNode.httpPort,
  };
  if (localNode.enclave) {
    request.enclave = localNode.enclave;
  }

  // Try each seed until one succeeds
  for (const seed of seedPeers) {
    try {
      const peers = await sendBootstrapRequest(seed, request, clusterSecret, logger);
      // Filter out self
      const discovered = peers.filter((p) => p.id !== localNode.id);
      logger.info(`Bootstrap successful, discovered ${discovered.length} peers from ${seed}`);
      return discovered;
    } catch (err) {
      logger.warn(`Failed to bootstrap from ${seed}: ${err}`);
    }
  }

  logger.info("No seed nodes available, starting as first node");
  return [];
}

async function sendBootstrapRequest(
  seedAddr: string,
  request: BootstrapRequest,
  clusterSecret: string,
  logger: Logger,
): Promise<NodeInfo[]> {
  const jsonBody = JSON.stringify(request);
  const bodyBuffer = Buffer.from(jsonBody);

  const url = `http://${seedAddr}/v1/bootstrap`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (clusterSecret) {
    headers["X-Repram-Signature"] = signBody(clusterSecret, bodyBuffer);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: jsonBody,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`bootstrap rejected with status ${response.status}`);
    }

    const body = (await response.json()) as BootstrapResponse;
    if (!body.success) {
      throw new Error("bootstrap failed");
    }

    return (body.peers ?? []).map(wirePeerToNodeInfo);
  } finally {
    clearTimeout(timeout);
  }
}

function wirePeerToNodeInfo(peer: WireBootstrapPeer): NodeInfo {
  return {
    id: peer.id,
    address: peer.address,
    port: peer.port,
    httpPort: peer.http_port,
    enclave: peer.enclave ?? "default",
  };
}

// --- Notify peers about new node (fire-and-forget with retry) ---

export async function notifyPeerAboutNewNode(
  peerAddr: string,
  request: BootstrapRequest,
  clusterSecret: string,
  logger: Logger,
  maxRetries: number = 3,
): Promise<void> {
  const jsonBody = JSON.stringify(request);
  const bodyBuffer = Buffer.from(jsonBody);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const url = `http://${peerAddr}/v1/bootstrap`;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (clusterSecret) {
        headers["X-Repram-Signature"] = signBody(clusterSecret, bodyBuffer);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);

      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: jsonBody,
          signal: controller.signal,
        });

        if (response.ok) {
          logger.debug(`Notified ${peerAddr} about new node (attempt ${attempt + 1})`);
          return;
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      if (attempt === maxRetries - 1) {
        logger.error(`Failed to notify ${peerAddr} after ${maxRetries} attempts: ${err}`);
      } else {
        const delay = (1 << attempt) * 1000; // 1s, 2s, 4s
        logger.warn(`Failed to notify ${peerAddr} (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
