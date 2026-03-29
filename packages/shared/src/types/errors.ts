/**
 * Error classes shared between engine and client.
 */

/**
 * Error thrown when a rollback completes and the game should return to menu.
 * Propagates through agent loops / subagent sessions to signal the UI.
 */
export class RollbackCompleteError extends Error {
  constructor(public readonly summary: string) {
    super(`Rollback complete: ${summary}`);
    this.name = "RollbackCompleteError";
  }
}

/**
 * Error thrown when the API content classifier refuses a response.
 * Signals the engine to skip persistence and show a gentle system message.
 */
export class ContentRefusalError extends Error {
  /** Usage from the refused API call (still costs money). */
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };

  constructor() {
    super("Content classifier refused the response");
    this.name = "ContentRefusalError";
  }
}
