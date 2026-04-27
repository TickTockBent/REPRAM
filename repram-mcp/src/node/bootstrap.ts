/**
 * Bootstrap — signed-root-list resolution and cluster join handshake.
 *
 * Port of internal/gossip/bootstrap.go and cmd/repram/main.go's
 * resolveOmegaBootstrap. The unsigned SRV/A-based bootstrap was removed
 * as part of REPRAM 2.1 (see docs/REPRAM-2.1-Spec.md).
 */

import { signBody } from "./auth.js";
import type { Logger } from "./logger.js";
import type { NodeInfo } from "./types.js";
import { fetchSigned } from "./trust/resolver.js";
import { loadCache, saveCache, defaultCacheDir } from "./trust/cache.js";
import { publicKeyFromBase64, SignedList } from "./trust/signed-list.js";
import { OMEGA_PUBKEY } from "./trust/omega.js";

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

// --- Omega signed-root-list discovery ---

/**
 * resolveOmegaBootstrap returns a verified signed root list for the public
 * network, fetching over DNS with on-disk cache fallback. Rejects when no
 * valid trust anchor is available — a node that cannot verify must not
 * join the public network.
 *
 * Callers use `result.nodes` as the seed peer list and additionally check
 * `result` against their own advertised address to determine root status.
 */
export async function resolveOmegaBootstrap(logger: Logger): Promise<SignedList> {
  const pubKey = publicKeyFromBase64(OMEGA_PUBKEY);
  const cacheDir = defaultCacheDir();
  const now = new Date();

  try {
    const list = await fetchSigned({}, pubKey, now);
    try {
      await saveCache(cacheDir, list);
    } catch (err) {
      logger.warn(`Failed to update omega cache at ${cacheDir}: ${err} (continuing)`);
    }
    logger.info(
      `Omega bootstrap: verified signed root list (${list.nodes.length} nodes, expires ${new Date(list.expires * 1000).toISOString()})`,
    );
    return list;
  } catch (fetchErr) {
    logger.warn(`Omega DNS fetch failed: ${fetchErr} — trying cached list at ${cacheDir}`);
    const cached = await loadCache(cacheDir);
    if (!cached) {
      throw new Error(`no DNS record and no cache available: ${(fetchErr as Error).message}`);
    }
    const verifyErr = cached.verify(pubKey, now);
    if (verifyErr) {
      throw new Error(`cached omega list invalid: ${verifyErr.message} (dns: ${(fetchErr as Error).message})`);
    }
    logger.info(
      `Omega bootstrap: using cached signed root list (${cached.nodes.length} nodes, expires ${new Date(cached.expires * 1000).toISOString()})`,
    );
    return cached;
  }
}

// --- Bootstrap handshake ---

/**
 * Contacts ALL seed nodes (not just the first responder) so every seed
 * registers the joining node directly. Stopping at the first success
 * leaves later seeds unaware of the joiner until topology sync, producing
 * asymmetric topologies (#82, F3). Peers from each response are
 * deduplicated by node ID across all seeds; self is always filtered out
 * (#82, F4).
 */
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

  const seen = new Map<string, NodeInfo>();
  let successfulSeeds = 0;

  for (const seed of seedPeers) {
    try {
      const peers = await sendBootstrapRequest(seed, request, clusterSecret, logger);
      successfulSeeds++;
      for (const peer of peers) {
        if (peer.id === localNode.id) continue;
        if (seen.has(peer.id)) continue;
        seen.set(peer.id, peer);
      }
    } catch (err) {
      logger.warn(`Failed to bootstrap from ${seed}: ${err}`);
    }
  }

  if (successfulSeeds === 0) {
    logger.info("No seed nodes available, starting as first node");
    return [];
  }

  const discovered = Array.from(seen.values());
  logger.info(
    `Bootstrap complete: contacted ${successfulSeeds}/${seedPeers.length} seeds, ` +
      `discovered ${discovered.length} unique peers`,
  );
  return discovered;
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
