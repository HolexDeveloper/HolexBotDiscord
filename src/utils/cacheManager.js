/**
 * @file cacheManager.js
 * @module utils/cacheManager
 *
 * Multi-tiered in-memory cache with two co-resident responsibilities:
 *
 *  1. TTL caching — store raw `Buffer` payloads keyed by URL with a strict
 *     5-minute expiry. Buffers (not strings) are stored so we never pay
 *     the re-encoding cost on a cache hit when building an attachment.
 *
 *  2. Mutex / single-flight — when the cache is cold or expired and N
 *     concurrent callers request the same URL, only the FIRST caller
 *     triggers an actual network fetch. All subsequent callers `await`
 *     the same in-flight Promise. This is the "thundering-herd" / cache-
 *     stampede protection demanded by the architecture spec.
 *
 *  3. Metrics — every cache hit / miss / fetch error is recorded per
 *     command name so an operator can scrape `cache.getMetrics()` for
 *     observability (e.g. expose via a /metrics endpoint if added later).
 *
 * Concurrency model:
 *  - `acquireOrJoin(url, fetcher)` returns a Promise. The first caller
 *    stores that Promise in `this.locks`; concurrent callers receive
 *    the SAME Promise. When the fetcher resolves (or rejects) the lock
 *    entry is removed in a `finally` so a failure does not poison
 *    subsequent attempts.
 */

import { logger } from './logger.js';

/**
 * @typedef {Object} CacheEntry
 * @property {Buffer}    buffer     - Raw response bytes.
 * @property {number}    expiresAt  - Epoch ms when the entry becomes stale.
 */

export class CacheManager {
  /**
   * @param {number} [ttlMs=300000] - Default 5 minutes.
   */
  constructor(ttlMs = Number(process.env.CACHE_TTL_MS ?? 5 * 60 * 1000)) {
    this.ttlMs = ttlMs;

    /** @type {Map<string, CacheEntry>} */
    this.cache = new Map();

    /**
     * In-flight fetch promises keyed by URL — the mutex layer.
     * @type {Map<string, Promise<Buffer>>}
     */
    this.locks = new Map();

    /**
     * Per-command metric counters.
     * @type {Record<string, {hits:number, misses:number, errors:number}>}
     */
    this.metrics = {};

    /** @type {NodeJS.Timeout} */
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref?.();
  }

  /**
   * Look up a cached Buffer. Returns `null` if absent or expired
   * (expired entries are deleted on access for immediate GC).
   *
   * @param {string} url
   * @returns {Buffer | null}
   */
  get(url) {
    const entry = this.cache.get(url);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(url);
      return null;
    }
    return entry.buffer;
  }

  /**
   * Store a Buffer with a fresh TTL.
   *
   * @param {string} url
   * @param {Buffer} buffer
   * @returns {void}
   */
  set(url, buffer) {
    this.cache.set(url, {
      buffer,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /**
   * Mutex-protected fetcher invocation.
   *
   * If no fetch is currently in flight for `url`, the supplied `fetcher`
   * is invoked and its Promise is recorded so concurrent callers receive
   * the same Promise. The fetcher is responsible ONLY for producing a
   * Buffer; this method handles storing the result in the cache and
   * clearing the lock on completion.
   *
   * @param {string} url
   * @param {() => Promise<Buffer>} fetcher
   * @returns {Promise<Buffer>}
   */
  async acquireOrJoin(url, fetcher) {
    const existing = this.locks.get(url);
    if (existing) {
      // Another caller is already fetching — join the single in-flight request.
      logger.debug('MUTEX_JOIN', { extra: { url } });
      return existing;
    }

    // Build the fetch promise. We do NOT await here — we synchronously
    // install it into the locks Map so the very next caller can join.
    const promise = (async () => {
      try {
        const buffer = await fetcher();
        this.set(url, buffer);
        return buffer;
      } finally {
        // Always clear the lock — success OR failure. A failure must not
        // cause subsequent callers to join a dead promise.
        this.locks.delete(url);
      }
    })();

    this.locks.set(url, promise);
    logger.debug('MUTEX_ACQUIRE', { extra: { url } });
    return promise;
  }

  /**
   * Record a metric tick for a command.
   *
   * @param {string} commandName
   * @param {'hits'|'misses'|'errors'} type
   * @returns {void}
   */
  recordMetric(commandName, type) {
    if (!this.metrics[commandName]) {
      this.metrics[commandName] = { hits: 0, misses: 0, errors: 0 };
    }
    this.metrics[commandName][type]++;
  }

  /**
   * Return a shallow clone of the current metrics snapshot.
   * @returns {Record<string, {hits:number, misses:number, errors:number}>}
   */
  getMetrics() {
    return JSON.parse(JSON.stringify(this.metrics));
  }

  /**
   * Periodic sweep of stale cache entries. Locks are NEVER swept here —
   * they're cleaned up by their own `finally` block.
   * @returns {void}
   */
  sweep() {
    const now = Date.now();
    let swept = 0;
    for (const [url, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(url);
        swept++;
      }
    }
    if (swept > 0) {
      logger.debug('CACHE_SWEEP', { extra: { sweptEntries: swept } });
    }
  }

  /**
   * Stop the background sweep and free all state.
   * @returns {void}
   */
  destroy() {
    clearInterval(this.sweepTimer);
    this.cache.clear();
    this.locks.clear();
  }
}

export default CacheManager;
