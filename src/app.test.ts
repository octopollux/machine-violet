import { describe, it, expect, vi } from "vitest";
import type { ShutdownContext } from "./shutdown.js";
import { gracefulShutdown } from "./shutdown.js";
import type { GameEngine } from "./agents/game-engine.js";
import type { SceneManager } from "./agents/scene-manager.js";
import type { CampaignRepo } from "./tools/git/campaign-repo.js";

// --- Mock helpers ---

function mockSceneManager(opts?: { flushThrows?: boolean }): SceneManager {
  const flushTranscript = opts?.flushThrows
    ? vi.fn().mockRejectedValue(new Error("disk full"))
    : vi.fn().mockResolvedValue(undefined);
  return { flushTranscript } as unknown as SceneManager;
}

function mockEngine(sm?: SceneManager): GameEngine {
  return {
    getSceneManager: () => sm ?? mockSceneManager(),
    getPersister: () => ({ flush: vi.fn().mockResolvedValue(undefined) }),
    getState: () => "idle",
  } as unknown as GameEngine;
}

function mockRepo(opts?: { commitThrows?: boolean }): CampaignRepo {
  const sessionCommit = opts?.commitThrows
    ? vi.fn().mockRejectedValue(new Error("git error"))
    : vi.fn().mockResolvedValue("abc123");
  return { sessionCommit } as unknown as CampaignRepo;
}

// --- Tests ---

describe("gracefulShutdown", () => {
  it("exits cleanly with no engine", async () => {
    await gracefulShutdown({});
  });

  it("flushes transcript via scene manager", async () => {
    const sm = mockSceneManager();
    const engine = mockEngine(sm);
    const ctx: ShutdownContext = { engine };

    await gracefulShutdown(ctx);

    expect(sm.flushTranscript).toHaveBeenCalled();
  });

  it("does not crash if flushTranscript fails", async () => {
    const sm = mockSceneManager({ flushThrows: true });
    const engine = mockEngine(sm);
    const ctx: ShutdownContext = { engine };

    // Should not throw
    await gracefulShutdown(ctx);
  });

  it("commits via repo when provided", async () => {
    const repo = mockRepo();
    const ctx: ShutdownContext = { engine: mockEngine(), repo };

    await gracefulShutdown(ctx);

    expect(repo.sessionCommit).toHaveBeenCalledWith(0);
  });

  it("does not crash if repo commit fails", async () => {
    const repo = mockRepo({ commitThrows: true });
    const ctx: ShutdownContext = { engine: mockEngine(), repo };

    // Should not throw
    await gracefulShutdown(ctx);
  });
});
