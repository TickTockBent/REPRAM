import { describe, it, expect, vi, afterEach } from "vitest";
import {
  RateLimiter,
  isScannerRequest,
  getClientIP,
  applySecurityHeaders,
  applyCorsHeaders,
  SecurityMiddleware,
} from "./middleware.js";
import type { IncomingMessage, ServerResponse } from "node:http";

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Helpers ─────────────────────────────────────────────────────────

function mockRequest(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
    method: "GET",
    ...overrides,
  } as unknown as IncomingMessage;
}

function mockResponse(): ServerResponse & {
  writtenHead: { status: number; headers?: Record<string, string> } | null;
  writtenBody: string;
  headersSent: boolean;
  _headers: Map<string, string>;
} {
  const headers = new Map<string, string>();
  const res = {
    _headers: headers,
    writtenHead: null as { status: number } | null,
    writtenBody: "",
    headersSent: false,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    writeHead(status: number, hdrs?: Record<string, string>) {
      res.writtenHead = { status, ...hdrs };
      res.headersSent = true;
    },
    end(body?: string) {
      res.writtenBody = body ?? "";
    },
  };
  return res as unknown as ReturnType<typeof mockResponse>;
}

// ─── RateLimiter ─────────────────────────────────────────────────────

describe("RateLimiter", () => {
  it("allows up to burst requests", () => {
    const rl = new RateLimiter(10, 5);
    for (let i = 0; i < 5; i++) {
      expect(rl.allow("1.2.3.4")).toBe(true);
    }
    // 6th request should be denied
    expect(rl.allow("1.2.3.4")).toBe(false);
    rl.close();
  });

  it("refills tokens over time", () => {
    vi.useFakeTimers();
    const rl = new RateLimiter(10, 5);

    // Exhaust burst
    for (let i = 0; i < 5; i++) rl.allow("1.2.3.4");
    expect(rl.allow("1.2.3.4")).toBe(false);

    // Advance 500ms → 5 tokens refilled (10/s * 0.5s = 5)
    vi.advanceTimersByTime(500);
    expect(rl.allow("1.2.3.4")).toBe(true);

    rl.close();
    vi.useRealTimers();
  });

  it("isolates IPs independently", () => {
    const rl = new RateLimiter(10, 2);

    // Exhaust IP A
    rl.allow("1.1.1.1");
    rl.allow("1.1.1.1");
    expect(rl.allow("1.1.1.1")).toBe(false);

    // IP B should still have tokens
    expect(rl.allow("2.2.2.2")).toBe(true);
    rl.close();
  });

  it("caps refill at burst", () => {
    vi.useFakeTimers();
    const rl = new RateLimiter(100, 3);

    // Use 1 token
    rl.allow("1.2.3.4"); // 2 remaining

    // Wait a long time (should cap at burst=3, not accumulate infinitely)
    vi.advanceTimersByTime(60_000);

    // Should allow exactly 3 (burst cap)
    for (let i = 0; i < 3; i++) {
      expect(rl.allow("1.2.3.4")).toBe(true);
    }
    expect(rl.allow("1.2.3.4")).toBe(false);

    rl.close();
    vi.useRealTimers();
  });

  it("cleans up stale buckets", () => {
    vi.useFakeTimers();
    const rl = new RateLimiter(10, 5);

    rl.allow("stale-ip");
    expect(rl.bucketCount).toBe(1);

    // Advance past cleanup interval (5 min) + stale threshold (10 min)
    vi.advanceTimersByTime(15 * 60_000);

    expect(rl.bucketCount).toBe(0);
    rl.close();
    vi.useRealTimers();
  });

  it("close stops cleanup timer", () => {
    const rl = new RateLimiter(10, 5);
    rl.close();
    // Should not throw or leak
  });
});

// ─── Scanner Detection ───────────────────────────────────────────────

describe("isScannerRequest", () => {
  it("blocks known scanners", () => {
    expect(isScannerRequest("sqlmap/1.5")).toBe(true);
    expect(isScannerRequest("Nikto/2.1.6")).toBe(true);
    expect(isScannerRequest("Nmap Scripting Engine")).toBe(true);
    expect(isScannerRequest("masscan/1.3")).toBe(true);
    expect(isScannerRequest("gobuster/3.1")).toBe(true);
    expect(isScannerRequest("DirBuster-1.0")).toBe(true);
  });

  it("allows legitimate user agents", () => {
    expect(isScannerRequest("Mozilla/5.0")).toBe(false);
    expect(isScannerRequest("curl/7.80.0")).toBe(false);
    expect(isScannerRequest("python-requests/2.28.0")).toBe(false);
    expect(isScannerRequest("node-fetch/3.0")).toBe(false);
    expect(isScannerRequest("")).toBe(false);
  });

  it("case-insensitive matching", () => {
    expect(isScannerRequest("SQLMAP")).toBe(true);
    expect(isScannerRequest("Nikto")).toBe(true);
  });
});

// ─── Client IP Extraction ────────────────────────────────────────────

describe("getClientIP", () => {
  it("uses socket address when trustProxy=false", () => {
    const req = mockRequest({
      headers: { "x-forwarded-for": "1.1.1.1" },
      socket: { remoteAddress: "192.168.1.1" } as any,
    });
    expect(getClientIP(req, false)).toBe("192.168.1.1");
  });

  it("uses X-Forwarded-For when trustProxy=true", () => {
    const req = mockRequest({
      headers: { "x-forwarded-for": "1.1.1.1, 10.0.0.1" },
      socket: { remoteAddress: "192.168.1.1" } as any,
    });
    expect(getClientIP(req, true)).toBe("1.1.1.1");
  });

  it("uses X-Real-IP when trustProxy=true and no X-Forwarded-For", () => {
    const req = mockRequest({
      headers: { "x-real-ip": "2.2.2.2" },
      socket: { remoteAddress: "192.168.1.1" } as any,
    });
    expect(getClientIP(req, true)).toBe("2.2.2.2");
  });

  it("falls back to socket address when proxy headers empty", () => {
    const req = mockRequest({
      headers: {},
      socket: { remoteAddress: "10.0.0.1" } as any,
    });
    expect(getClientIP(req, true)).toBe("10.0.0.1");
  });
});

// ─── Security Headers ────────────────────────────────────────────────

describe("applySecurityHeaders", () => {
  it("sets all expected headers", () => {
    const res = mockResponse();
    applySecurityHeaders(res);

    expect(res._headers.get("x-content-type-options")).toBe("nosniff");
    expect(res._headers.get("x-frame-options")).toBe("DENY");
    expect(res._headers.get("x-xss-protection")).toBe("1; mode=block");
    expect(res._headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res._headers.get("content-security-policy")).toBe("default-src 'self'");
    expect(res._headers.get("x-repram-node")).toBe("2.0.0");
  });
});

// ─── CORS ────────────────────────────────────────────────────────────

describe("applyCorsHeaders", () => {
  it("reflects origin when present", () => {
    const req = mockRequest({ headers: { origin: "https://example.com" } });
    const res = mockResponse();
    applyCorsHeaders(req, res);

    expect(res._headers.get("access-control-allow-origin")).toBe("https://example.com");
    expect(res._headers.get("access-control-allow-methods")).toContain("PUT");
    expect(res._headers.get("access-control-allow-headers")).toContain("X-TTL");
  });

  it("does not set origin header when no origin in request", () => {
    const req = mockRequest({ headers: {} });
    const res = mockResponse();
    applyCorsHeaders(req, res);

    expect(res._headers.has("access-control-allow-origin")).toBe(false);
    // Other CORS headers should still be set
    expect(res._headers.has("access-control-allow-methods")).toBe(true);
  });
});

// ─── Composed SecurityMiddleware ─────────────────────────────────────

describe("SecurityMiddleware", () => {
  it("allows valid requests and returns client IP", () => {
    const mw = new SecurityMiddleware({
      rateLimit: 100,
      burst: 10,
      maxRequestSize: 10_000,
      trustProxy: false,
    });

    const req = mockRequest({ socket: { remoteAddress: "1.2.3.4" } as any });
    const res = mockResponse();

    const ip = mw.check(req, res);
    expect(ip).toBe("1.2.3.4");
    expect(res.writtenHead).toBeNull(); // no rejection
    mw.close();
  });

  it("rejects rate-limited requests with 429", () => {
    const mw = new SecurityMiddleware({
      rateLimit: 10,
      burst: 1,
      maxRequestSize: 10_000,
      trustProxy: false,
    });

    const req = mockRequest({ socket: { remoteAddress: "1.2.3.4" } as any });

    // First request passes
    const res1 = mockResponse();
    expect(mw.check(req, res1)).toBe("1.2.3.4");

    // Second request denied
    const res2 = mockResponse();
    expect(mw.check(req, res2)).toBeNull();
    expect(res2.writtenHead?.status).toBe(429);
    mw.close();
  });

  it("rejects oversized requests with 413", () => {
    const mw = new SecurityMiddleware({
      rateLimit: 100,
      burst: 10,
      maxRequestSize: 1000,
      trustProxy: false,
    });

    const req = mockRequest({
      headers: { "content-length": "5000" },
    });
    const res = mockResponse();

    expect(mw.check(req, res)).toBeNull();
    expect(res.writtenHead?.status).toBe(413);
    mw.close();
  });

  it("rejects scanner user agents with 403", () => {
    const mw = new SecurityMiddleware({
      rateLimit: 100,
      burst: 10,
      maxRequestSize: 10_000,
      trustProxy: false,
    });

    const req = mockRequest({
      headers: { "user-agent": "sqlmap/1.5" },
    });
    const res = mockResponse();

    expect(mw.check(req, res)).toBeNull();
    expect(res.writtenHead?.status).toBe(403);
    mw.close();
  });

  it("applies security headers even on rejection", () => {
    const mw = new SecurityMiddleware({
      rateLimit: 100,
      burst: 10,
      maxRequestSize: 10_000,
      trustProxy: false,
    });

    const req = mockRequest({
      headers: { "user-agent": "nikto" },
    });
    const res = mockResponse();

    mw.check(req, res);
    expect(res._headers.get("x-content-type-options")).toBe("nosniff");
    mw.close();
  });
});
