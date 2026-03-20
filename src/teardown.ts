import { gracefulShutdown } from "./shutdown.js";
import type { ShutdownContext } from "./shutdown.js";
import { resetPromptCache } from "./prompts/load-prompt.js";
import { resetThemeCache } from "./tui/themes/index.js";
import { resetDevMode } from "./config/dev-mode.js";
import { resetContextDump } from "./config/context-dump.js";
import { loadModelConfig, loadPricingConfig } from "./config/models.js";

/**
 * Error thrown when a rollback completes and the game should return to menu.
 * This propagates through agent loops / subagent sessions to signal the UI.
 */
export class RollbackCompleteError extends Error {
  constructor(public readonly summary: string) {
    super(`Rollback complete: ${summary}`);
    this.name = "RollbackCompleteError";
  }
}

/**
 * Error thrown when the API content classifier refuses a response.
 * Signals the engine to skip persistence and show a gentle system message
 * instead of the standard error treatment.
 */
export class ContentRefusalError extends Error {
  /** Usage from the refused API call (still costs money). */
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };

  constructor() {
    super("Content classifier refused the response");
    this.name = "ContentRefusalError";
  }
}

/**
 * Full teardown for returning to menu: persist state, commit, reset caches.
 */
export async function teardownGameSession(ctx: ShutdownContext): Promise<void> {
  await gracefulShutdown(ctx);
  resetAllCaches();
}

/**
 * Reset all module-level caches so a fresh campaign can be loaded cleanly.
 */
export function resetAllCaches(): void {
  resetPromptCache();
  resetThemeCache();
  resetDevMode();
  resetContextDump();
  loadModelConfig({ reset: true });
  loadPricingConfig({ reset: true });
}
