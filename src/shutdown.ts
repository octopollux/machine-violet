import type { GameEngine } from "./agents/game-engine.js";
import type { CampaignRepo } from "./tools/git/campaign-repo.js";

/**
 * Context needed for graceful shutdown.
 */
export interface ShutdownContext {
  engine?: GameEngine;
  repo?: CampaignRepo;
}

/**
 * Graceful shutdown: finalize transcript and commit if git enabled.
 * Caller is responsible for process.exit after this resolves.
 */
export async function gracefulShutdown(ctx: ShutdownContext): Promise<void> {
  // 1. If engine exists, finalize transcript and persist state to disk
  if (ctx.engine) {
    try {
      await ctx.engine.getSceneManager().flushTranscript();
    } catch {
      // Best-effort — don't crash on shutdown
    }

    // Flush any pending display-log writes
    try {
      const persister = ctx.engine.getPersister();
      if (persister) {
        await persister.flush();
      }
    } catch {
      // Best-effort
    }
  }

  // 2. If git enabled, commit current state
  if (ctx.repo) {
    try {
      await ctx.repo.sessionCommit(0);
    } catch {
      // Best-effort
    }
  }
}
