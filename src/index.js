/**
 * @file index.js
 * @module index
 *
 * Process entry point. Owns three responsibilities:
 *
 *   1. Construct & login the Discord.js client.
 *   2. Register (or update) the global slash commands declared in
 *      `src/commands/*.js` against the Discord Application API.
 *   3. Wire up graceful shutdown (SIGTERM / SIGINT) so Railway redeploys
 *      don't leave zombie WebSocket connections on the gateway.
 *
 * The file is deliberately compact — every behavioural concern lives
 * behind a focused module boundary so this file stays readable.
 */

import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';

import { logger } from './utils/logger.js';
import readyEvent from './events/ready.js';
import interactionCreateEvent from './events/interactionCreate.js';
import offsetsConfig from './commands/offsets.js';
import fflagsConfig from './commands/fflags.js';

/**
 * Source-of-truth list of every command the bot exposes. Adding a new
 * command means adding its config here AND in `events/interactionCreate.js`.
 */
const COMMAND_CONFIGS = [offsetsConfig, fflagsConfig];

// ---------------------------------------------------------------------------
// Environment validation — fail fast with a clear log line if the operator
// forgot to set credentials. This is critical for Railway deploys where
// the container will otherwise boot-loop silently.
// ---------------------------------------------------------------------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  logger.error('MISSING_ENV', {
    extra: {
      message:
        'DISCORD_TOKEN and DISCORD_CLIENT_ID are both required. Copy .env.example to .env and fill in your values.',
      hasToken: Boolean(DISCORD_TOKEN),
      hasClientId: Boolean(DISCORD_CLIENT_ID),
    },
  });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Client construction. We only need the Guilds intent — the bot doesn't
// read messages, just slash command interactions.
// ---------------------------------------------------------------------------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Wire up event handlers.
client.once(readyEvent.name, (...args) => readyEvent.execute(...args));
client.on(interactionCreateEvent.name, (...args) =>
  interactionCreateEvent.execute(...args),
);

// ---------------------------------------------------------------------------
// Slash command registration. Runs against Discord's global command route.
// Global commands can take up to ~1 hour to propagate; for instant updates
// during development, swap `applicationCommands` for `applicationGuildCommands`
// and pass a guild ID.
// ---------------------------------------------------------------------------
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  const payload = COMMAND_CONFIGS.map((cfg) =>
    new SlashCommandBuilder()
      .setName(cfg.name)
      .setDescription(cfg.description)
      .toJSON(),
  );

  try {
    logger.info('COMMANDS_REGISTERING', { extra: { count: payload.length } });
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: payload });
    logger.info('COMMANDS_REGISTERED', {
      extra: { names: payload.map((c) => c.name) },
    });
  } catch (err) {
    logger.error('COMMANDS_REGISTER_FAILED', {
      extra: { error: err.message, stack: err.stack },
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown.
//
// Railway sends SIGTERM ~30 seconds before SIGKILL during a redeploy.
// We MUST call `client.destroy()` in that window so the Discord gateway
// closes its WebSocket cleanly — otherwise the gateway holds the socket
// open until the TCP keepalive fails (minutes), and Discord may still
// deliver events to a process that can no longer respond.
// ---------------------------------------------------------------------------
let shuttingDown = false;

/**
 * @param {string} signal
 * @returns {Promise<void>}
 */
async function gracefulShutdown(signal) {
  if (shuttingDown) return; // Guard against double-fire (SIGINT + SIGTERM).
  shuttingDown = true;

  logger.info('SHUTDOWN_INITIATED', { extra: { signal } });

  // Race the destroy against a hard 10s deadline so we never exceed
  // Railway's grace window.
  const destroyPromise = client.destroy().then(() => {
    logger.info('CLIENT_DESTROYED', {});
  });

  const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 10_000));
  await Promise.race([destroyPromise, timeoutPromise]);

  if (!client.isReady()) {
    logger.info('SHUTDOWN_COMPLETE', {});
    process.exit(0);
  } else {
    logger.warn('SHUTDOWN_FORCED', { extra: { reason: 'destroy did not complete in 10s' } });
    process.exit(1);
  }
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

// Unhandled error catchers — log richly, never crash the process for
// a single stray promise rejection.
process.on('unhandledRejection', (reason) => {
  logger.error('UNHANDLED_REJECTION', {
    extra: {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    },
  });
});

process.on('uncaughtException', (err) => {
  logger.error('UNCAUGHT_EXCEPTION', {
    extra: { error: err.message, stack: err.stack },
  });
  // For uncaught exceptions we DO exit — the process state may be corrupt.
  // Railway will restart the container automatically.
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Boot sequence.
// ---------------------------------------------------------------------------
(async () => {
  try {
    // Register commands first so they're guaranteed available by the
    // time the client connects. A failure here is fatal — without
    // registered commands the bot is useless.
    await registerCommands();

    await client.login(DISCORD_TOKEN);
    logger.info('CLIENT_LOGIN_OK', {});
  } catch (err) {
    logger.error('STARTUP_ERROR', {
      extra: { error: err.message, stack: err.stack },
    });
    process.exit(1);
  }
})();
