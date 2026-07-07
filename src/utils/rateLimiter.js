/**
 * @file rateLimiter.js
 * @module utils/rateLimiter
 *
 * In-memory sliding-window rate limiter.
 *
 * Design notes:
 * - "Sliding window" = we keep an array of timestamps for every accepted
 *   request within the window. When a new request arrives we drop every
 *   timestamp older than `windowMs` and then check the surviving count.
 *   This is more accurate than the fixed-window counter at the cost of a
 *   tiny per-key array allocation.
 * - We share a single `Map` across all commands so a user can be limited
 *   on `/offsets` without affecting `/fflags` — the key is namespaced by
 *   the caller (`${commandName}:${userId}`).
 * - A background sweep (unref'd so it never keeps the event loop alive on
 *   shutdown) drops stale keys every 60 seconds to bound memory growth.
 */

import { logger } from './logger.js';

/**
 * @typedef {Object} RateLimitResult
 * @property {boolean} allowed         - Whether the request is permitted.
 * @property {number}  remainingMs     - Milliseconds until the oldest
 *                                       request in the window expires (0 if allowed).
 * @property {number}  retryAfterSec   - `Math.ceil(remainingMs / 1000)`,
 *                                       suitable for direct display to the user.
 */

export class RateLimiter {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.defaultLimit=1]     - Default max requests per window.
   * @param {number} [opts.defaultWindowMs=15000] - Default window size in ms.
   * @param {number} [opts.sweepIntervalMs=60000] - How often to purge stale keys.
   */
  constructor(opts = {}) {
    const {
      defaultLimit = Number(process.env.RATE_LIMIT_MAX ?? 1),
      defaultWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 15_000),
      sweepIntervalMs = 60_000,
    } = opts;

    this.defaultLimit = defaultLimit;
    this.defaultWindowMs = defaultWindowMs;

    /** @type {Map<string, number[]>} */
    this.windows = new Map();

    /** @type {NodeJS.Timeout} */
    this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    // Never keep the process alive just for the sweeper.
    this.sweepTimer.unref?.();
  }

  /**
   * Atomically check-and-record a request against the limiter.
   *
   * @param {string} key        - Caller-namespaced key, e.g. `offsets:123456`.
   * @param {number} [limit]    - Override the default max requests.
   * @param {number} [windowMs] - Override the default window size.
   * @returns {RateLimitResult}
   */
  check(key, limit = this.defaultLimit, windowMs = this.defaultWindowMs) {
    const now = Date.now();
    const cutoff = now - windowMs;

    // Pull existing timestamps and drop those outside the window.
    const existing = this.windows.get(key) ?? [];
    const fresh = existing.filter((ts) => ts > cutoff);

    if (fresh.length >= limit) {
      // Denied — do NOT record the timestamp (so the window can expire).
      const oldest = fresh[0];
      const remainingMs = windowMs - (now - oldest);
      const clamped = Math.max(0, remainingMs);
      const retryAfterSec = Math.ceil(clamped / 1000);
      logger.debug('RATE_LIMIT_DENY', {
        extra: { key, fresh: fresh.length, limit, retryAfterSec },
      });
      return { allowed: false, remainingMs: clamped, retryAfterSec };
    }

    // Allowed — record the timestamp.
    fresh.push(now);
    this.windows.set(key, fresh);
    return { allowed: true, remainingMs: 0, retryAfterSec: 0 };
  }

  /**
   * Periodically evict keys whose windows are entirely stale.
   * Uses a generous 1-hour horizon so transient spikes don't churn the Map.
   * @returns {void}
   */
  sweep() {
    const cutoff = Date.now() - 3_600_000; // 1h
    let removed = 0;
    for (const [key, timestamps] of this.windows) {
      const fresh = timestamps.filter((ts) => ts > cutoff);
      if (fresh.length === 0) {
        this.windows.delete(key);
        removed++;
      } else {
        this.windows.set(key, fresh);
      }
    }
    if (removed > 0) {
      logger.debug('RATE_LIMIT_SWEEP', { extra: { removedKeys: removed } });
    }
  }

  /**
   * Stop the background sweep. Useful for tests / graceful shutdown.
   * @returns {void}
   */
  destroy() {
    clearInterval(this.sweepTimer);
    this.windows.clear();
  }
}

export default RateLimiter;
