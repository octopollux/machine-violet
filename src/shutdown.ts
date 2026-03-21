import type { GameEngine } from "./agents/game-engine.js";
import type { FileIO } from "./agents/scene-manager.js";
import { norm } from "./utils/paths.js";
import { CampaignRepo } from "./tools/git/campaign-repo.js";
import type { GitIO } from "./tools/git/campaign-repo.js";

/**
 * Context needed for graceful shutdown.
 */
export interface ShutdownContext {
  engine?: GameEngine;
  campaignRoot?: string;
  fileIO?: FileIO;
  gitEnabled?: boolean;
  gitIO?: GitIO;
  /** Discord Rich Presence handle for cleanup on shutdown. */
  discordPresence?: { stop(): Promise<void> };
}

/**
 * Graceful shutdown: finalize transcript and commit if git enabled.
 * Caller is responsible for process.exit after this resolves.
 */
export async function gracefulShutdown(ctx: ShutdownContext): Promise<void> {
  // 1. If engine exists, finalize transcript and persist conversation to disk
  if (ctx.engine && ctx.campaignRoot) {
    try {
      const sm = ctx.engine.getSceneManager();
      const scene = sm.getScene();
      if (scene.transcript.length > 0 && ctx.fileIO) {
        // Write transcript via scene manager's existing finalize path
        // We replicate the logic here since finalizeTranscript is private
        const { sceneDir } = await import("./tools/filesystem/index.js");
        const dir = sceneDir(ctx.campaignRoot, scene.sceneNumber, scene.slug || "untitled");
        await ctx.fileIO.mkdir(dir);
        const transcriptPath = norm(dir) + "/transcript.md";
        const content = `# Scene ${scene.sceneNumber}\n\n${scene.transcript.join("\n\n")}\n`;
        await ctx.fileIO.writeFile(transcriptPath, content);
      }
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
  if (ctx.gitEnabled && ctx.campaignRoot && ctx.gitIO) {
    try {
      const repo = new CampaignRepo({
        dir: ctx.campaignRoot,
        git: ctx.gitIO,
        enabled: true,
      });
      await repo.sessionCommit(0);
    } catch {
      // Best-effort
    }
  }

  // 3. Disconnect Discord Rich Presence
  try {
    await ctx.discordPresence?.stop();
  } catch {
    // Best-effort
  }
}
