/**
 * MemoryStore — in-memory key-value store with mandatory TTL.
 *
 * Port of internal/storage/memory.go. Single-threaded JS means no
 * mutexes needed — the data-race bugs from #8 and #10 cannot exist here.
 */

export class StoreFull extends Error {
  constructor() {
    super("store capacity exceeded");
    this.name = "StoreFull";
  }
}

export interface Entry {
  data: Buffer;
  createdAt: number;      // Unix ms
  ttlSeconds: number;     // original TTL
  expiresAt: number;      // createdAt + ttl*1000
}

export class MemoryStore {
  private entries = new Map<string, Entry>();
  private currentBytes = 0;
  private maxBytes: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(maxBytes: number = 0) {
    this.maxBytes = maxBytes;
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 30_000);
  }

  put(key: string, data: Buffer, ttlSeconds: number): void {
    const newSize = data.length;

    // Account for overwrites: subtract old entry size
    let oldSize = 0;
    const existing = this.entries.get(key);
    if (existing) {
      oldSize = existing.data.length;
    }

    if (this.maxBytes > 0 && (this.currentBytes - oldSize + newSize) > this.maxBytes) {
      throw new StoreFull();
    }

    // Copy the buffer (don't hold a reference to the caller's buffer)
    const stored = Buffer.from(data);

    const now = Date.now();
    this.entries.set(key, {
      data: stored,
      createdAt: now,
      ttlSeconds,
      expiresAt: now + ttlSeconds * 1000,
    });

    this.currentBytes = this.currentBytes - oldSize + newSize;
  }

  get(key: string): Buffer | null {
    const entry = this.entries.get(key);
    if (!entry) return null;

    if (Date.now() >= entry.expiresAt) {
      return null;
    }

    // Return a copy
    return Buffer.from(entry.data);
  }

  getWithMetadata(key: string): Entry | null {
    const entry = this.entries.get(key);
    if (!entry) return null;

    if (Date.now() >= entry.expiresAt) {
      return null;
    }

    // Return a copy of data within the entry
    return {
      ...entry,
      data: Buffer.from(entry.data),
    };
  }

  exists(key: string): { exists: boolean; remainingTtlSeconds: number } {
    const entry = this.entries.get(key);
    if (!entry) return { exists: false, remainingTtlSeconds: 0 };

    const remaining = entry.expiresAt - Date.now();
    if (remaining <= 0) return { exists: false, remainingTtlSeconds: 0 };

    return { exists: true, remainingTtlSeconds: Math.floor(remaining / 1000) };
  }

  scan(prefix?: string): string[] {
    const keys: string[] = [];
    const now = Date.now();

    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) continue;
      if (prefix && !key.startsWith(prefix)) continue;
      keys.push(key);
    }

    return keys;
  }

  getStats(): { count: number; totalBytes: number } {
    let totalBytes = 0;
    for (const entry of this.entries.values()) {
      totalBytes += entry.data.length;
    }
    return { count: this.entries.size, totalBytes };
  }

  get keyCount(): number {
    return this.entries.size;
  }

  get bytesUsed(): number {
    return this.currentBytes;
  }

  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) {
        this.currentBytes -= entry.data.length;
        this.entries.delete(key);
      }
    }
  }
}
