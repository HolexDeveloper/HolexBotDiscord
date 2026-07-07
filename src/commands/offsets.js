/**
 * @file offsets.js
 * @module commands/offsets
 *
 * THIN COMMAND CONFIG — no fetch/cache/dispatch logic lives here.
 *
 * Per the architecture spec, this file exports ONLY a declarative
 * configuration object that is consumed by `dynamicFetchExecutor`.
 * All behavioural concerns (network, mutex, cache, retry, validation,
 * embed rendering, attachment dispatch) are centralised in the executor.
 */

/**
 * @typedef {import('../utils/dynamicFetchExecutor.js').CommandConfig} CommandConfig
 */

/**
 * Configuration for the `/offsets` slash command.
 *
 * @type {CommandConfig}
 */
export default {
  /** Discord slash command name. */
  name: 'offsets',
  /** Slash command description, shown in the Discord client picker. */
  description: 'Fetch the latest C++ offsets header (offsets.hpp).',

  /** Upstream endpoint. */
  url: 'https://offsets.imtheo.lol/offsets.hpp',

  /** Filename Discord will display on the attachment. */
  filename: 'offsets.hpp',

  /** Embed accent color (Discord blurple-adjacent green). */
  embedColor: 0x00AE86,
  embedTitle: '📐 C++ Offsets Header',
  embedDescription: 'Latest `offsets.hpp` fetched from the upstream endpoint.',

  /**
   * Strict content-validation regex.
   *
   * A real C++ header MUST contain either `#pragma once` or a
   * `namespace` declaration. If the upstream host is ever compromised
   * and returns HTML / JSON, this regex will fail to match and the
   * executor will refuse to dispatch the file.
   */
  validationRegex: /(?:#pragma\s+once|namespace\s+\w+)/,
};
