import { describe, it, expect, vi } from "vitest";
import type { ShutdownContext } from "./shutdown.js";
import { gracefulShutdown } from "./shutdown.js";
import type { GameEngine } from "./agents/game-engine.js";
import type { SceneManager, SceneState, FileIO } from "./agents/scene-manager.js";

// --- Mock helpers ---

function mockFileIO(): FileIO {
  return {
    readFile: vi.fn().mockResolvedValue(""),
    writeFile: vi.fn().mockResolvedValue(undefined),
    appendFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    listDir: vi.fn().mockResolvedValue([]),
  };
}

function mockScene(transcript: string[] = []): SceneState {
  return {
    sceneNumber: 1,
    slug: "opening",
    transcript,
    precis: "",
    openThreads: "",
    npcIntents: "",

    playerReads: [],
    sessionNumber: 1,
  };
}

function mockSceneManager(scene: SceneState): SceneManager {
  return {
    getScene: () => scene,
  } as unknown as SceneManager;
}

function mockEngine(scene: SceneState): GameEngine {
  return {
    getSceneManager: () => mockSceneManager(scene),
    getState: () => "idle",
  } as unknown as GameEngine;
}

// --- Tests ---

describe("gracefulShutdown", () => {
  it("exits cleanly with no engine", async () => {
    // Should not throw
    await gracefulShutdown({});
  });

  it("exits cleanly with engine but empty transcript", async () => {
    const scene = mockScene([]);
    const fio = mockFileIO();
    const ctx: ShutdownContext = {
      engine: mockEngine(scene),
      campaignRoot: "/tmp/campaign",
      fileIO: fio,
    };

    await gracefulShutdown(ctx);

    // No transcript to write
    expect(fio.writeFile).not.toHaveBeenCalled();
  });

  it("writes transcript on shutdown when engine has content", async () => {
    const scene = mockScene(["**[Kael]** Hello", "**DM:** Welcome, traveler."]);
    const fio = mockFileIO();
    const ctx: ShutdownContext = {
      engine: mockEngine(scene),
      campaignRoot: "/tmp/campaign",
      fileIO: fio,
    };

    await gracefulShutdown(ctx);

    expect(fio.mkdir).toHaveBeenCalled();
    expect(fio.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("transcript.md"),
      expect.stringContaining("Welcome, traveler."),
    );
  });

  it("does not crash if fileIO write fails", async () => {
    const scene = mockScene(["some text"]);
    const fio = mockFileIO();
    (fio.mkdir as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("disk full"));

    const ctx: ShutdownContext = {
      engine: mockEngine(scene),
      campaignRoot: "/tmp/campaign",
      fileIO: fio,
    };

    // Should not throw
    await gracefulShutdown(ctx);
  });

  it("commits via git when gitEnabled", async () => {
    const scene = mockScene([]);
    const commitFn = vi.fn().mockResolvedValue("abc123");
    const statusMatrixFn = vi.fn()
      .mockResolvedValueOnce([["file.md", 1, 2, 1]])  // stageAll sees dirty workdir
      .mockResolvedValueOnce([["file.md", 1, 2, 2]]); // commitIfDirty sees staged
    const gitIO = {
      init: vi.fn().mockResolvedValue(undefined),
      add: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      commit: commitFn,
      log: vi.fn().mockResolvedValue([]),
      checkout: vi.fn().mockResolvedValue(undefined),
      statusMatrix: statusMatrixFn,
      listFiles: vi.fn().mockResolvedValue([]),
    };

    const ctx: ShutdownContext = {
      engine: mockEngine(scene),
      campaignRoot: "/tmp/campaign",
      fileIO: mockFileIO(),
      gitEnabled: true,
      gitIO,
    };

    await gracefulShutdown(ctx);

    // Should have attempted to commit
    expect(gitIO.statusMatrix).toHaveBeenCalled();
    expect(commitFn).toHaveBeenCalled();
  });
});
