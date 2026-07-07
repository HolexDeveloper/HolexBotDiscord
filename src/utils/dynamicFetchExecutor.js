/**
 * @file dynamicFetchExecutor.js
 * @module utils/dynamicFetchExecutor
 *
 * The single, configuration-driven pipeline that powers EVERY dynamic
 * fetch slash command. There is exactly ONE copy of the fetch / cache /
 * retry / validate / dispatch logic in the entire codebase — per the
 * architecture spec, individual command files are thin config objects
 * and never reimplement any of this.
 *
 * Pipeline stages (in strict order):
 *   1. Rate-limit check          (sliding window, per user per command)
 *   2. `deferReply()`             (beat Discord's 3-second window)
 *   3. Cache lookup               (TTL-protected Buffer)
 *   4. Mutex-protected fetch      (single-flight across all concurrent users)
 *   5. Content validation         (regex gate, anti-compromise)
 *   6. Attachment + embed dispatch(edit the deferred reply)
 *
 * Every stage emits a structured log event for observability.
 */

import {
  AttachmentBuilder,
  EmbedBuilder,
  bold,
} from 'discord.js';

import { CacheManager } from './cacheManager.js';
import { fetchWithRetry, FetchError } from './fetchWithRetry.js';
import { RateLimiter } from './rateLimiter.js';
import { logger } from './logger.js';

/**
 * @typedef {Object} CommandConfig
 * @property {string} name              - Slash command name (must match Discord registration).
 * @property {string} description       - Slash command description.
 * @property {string} url               - Upstream URL to fetch.
 * @property {string} filename          - Filename to attach in Discord.
 * @property {number} embedColor        - Hex integer color for the success embed.
 * @property {string} embedTitle        - Success embed title.
 * @property {string} embedDescription  - Success embed description.
 * @property {RegExp} validationRegex   - Strict regex the fetched content MUST match.
 */

/**
 * Sentinel error for content-validation failures. Throwing a typed error
 * lets the dispatcher render a more useful "compromised upstream" message
 * rather than a generic "fetch failed".
 */
export class ValidationError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ---------------------------------------------------------------------------
// Module-level singletons. Intentionally shared across ALL commands so the
// mutex + cache + rate-limit state is process-global (which is what we want
// for a single-process Railway container).
// ---------------------------------------------------------------------------
export const cache = new CacheManager();
export const rateLimiter = new RateLimiter();

/**
 * Pull the bot's WebSocket heartbeat ping, guarding against the `-1`
 * sentinel Discord.js emits before the first heartbeat round-trip.
 *
 * @param {import('discord.js').Client} client
 * @returns {number}
 */
function heartbeatPing(client) {
  const ping = client.ws.ping;
  return Number.isFinite(ping) && ping >= 0 ? Math.round(ping) : 0;
}

/**
 * Build the success embed. Every visual aspect is driven by the command
 * config so `/offsets` and `/fflags` get visually distinct results.
 *
 * @param {CommandConfig} config
 * @param {import('discord.js').Client} client
 * @param {'cache'|'network'} source
 * @param {Buffer} buffer
 * @returns {EmbedBuilder}
 */
function buildSuccessEmbed(config, client, source, buffer) {
  const sizeKb = (buffer.length / 1024).toFixed(2);
  return new EmbedBuilder()
    .setTitle(config.embedTitle)
    .setDescription(config.embedDescription)
    .setColor(config.embedColor)
    .addFields(
      {
        name: 'Source',
        value: source === 'cache' ? '🟢 In-Memory Cache (5m TTL)' : '🔵 Live Upstream Fetch',
        inline: true,
      },
      { name: 'File Size', value: `${sizeKb} KB`, inline: true },
      { name: 'File Name', value: `\`${config.filename}\``, inline: true },
    )
    .setFooter({ text: `WebSocket Heartbeat: ${heartbeatPing(client)}ms` })
    .setTimestamp();
}

/**
 * Build the rate-limit violation embed (always ephemeral).
 *
 * @param {CommandConfig} config
 * @param {import('discord.js').Client} client
 * @param {number} retryAfterSec
 * @returns {EmbedBuilder}
 */
function buildRateLimitEmbed(config, client, retryAfterSec) {
  return new EmbedBuilder()
    .setTitle('⏱️ Slow Down — Rate Limited')
    .setDescription(
      `You're calling \`${config.name}\` too quickly.\nTry again in ${bold(
        `${retryAfterSec}s`,
      )}.`,
    )
    .setColor(0xF1C40F)
    .setFooter({ text: `WebSocket Heartbeat: ${heartbeatPing(client)}ms` })
    .setTimestamp();
}

/**
 * Build the failure embed. Includes a sanitized error category so the
 * end user gets a useful hint without leaking stack traces.
 *
 * @param {CommandConfig} config
 * @param {import('discord.js').Client} client
 * @param {Error} err
 * @returns {EmbedBuilder}
 */
function buildErrorEmbed(config, client, err) {
  let title = '⚠️ Operation Failed';
  let description = `\`${config.name}\` could not complete. Please try again shortly.`;

  if (err instanceof ValidationError) {
    title = '🚨 Content Validation Failed';
    description =
      'The upstream endpoint returned content that did not match the expected format. ' +
      'This may indicate a compromise or maintenance window. The anomaly has been logged.';
  } else if (err instanceof FetchError) {
    if (err.statusCode === 0) {
      title = '🌐 Network Unreachable';
      description =
        'The bot could not reach the upstream endpoint (timeout or DNS failure). ' +
        'All retries have been exhausted.';
    } else {
      title = `🚫 Upstream Returned ${err.statusCode}`;
      description = `The upstream endpoint responded with HTTP ${err.statusCode}.`;
    }
  }

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0xED4245)
    .setFooter({ text: `WebSocket Heartbeat: ${heartbeatPing(client)}ms` })
    .setTimestamp();
}

/**
 * Dispatch the file + embed, editing the previously deferred reply.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {CommandConfig} config
 * @param {Buffer} buffer
 * @param {'cache'|'network'} source
 * @returns {Promise<void>}
 */
async function dispatchFile(interaction, config, buffer, source) {
  const attachment = new AttachmentBuilder(buffer, { name: config.filename });
  const embed = buildSuccessEmbed(config, interaction.client, source, buffer);
  await interaction.editReply({ embeds: [embed], files: [attachment] });
}

/**
 * Dispatch an error embed, editing the deferred reply. Failures here are
 * swallowed because we cannot do anything useful with them — the
 * interaction is already in a deferred state.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {CommandConfig} config
 * @param {Error} err
 * @returns {Promise<void>}
 */
async function dispatchError(interaction, config, err) {
  const embed = buildErrorEmbed(config, interaction.client, err);
  try {
    await interaction.editReply({ embeds: [embed] });
  } catch (editErr) {
    logger.error('EDIT_REPLY_FAILED', {
      commandName: config.name,
      extra: { originalError: err.message, editError: editErr.message },
    });
  }
}

/**
 * Execute the full dynamic-fetch pipeline for a given command config.
 *
 * This is the ONLY entry point called from `interactionCreate`. All
 * command-specific behaviour is sourced from `config`.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {CommandConfig} config
 * @returns {Promise<void>}
 */
export async function executeDynamicFetch(interaction, config) {
  const start = Date.now();
  const { user, client } = interaction;
  const userId = user.id;
  const commandName = config.name;

  // ---------------------------------------------------------------
  // STAGE 1 — Rate-limit check (BEFORE deferReply so we can return
  // an ephemeral reply, which is impossible after a non-ephemeral defer).
  // ---------------------------------------------------------------
  const rateKey = `${commandName}:${userId}`;
  const rate = rateLimiter.check(rateKey);
  if (!rate.allowed) {
    logger.info('RATE_LIMITED', { commandName, userId, latencyMs: Date.now() - start });
    const embed = buildRateLimitEmbed(config, client, rate.retryAfterSec);
    await interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => {});
    return;
  }

  // ---------------------------------------------------------------
  // STAGE 2 — Defer the reply. Discord gives us 3 seconds to ACK an
  // interaction; with retries + backoff we can blow past that easily.
  // ---------------------------------------------------------------
  try {
    await interaction.deferReply();
  } catch (deferErr) {
    logger.error('DEFER_FAILED', {
      commandName,
      userId,
      latencyMs: Date.now() - start,
      extra: { error: deferErr.message },
    });
    return;
  }

  // ---------------------------------------------------------------
  // STAGE 3 — Cache lookup. Hits short-circuit everything downstream.
  // ---------------------------------------------------------------
  try {
    const cached = cache.get(config.url);
    if (cached) {
      cache.recordMetric(commandName, 'hits');
      logger.info('CACHE_HIT', { commandName, userId, latencyMs: Date.now() - start });
      await dispatchFile(interaction, config, cached, 'cache');
      return;
    }

    cache.recordMetric(commandName, 'misses');
    logger.info('CACHE_MISS', { commandName, userId, latencyMs: Date.now() - start });

    // ---------------------------------------------------------------
    // STAGE 4 — Mutex-protected fetch. If 50 users hit /offsets at once
    // after cache expiry, only ONE network request fires.
    // ---------------------------------------------------------------
    const buffer = await cache.acquireOrJoin(config.url, async () => {
      const result = await fetchWithRetry(config.url);
      logger.info('FETCH_SUCCESS', {
        commandName,
        userId,
        latencyMs: result.latencyMs,
        extra: { attempts: result.attempts, statusCode: result.statusCode },
      });
      return result.buffer;
    });

    // ---------------------------------------------------------------
    // STAGE 5 — Content validation. Reject compromised / malformed
    // upstream responses (e.g. an HTML error page from a hijacked host).
    // ---------------------------------------------------------------
    const text = buffer.toString('utf8');
    if (!config.validationRegex.test(text)) {
      cache.recordMetric(commandName, 'errors');
      logger.warn('VALIDATION_FAILED', {
        commandName,
        userId,
        latencyMs: Date.now() - start,
        extra: {
          url: config.url,
          preview: text.slice(0, 120).replace(/\s+/g, ' '),
        },
      });
      throw new ValidationError(
        `Content from ${config.url} failed the ${commandName} validation regex.`,
      );
    }

    // ---------------------------------------------------------------
    // STAGE 6 — Dispatch file + embed.
    // ---------------------------------------------------------------
    await dispatchFile(interaction, config, buffer, 'network');
    logger.info('DISPATCH_SUCCESS', {
      commandName,
      userId,
      latencyMs: Date.now() - start,
    });
  } catch (err) {
    cache.recordMetric(commandName, 'errors');
    logger.error('COMMAND_ERROR', {
      commandName,
      userId,
      latencyMs: Date.now() - start,
      extra: {
        error: err.message,
        name: err.name,
        stack: err.stack,
      },
    });
    await dispatchError(interaction, config, err);
  }
}

export default executeDynamicFetch;
