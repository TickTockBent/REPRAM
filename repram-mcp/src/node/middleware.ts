/**
 * Security middleware — rate limiting, scanner detection, request guards.
 *
 * Port of internal/node/middleware.go. No mutexes needed in single-threaded
 * Node.js. These are standalone utilities consumed by the HTTP server (P2b).
 */

import type { IncomingMessage, ServerResponse } from "node:http";

// ─── Rate Limiter ────────────────────────────────────────────────────

interface TokenBucket {
  tokens: number;
  lastRefill: number; // Date.now()
}

export class RateLimiter {
  private buckets = new Map<string, TokenBucket>();
  private rate: number;       // tokens per second
  private burst: number;      // max tokens
  private cleanupTimer: ReturnType<typeof setInterval> | null;

  constructor(ratePerSecond: number, burst: number) {
    this.rate = ratePerSecond;
    this.burst = burst;
    // Evict stale buckets every 5 minutes (matching Go)
    this.cleanupTimer = setInterval(() => this.cleanupStale(), 5 * 60_000);
  }

  allow(ip: string): boolean {
    let bucket = this.buckets.get(ip);
    if (!bucket) {
      bucket = { tokens: this.burst, lastRefill: Date.now() };
      this.buckets.set(ip, bucket);
    }

    // Refill based on elapsed time
    const now = Date.now();
    const elapsedSeconds = (now - bucket.lastRefill) / 1000;
    const tokensToAdd = Math.floor(elapsedSeconds * this.rate);

    if (tokensToAdd > 0) {
      bucket.tokens = Math.min(this.burst, bucket.tokens + tokensToAdd);
      bucket.lastRefill = now;
    }

    if (bucket.tokens > 0) {
      bucket.tokens--;
      return true;
    }

    return false;
  }

  /** Number of tracked IPs (exposed for testing). */
  get bucketCount(): number {
    return this.buckets.size;
  }

  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private cleanupStale(): void {
    const cutoff = Date.now() - 10 * 60_000; // 10 minutes
    for (const [ip, bucket] of this.buckets) {
      if (bucket.lastRefill < cutoff) {
        this.buckets.delete(ip);
      }
    }
  }
}

// ─── Scanner Detection ───────────────────────────────────────────────

/**
 * Known vulnerability scanner user-agents. Only scanner-specific tools —
 * not general-purpose HTTP libraries. REPRAM is permissionless by design;
 * python-requests, curl, etc. are legitimate clients.
 */
const SCANNER_USER_AGENTS = [
  "sqlmap",
  "nikto",
  "nmap",
  "masscan",
  "gobuster",
  "dirbuster",
];

export function isScannerRequest(userAgent: string): boolean {
  const lower = userAgent.toLowerCase();
  return SCANNER_USER_AGENTS.some((scanner) => lower.includes(scanner));
}

// ─── Client IP Extraction ────────────────────────────────────────────

/**
 * Extract the client IP from an incoming HTTP request.
 * Only trusts proxy headers (X-Forwarded-For, X-Real-IP) when trustProxy
 * is true. Otherwise uses the direct socket address.
 */
export function getClientIP(
  req: IncomingMessage,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) {
      const first = (Array.isArray(xff) ? xff[0] : xff).split(",")[0].trim();
      if (first) return first;
    }
    const xri = req.headers["x-real-ip"];
    if (xri) {
      return Array.isArray(xri) ? xri[0] : xri;
    }
  }

  // Direct connection IP
  return req.socket?.remoteAddress ?? "unknown";
}

// ─── Security Headers ────────────────────────────────────────────────

export function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Content-Security-Policy", "default-src 'self'");
  res.setHeader("X-REPRAM-Node", "2.0.0");
}

// ─── CORS ────────────────────────────────────────────────────────────

/**
 * Apply CORS headers. REPRAM accepts any origin by design — it's a
 * permissionless network primitive.
 */
export function applyCorsHeaders(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-TTL, X-Repram-Signature");
  res.setHeader("Access-Control-Max-Age", "3600");
}

// ─── Composed SecurityMiddleware ─────────────────────────────────────

export interface SecurityMiddlewareOptions {
  rateLimit: number;
  burst: number;
  maxRequestSize: number;
  trustProxy: boolean;
}

export class SecurityMiddleware {
  readonly rateLimiter: RateLimiter;
  readonly maxRequestSize: number;
  private trustProxy: boolean;

  constructor(options: SecurityMiddlewareOptions) {
    this.rateLimiter = new RateLimiter(options.rateLimit, options.burst);
    this.maxRequestSize = options.maxRequestSize;
    this.trustProxy = options.trustProxy;
  }

  /**
   * Run all security checks. Returns the client IP if allowed,
   * or null if the request was rejected (response already sent).
   */
  check(req: IncomingMessage, res: ServerResponse): string | null {
    applySecurityHeaders(res);

    const clientIP = getClientIP(req, this.trustProxy);

    if (!this.rateLimiter.allow(clientIP)) {
      res.writeHead(429, { "Content-Type": "text/plain" });
      res.end("Rate limit exceeded");
      return null;
    }

    const contentLength = parseInt(req.headers["content-length"] ?? "0", 10);
    if (contentLength > this.maxRequestSize) {
      res.writeHead(413, { "Content-Type": "text/plain" });
      res.end("Request too large");
      return null;
    }

    const userAgent = req.headers["user-agent"] ?? "";
    if (isScannerRequest(userAgent)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return null;
    }

    return clientIP;
  }

  close(): void {
    this.rateLimiter.close();
  }
}
