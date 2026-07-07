/**
 * @file ready.js
 * @module events/ready
 *
 * Fired exactly once when the Discord.js client has successfully
 * connected to the gateway and is ready to receive events.
 */

import { logger } from '../utils/logger.js';

/** Event name. */
export const name = 'ready';

/** Fire only once. */
export const once = true;

/**
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
export async function execute(client) {
  const tag = client.user?.tag ?? '<unknown>';
  const guilds = client.guilds.cache.size;

  logger.info('CLIENT_READY', {
    extra: {
      tag,
      guilds,
      wsPing: client.ws.ping,
    },
  });

  // Set a presence that hints at what the bot does. Cheap to do here
  // so we don't pay the cost on every heartbeat.
  try {
    client.user?.setPresence({
      activities: [{ name: '/offsets · /fflags', type: 3 /* Watching */ }],
      status: 'online',
    });
  } catch (presenceErr) {
    logger.warn('PRESENCE_SET_FAILED', { extra: { error: presenceErr.message } });
  }
}

export default { name, once, execute };
