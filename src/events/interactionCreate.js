/**
 * @file interactionCreate.js
 * @module events/interactionCreate
 *
 * Routes incoming slash command interactions to the configuration-driven
 * `dynamicFetchExecutor`. This file contains ZERO command-specific logic —
 * it simply looks up the matching config object and hands the interaction
 * to the executor.
 *
 * Adding a new dynamic-fetch command requires only:
 *   1. Create a new thin config file under `src/commands/<name>.js`.
 *   2. Import it here and add it to the `commandRegistry` Map.
 *   3. Add the name to the registration list in `src/index.js`.
 * No other files need to change.
 */

import { logger } from '../utils/logger.js';
import { executeDynamicFetch } from '../utils/dynamicFetchExecutor.js';
import offsetsConfig from '../commands/offsets.js';
import fflagsConfig from '../commands/fflags.js';

/**
 * Central registry of all dynamic-fetch command configs.
 * @type {Map<string, import('../utils/dynamicFetchExecutor.js').CommandConfig>}
 */
const commandRegistry = new Map([
  [offsetsConfig.name, offsetsConfig],
  [fflagsConfig.name, fflagsConfig],
]);

/** Event name — must match discord.js's emitted event. */
export const name = 'interactionCreate';

/** Not a one-time event. */
export const once = false;

/**
 * Event handler.
 *
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<void>}
 */
export async function execute(interaction) {
  // Only route chat-input (slash) commands. Autocomplete, modals,
  // button, and select-menu interactions are ignored here.
  if (!interaction.isChatInputCommand()) return;

  const config = commandRegistry.get(interaction.commandName);
  if (!config) {
    // Unknown command — log and bail. Discord shouldn't deliver these,
    // but a stale global-command registration can cause it after a
    // redeploy that removes a command.
    logger.warn('UNKNOWN_COMMAND', {
      commandName: interaction.commandName,
      userId: interaction.user.id,
    });
    return;
  }

  await executeDynamicFetch(
    /** @type {import('discord.js').ChatInputCommandInteraction} */ (interaction),
    config,
  );
}

export default { name, once, execute };
