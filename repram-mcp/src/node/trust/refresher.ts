/**
 * Periodic refresher for the omega signed root list. Mirror of Go's
 * internal/trust/refresher.go. A Refresher holds the currently-verified list
 * and re-fetches it at 90% of its remaining lifetime (±10% jitter), invoking
 * `onUpdate` each time a newly-verified list is adopted.
 */

import type { KeyObject } from "node:crypto";
import { fetchSigned, type DnsConfig } from "./resolver.js";
import { saveCache } from "./cache.js";
import type { SignedList } from "./signed-list.js";

const REFRESH_ROTATION_FRACTION = 0.9;
const REFRESH_JITTER = 0.1;
const REFRESH_BACKOFF_MIN_MS = 30_000;
const REFRESH_BACKOFF_MAX_MS = 10 * 60_000;

/**
 * Clock is a minimal abstraction so tests can drive timing deterministically.
 * The default (real clock) just delegates to setTimeout / Date.now.
 */
export interface Clock {
  now(): number;
  /** setTimeout-style: returns a handle usable with clearTimeout. */
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface RefresherConfig {
  pubKey: KeyObject;
  cacheDir: string;
  dns?: DnsConfig;
  onUpdate: (list: SignedList) => void;
  onError?: (err: unknown) => void;
  clock?: Clock;
  /** For tests: override randomness for deterministic jitter. */
  random?: () => number;
}

export class Refresher {
  private cfg: RefresherConfig;
  private clock: Clock;
  private random: () => number;
  private current: SignedList;

  private stopped = false;
  private timerHandle: unknown = null;

  // Resolved when Trigger() is called; reset on each use. The run loop
  // races this against the scheduled delay.
  private triggerResolve: (() => void) | null = null;
  private triggerPromise: Promise<void> | null = null;

  // Set when trigger() fires while no waitOrTrigger is active (e.g. during
  // an in-flight refreshOnce). Consumed at the top of the next
  // waitOrTrigger to make it return immediately. Mirrors the buffered
  // triggerCh in Go's Refresher so peer-count-drop signals are never lost.
  private pendingTrigger = false;

  constructor(cfg: RefresherConfig, initial: SignedList) {
    this.cfg = cfg;
    this.clock = cfg.clock ?? realClock;
    this.random = cfg.random ?? Math.random;
    this.current = initial;
    this.resetTrigger();
  }

  get currentList(): SignedList {
    return this.current;
  }

  /** Request an immediate refresh. Safe to call concurrently. If no
   *  waitOrTrigger is currently active (e.g. trigger fires during an
   *  in-flight refreshOnce), the signal is buffered and consumed by the
   *  next waitOrTrigger. */
  trigger(): void {
    this.pendingTrigger = true;
    const resolve = this.triggerResolve;
    this.resetTrigger();
    if (resolve) resolve();
  }

  private resetTrigger(): void {
    this.triggerPromise = new Promise((resolve) => {
      this.triggerResolve = resolve;
    });
  }

  /**
   * run() drives the refresh loop until stop() is called. Fire-and-forget
   * for callers; they do not need to await it. Errors from refresh failures
   * go to cfg.onError — the loop itself never rejects.
   */
  async run(): Promise<void> {
    let backoffMs = REFRESH_BACKOFF_MIN_MS;
    while (!this.stopped) {
      const delayMs = this.nextDelayMs();
      const woken = await this.waitOrTrigger(delayMs);
      if (this.stopped) return;
      void woken; // whether we woke via timer or trigger is immaterial

      try {
        await this.refreshOnce();
        backoffMs = REFRESH_BACKOFF_MIN_MS;
      } catch (err) {
        this.cfg.onError?.(err);
        const retryWait = await this.waitOrTrigger(backoffMs);
        if (this.stopped) return;
        void retryWait;
        backoffMs = Math.min(backoffMs * 2, REFRESH_BACKOFF_MAX_MS);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timerHandle !== null) {
      this.clock.clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
    // Unblock any pending waitOrTrigger so run() can exit promptly.
    this.trigger();
  }

  private async refreshOnce(): Promise<void> {
    const now = new Date(this.clock.now());
    const list = await fetchSigned(this.cfg.dns ?? {}, this.cfg.pubKey, now);
    try {
      await saveCache(this.cfg.cacheDir, list);
    } catch (err) {
      // Cache write failure is non-fatal. The verified list is still
      // valid in memory; surface via onError for operator visibility.
      this.cfg.onError?.(err);
    }
    this.current = list;
    this.cfg.onUpdate(list);
  }

  private nextDelayMs(): number {
    const nowSec = Math.floor(this.clock.now() / 1000);
    const remainingSec = this.current.expires - nowSec;
    if (remainingSec <= 0) return 0;

    const target = remainingSec * 1000 * REFRESH_ROTATION_FRACTION;
    const jitterSpan = target * REFRESH_JITTER * 2;
    const jittered = target + (this.random() * jitterSpan - jitterSpan / 2);
    return Math.max(0, Math.floor(jittered));
  }

  private waitOrTrigger(ms: number): Promise<"timer" | "trigger"> {
    // Fast path: a trigger fired while we were busy. Consume it and
    // return immediately.
    if (this.pendingTrigger) {
      this.pendingTrigger = false;
      return Promise.resolve("trigger");
    }
    return new Promise((resolve) => {
      const triggerP = this.triggerPromise!;
      this.timerHandle = this.clock.setTimeout(() => {
        this.timerHandle = null;
        resolve("timer");
      }, ms);
      triggerP.then(() => {
        this.pendingTrigger = false;
        if (this.timerHandle !== null) {
          this.clock.clearTimeout(this.timerHandle);
          this.timerHandle = null;
        }
        resolve("trigger");
      });
    });
  }
}
