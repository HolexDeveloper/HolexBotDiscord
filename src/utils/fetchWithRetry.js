/**
 * @file fetchWithRetry.js
 * @module utils/fetchWithRetry
 *
 * Network resilience layer.
 *
 * Responsibilities:
 *  1. Enforce an explicit per-request timeout via `AbortController`.
 *  2. Retry on transient failures (5xx, AbortError, DNS failures).
 *  3. Apply exponential backoff between attempts (1s, 2s, 4s, ...).
 *  4. Return a raw `Buffer` so the caller never re-encodes strings.
 *
 * Uses Node 18+'s native global `fetch` — no `undici`/`node-fetch`
 * dependency required, which keeps the dependency tree tiny and the
 * Alpine runner image lean.
 */

import { logger } from './logger.js';

/**
 * Custom error wrapper that carries the upstream HTTP status code so
 * the caller can distinguish 4xx (non-retryable) from 5xx (retryable).
 */
export class FetchError extends Error {
  /**
   * @param {string} message
   * @param {number} [statusCode=0]
   * @param {string} [code='']
   */
  constructor(message, statusCode = 0, code = '') {
    super(message);
    this.name = 'FetchError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Resolve the configured knobs from env once, with sensible defaults.
 * @type {{timeoutMs:number, maxRetries:number, baseDelayMs:number}}
 */
const DEFAULTS = Object.freeze({
  timeoutMs: Number(process.env.FETCH_TIMEOUT_MS ?? 5_000),
  maxRetries: Number(process.env.FETCH_MAX_RETRIES ?? 3),
  baseDelayMs: Number(process.env.FETCH_BASE_BACKOFF_MS ?? 1_000),
});

/**
 * Promise-based sleep that does NOT allocate a timer that blocks
 * shutdown (we want backoff to be interruptible via Promise.race if
 * needed in the future — for now a plain setTimeout is fine).
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decide whether an error is worth retrying.
 *
 * Retryable conditions:
 *  - `AbortError` (timeout fired before headers arrived)
 *  - DNS errors (`ENOTFOUND`, `EAI_AGAIN`, `ECONNRESET`)
 *  - `FetchError` with statusCode >= 500
 *
 * Non-retryable:
 *  - 4xx (the upstream explicitly rejected us)
 *  - 3xx (fetch follows redirects automatically — a final 3xx here is malformed)
 *  - `FetchError` with statusCode < 500
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isRetryable(err) {
  if (!err) return false;
  if (err instanceof FetchError) return err.statusCode >= 500;
  // Native fetch / Node network errors carry `.name` or `.code`.
  const name = /** @type {Error} */ (err).name;
  const code = /** @type {NodeJS.ErrnoException} */ (err).code;
  if (name === 'AbortError') return true;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNRESET' || code === 'ETIMEDOUT') {
    return true;
  }
  return false;
}

/**
 * Fetch a URL with timeout + exponential backoff.
 *
 * @param {string} url
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxRetries]
 * @param {number} [opts.baseDelayMs]
 * @param {Record<string,string>} [opts.headers]
 * @returns {Promise<{buffer: Buffer, statusCode: number, attempts: number, latencyMs: number}>}
 * @throws {FetchError} On non-retryable failure or after exhausting retries.
 */
export async function fetchWithRetry(url, opts = {}) {
  const {
    timeoutMs = DEFAULTS.timeoutMs,
    maxRetries = DEFAULTS.maxRetries,
    baseDelayMs = DEFAULTS.baseDelayMs,
    headers = { 'User-Agent': 'DiscordBot/1.0 (+Railway)' },
  } = opts;

  /** @type {Error|null} */
  let lastError = null;

  // attempt = 0 .. maxRetries  →  total attempts = maxRetries + 1
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    /** @type {NodeJS.Timeout} */
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const start = Date.now();

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers,
        redirect: 'follow',
      });
      clearTimeout(timer);
      const latencyMs = Date.now() - start;

      // Retryable 5xx — back off and try again (unless this was the last attempt).
      if (res.status >= 500 && attempt < maxRetries) {
        logger.warn('FETCH_5XX_RETRY', {
          extra: { url, status: res.status, attempt: attempt + 1, maxRetries: maxRetries + 1 },
        });
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }

      // Non-retryable HTTP failure — bubble up immediately.
      if (!res.ok) {
        throw new FetchError(`HTTP ${res.status} from ${url}`, res.status);
      }

      // Success — convert to Buffer once, return.
      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      return { buffer, statusCode: res.status, attempts: attempt + 1, latencyMs };
    } catch (err) {
      clearTimeout(timer);

      // If the abort fired DURING arrayBuffer() the error name is still AbortError.
      lastError = err instanceof Error ? err : new Error(String(err));

      if (isRetryable(lastError) && attempt < maxRetries) {
        logger.warn('FETCH_RETRY', {
          extra: {
            url,
            attempt: attempt + 1,
            maxRetries: maxRetries + 1,
            error: lastError.message,
            code: /** @type {NodeJS.ErrnoException} */ (lastError).code ?? '',
          },
        });
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }

      // Non-retryable OR out of retries — break out and throw.
      if (!(lastError instanceof FetchError)) {
        lastError = new FetchError(
          lastError.message || 'Unknown fetch error',
          0,
          /** @type {NodeJS.ErrnoException} */ (lastError).code ?? '',
        );
      }
      break;
    }
  }

  // Loop exited without returning → we have a terminal error.
  throw lastError ?? new FetchError('fetchWithRetry exhausted with no error captured');
}

export default fetchWithRetry;
