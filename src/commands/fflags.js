/**
 * @file fflags.js
 * @module commands/fflags
 *
 * THIN COMMAND CONFIG — no fetch/cache/dispatch logic lives here.
 *
 * Per the architecture spec, this file exports ONLY a declarative
 * configuration object that is consumed by `dynamicFetchExecutor`.
 */

/**
 * @typedef {import('../utils/dynamicFetchExecutor.js').CommandConfig} CommandConfig
 */

/**
 * Configuration for the `/fflags` slash command.
 *
 * @type {CommandConfig}
 */
export default {
  /** Discord slash command name. */
  name: 'fflags',
  /** Slash command description, shown in the Discord client picker. */
  description: 'Fetch the latest C# FFlags script (fflags.cs).',

  /** Upstream endpoint. */
  url: 'https://offsets.imtheo.lol/fflags.cs',

  /** Filename Discord will display on the attachment. */
  filename: 'fflags.cs',

  /** Embed accent color (Discord blurple-adjacent purple). */
  embedColor: 0x9B59B6,
  embedTitle: '🔧 C# FFlags Script',
  embedDescription: 'Latest `fflags.cs` fetched from the upstream endpoint.',

  /**
   * Strict content-validation regex.
   *
   * A real C# source file MUST contain either a `public class`
   * declaration or a `using System;` directive. If the upstream host
   * is ever compromised and returns HTML / JSON, this regex will fail
   * to match and the executor will refuse to dispatch the file.
   */
  validationRegex: /(?:public\s+class|using\s+System\s*;)/,
};
