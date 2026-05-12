/**
 * Regression guards for handleCommand.
 *
 * - /rollback must return endSessionReason: "rollback" so session-manager
 *   .endSession skips its flush+checkpoint block — otherwise the in-memory
 *   ConversationManager (still ahead of the rollback target by the undone
 *   turns) gets persisted back to disk and silently undoes the rollback
 *   for whole-file state like conversation.json and scene.json.
 *
 * - /ooc must thread `gameState` into the OOC session. Without it,
 *   `hasGameState` is false inside `buildOOCTools`, the DM-tier tool
 *   bundle (scribe, promote_character, roll_dice, etc.) is never
 *   registered, and the agent — correctly — tells the player it
 *   doesn't have those tools, contradicting the OOC system prompt
 *   which directs it to use scribe for entity corrections.
 */
import { describe, it, expect, vi } from "vitest";
import { handleCommand } from "./command-handler.js";
import type { GameEngine } from "../agents/game-engine.js";
import type { GameState } from "@machine-violet/shared/types/engine.js";

// vi.mock is hoisted; the mocks must not close over outer-scope variables.
vi.mock("../agents/subagents/ooc-mode.js", () => ({
  createOOCSession: vi.fn(() => ({ label: "OOC", tier: "medium", send: vi.fn() })),
}));
vi.mock("../agents/subagents/dev-mode.js", () => ({
  createDevSession: vi.fn(() => ({ label: "Dev", tier: "medium", send: vi.fn() })),
  summarizeGameState: vi.fn(() => "stub-summary"),
}));

const { createOOCSession } = await import("../agents/subagents/ooc-mode.js");

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
    getSessionState: () => ({}),
    getSystemPrompt: () => ({ system: [], volatile: "## Current State\nstub", hardStats: "" }),
  };
  return {
    getRepo: () => repo,
    getSceneManager: () => sceneManager,
    getTier: vi.fn((tier: string) => ({
      provider: { providerId: "test", chat: vi.fn(), stream: vi.fn(), healthCheck: vi.fn() },
      model: tier === "small" ? "claude-haiku-4-5-20251001" : "claude-sonnet-4-6",
    })),
    getPreviousVariant: vi.fn(() => "exploration"),
    getModeSession: vi.fn(() => null),
    setModeSession: vi.fn(),
    getRegistry: vi.fn(() => ({ getDefinitions: () => [] })),
    handleAsyncTool: vi.fn(async () => null),
    applyDeferredTuiCommands: vi.fn(async () => {}),
    dispatchImmediateTuiCommand: vi.fn(),
  } as unknown as GameEngine;
}

function makeMockGameState(): GameState {
  return {
    campaignRoot: "/tmp/test-campaign",
    config: { name: "Test Campaign" },
  } as unknown as GameState;
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

describe("handleCommand /ooc", () => {
  it("passes gameState into createOOCSession so DM-tier tools register", async () => {
    vi.mocked(createOOCSession).mockClear();
    const engine = makeMockEngine();
    const gs = makeMockGameState();

    await handleCommand("ooc", "", engine, gs, vi.fn());

    expect(createOOCSession).toHaveBeenCalledOnce();
    const [, options] = vi.mocked(createOOCSession).mock.calls[0];
    // The whole point: gameState must be threaded through. Without it the
    // OOC tool registration's `if (hasGameState)` branch falls through and
    // scribe/promote_character/roll_dice/etc. are silently dropped.
    expect(options.gameState).toBe(gs);
    // Sanity: the other call-site invariants we depend on are also intact.
    expect(options.smallTier).toBeDefined();
    expect(options.model).toBeDefined();
    expect(options.fileIO).toBeDefined();
    expect(options.campaignRoot).toBe("/tmp/test-campaign");
  });
});
