/**
 * @file logger.js
 * @module utils/logger
 *
 * Structured JSON logger that writes to `stdout` (info/warn/debug) and
 * `stderr` (error) so Railway.com's log drain can natively ingest, search,
 * and forward the lines to Logflare / Loki / Datadog without any adapter.
 *
 * Every emitted line is a single JSON object — no ANSI colors, no
 * multi-line pretty-printing — to maximise parseability by downstream
 * observability tools.
 */

/**
 * Numeric severity ranking used for level filtering.
 * @enum {number}
 */
const LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

/**
 * Resolved minimum log level. Pulled from `LOG_LEVEL` env var at module
 * load time so we never pay the env-lookup cost on each emission.
 * @type {number}
 */
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL ?? 'info'] ?? LEVELS.info;

/**
 * @typedef {Object} LogPayload
 * @property {string}  [event]        - Stable machine-readable event name, e.g. `CACHE_HIT`.
 * @property {string}  [commandName]  - Name of the slash command that triggered the log.
 * @property {string}  [userId]       - Discord snowflake of the invoking user.
 * @property {number}  [latencyMs]    - Wall-clock latency of the measured operation.
 * @property {Record<string, unknown>} [extra] - Arbitrary structured context.
 */

/**
 * Serialize a log line and write it to the correct stream.
 *
 * - `error` → `process.stderr` (so Railway marks the line as error-level)
 * - everything else → `process.stdout`
 *
 * Errors during serialization are swallowed to NEVER break the calling
 * hot-path; logging must be best-effort.
 *
 * @param {string} level   - One of: debug | info | warn | error
 * @param {string} message - Human-readable summary
 * @param {LogPayload} [payload] - Structured context
 * @returns {void}
 */
function emit(level, message, payload = {}) {
  if (LEVELS[level] < MIN_LEVEL) return;

  /** @type {Record<string, unknown>} */
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };

  // Flatten known top-level keys, dump the rest under `extra`.
  for (const key of ['event', 'commandName', 'userId', 'latencyMs']) {
    if (payload[key] !== undefined) entry[key] = payload[key];
  }
  if (payload.extra && Object.keys(payload.extra).length > 0) {
    entry.extra = payload.extra;
  }

  let line;
  try {
    line = JSON.stringify(entry);
  } catch {
    // Circular reference or similar — fall back to a safe representation.
    line = JSON.stringify({
      timestamp: entry.timestamp,
      level,
      message: String(message),
      error: 'logger_serialization_failed',
    });
  }

  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(line + '\n');
}

/**
 * Public logger facade. Each method is a thin wrapper around `emit`.
 * @type {{
 *   debug: (message: string, payload?: LogPayload) => void,
 *   info:  (message: string, payload?: LogPayload) => void,
 *   warn:  (message: string, payload?: LogPayload) => void,
 *   error: (message: string, payload?: LogPayload) => void,
 * }}
 */
export const logger = Object.freeze({
  debug: (message, payload) => emit('debug', message, payload),
  info: (message, payload) => emit('info', message, payload),
  warn: (message, payload) => emit('warn', message, payload),
  error: (message, payload) => emit('error', message, payload),
});

export default logger;
