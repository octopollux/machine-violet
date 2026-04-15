/**
 * Regression guard: /rollback must return endSessionReason: "rollback"
 * so session-manager.endSession skips its flush+checkpoint block — otherwise
 * the in-memory ConversationManager (still ahead of the rollback target by
 * the undone turns) gets persisted back to disk and silently undoes the
 * rollback for whole-file state like conversation.json and scene.json.
 */
import { describe, it, expect, vi } from "vitest";
import { handleCommand } from "./command-handler.js";
import type { GameEngine } from "../agents/game-engine.js";
import type { GameState } from "@machine-violet/shared/types/engine.js";

function makeMockEngine(performRollback = true) {
  const repo = {
    isEnabled: () => performRollback,
    rollback: vi.fn(async () => ({
      restoredTo: "abc1234",
      timestamp: 1234567890,
      summary: "scene: Opening",
    })),
  };
  const sceneManager = {
    getFileIO: () => ({
      exists: async () => true,
      listDir: async () => [],
      readFile: async () => "",
      writeFile: async () => {},
      appendFile: async () => {},
      mkdir: async () => {},
    }),
  };
  return {
    getRepo: () => repo,
    getSceneManager: () => sceneManager,
  } as unknown as GameEngine;
}

function makeMockGameState(): GameState {
  return { campaignRoot: "/tmp/test-campaign" } as unknown as GameState;
}

describe("handleCommand /rollback", () => {
  it("returns endSessionReason: 'rollback' so endSession skips persist+checkpoint", async () => {
    const engine = makeMockEngine();
    const result = await handleCommand(
      "rollback",
      "1",
      engine,
      makeMockGameState(),
      vi.fn(),
    );
    expect(result.endSession).toBe(true);
    expect(result.endSessionReason).toBe("rollback");
  });

  it("rejects invalid N with a usage error (no endSession)", async () => {
    const engine = makeMockEngine();
    const result = await handleCommand(
      "rollback",
      "not-a-number",
      engine,
      makeMockGameState(),
      vi.fn(),
    );
    expect(result.error).toBe(true);
    expect(result.endSession).toBeFalsy();
    expect(result.endSessionReason).toBeUndefined();
  });
});
