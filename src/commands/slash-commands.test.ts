import { describe, it, expect, vi, beforeEach } from "vitest";
import { trySlashCommand } from "./slash-commands.js";
import type { SlashCommandContext } from "./slash-commands.js";
import type { NarrativeLine, StyleVariant } from "../types/tui.js";

// --- Minimal mocks for dependencies ---

vi.mock("../tools/git/index.js", () => ({
  queryCommitLog: vi.fn().mockResolvedValue("3 commits:\nabc1234 [auto] exchange 5 (2025-01-01 12:00)"),
  performRollback: vi.fn().mockResolvedValue({ restoredTo: "abc1234", timestamp: 0, summary: "ok" }),
}));

vi.mock("../agents/subagents/ooc-mode.js", () => ({
  createOOCSession: vi.fn().mockReturnValue({ send: vi.fn(), label: "OOC", tier: "medium" }),
}));

vi.mock("../agents/subagents/dev-mode.js", () => ({
  createDevSession: vi.fn().mockReturnValue({ send: vi.fn(), label: "Dev", tier: "medium" }),
  summarizeGameState: vi.fn().mockReturnValue("summary"),
}));

vi.mock("node:v8", () => ({
  default: { writeHeapSnapshot: vi.fn().mockReturnValue("heap-mock.heapsnapshot") },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn() };
});

import { writeFileSync } from "node:fs";
import v8 from "node:v8";

// Prevent process.exit from actually exiting (fallback path when onReturnToMenu not set)
vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

import { queryCommitLog, performRollback } from "../tools/git/index.js";
import { createOOCSession } from "../agents/subagents/ooc-mode.js";
import { createDevSession } from "../agents/subagents/dev-mode.js";

// --- Test helpers ---

function mockCtx(overrides?: Partial<SlashCommandContext>): SlashCommandContext {
  const mockRepo = {
    isEnabled: vi.fn().mockReturnValue(true),
    checkpoint: vi.fn().mockResolvedValue("abc1234567890"),
    getRepo: vi.fn(),
  };
  const mockSceneManager = {
    getFileIO: vi.fn().mockReturnValue({}),
    getSessionState: vi.fn().mockReturnValue({}),
  };
  const mockEngine = {
    getRepo: vi.fn().mockReturnValue(mockRepo),
    getSceneManager: vi.fn().mockReturnValue(mockSceneManager),
    transitionScene: vi.fn().mockResolvedValue(undefined),
  };
  return {
    engine: mockEngine as never,
    gameState: {
      campaignRoot: "/campaign",
      config: { name: "Test Campaign" },
      maps: {},
      clocks: { clocks: {} },
      combat: { active: false, combatants: [], roundNumber: 0 },
      combatConfig: { system: "default", initiativeStat: "dexterity", autoRoll: false },
      decks: { decks: {} },
      activePlayerIndex: 0,
      displayResources: {},
      resourceValues: {},
    } as never,
    client: {} as never,
    appendLine: vi.fn(),
    activeSession: null,
    setActiveSession: vi.fn(),
    variant: "exploration" as StyleVariant,
    setVariant: vi.fn(),
    previousVariant: "exploration" as StyleVariant,
    setPreviousVariant: vi.fn(),
    ...overrides,
  };
}

function lastAppended(ctx: SlashCommandContext): NarrativeLine {
  const calls = (ctx.appendLine as ReturnType<typeof vi.fn>).mock.calls;
  return calls[calls.length - 1][0] as NarrativeLine;
}

// --- Tests ---

describe("trySlashCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false for non-slash input", () => {
    const ctx = mockCtx();
    expect(trySlashCommand("hello", ctx)).toBe(false);
    expect(ctx.appendLine).not.toHaveBeenCalled();
  });

  it("returns false for empty slash", () => {
    const ctx = mockCtx();
    expect(trySlashCommand("/", ctx)).toBe(false);
  });

  it("returns true and shows error for unknown command", () => {
    const ctx = mockCtx();
    expect(trySlashCommand("/foo", ctx)).toBe(true);
    expect(lastAppended(ctx).text).toContain("Unknown command: /foo");
  });

  describe("/help", () => {
    it("lists all commands", () => {
      const ctx = mockCtx();
      trySlashCommand("/help", ctx);
      const text = lastAppended(ctx).text;
      expect(text).toContain("/help");
      expect(text).toContain("/save");
      expect(text).toContain("/log");
      expect(text).toContain("/rollback");
      expect(text).toContain("/scene");
      expect(text).toContain("/ooc");
      expect(text).toContain("/dev");
    });

    it("outputs as system line", () => {
      const ctx = mockCtx();
      trySlashCommand("/help", ctx);
      expect(lastAppended(ctx).kind).toBe("system");
    });
  });

  describe("/save", () => {
    it("calls checkpoint with default label", async () => {
      const ctx = mockCtx();
      trySlashCommand("/save", ctx);
      // Wait for async
      await vi.waitFor(() => {
        const repo = (ctx.engine as never as { getRepo(): { checkpoint: ReturnType<typeof vi.fn> } }).getRepo();
        expect(repo.checkpoint).toHaveBeenCalledWith("manual save");
      });
    });

    it("calls checkpoint with custom label", async () => {
      const ctx = mockCtx();
      trySlashCommand("/save my-label", ctx);
      await vi.waitFor(() => {
        const repo = (ctx.engine as never as { getRepo(): { checkpoint: ReturnType<typeof vi.fn> } }).getRepo();
        expect(repo.checkpoint).toHaveBeenCalledWith("my-label");
      });
    });

    it("shows saved confirmation with oid", async () => {
      const ctx = mockCtx();
      trySlashCommand("/save", ctx);
      await vi.waitFor(() => {
        expect(lastAppended(ctx).text).toContain("Saved: abc1234");
      });
    });

    it("shows no-changes when checkpoint returns null", async () => {
      const ctx = mockCtx();
      const repo = (ctx.engine as never as { getRepo(): { checkpoint: ReturnType<typeof vi.fn> } }).getRepo();
      repo.checkpoint.mockResolvedValue(null);
      trySlashCommand("/save", ctx);
      await vi.waitFor(() => {
        expect(lastAppended(ctx).text).toContain("No changes to save");
      });
    });

    it("shows unavailable when git disabled", () => {
      const ctx = mockCtx();
      const repo = (ctx.engine as never as { getRepo(): { isEnabled: ReturnType<typeof vi.fn> } }).getRepo();
      repo.isEnabled.mockReturnValue(false);
      trySlashCommand("/save", ctx);
      expect(lastAppended(ctx).text).toContain("unavailable");
    });

    it("shows unavailable when no engine", () => {
      const ctx = mockCtx({ engine: null });
      trySlashCommand("/save", ctx);
      expect(lastAppended(ctx).text).toContain("unavailable");
    });
  });

  describe("/log", () => {
    it("calls queryCommitLog with default depth", async () => {
      const ctx = mockCtx();
      trySlashCommand("/log", ctx);
      await vi.waitFor(() => {
        const repo = (ctx.engine as never as { getRepo(): unknown }).getRepo();
        expect(queryCommitLog).toHaveBeenCalledWith(repo, { depth: undefined });
      });
    });

    it("passes numeric depth", async () => {
      const ctx = mockCtx();
      trySlashCommand("/log 5", ctx);
      await vi.waitFor(() => {
        const repo = (ctx.engine as never as { getRepo(): unknown }).getRepo();
        expect(queryCommitLog).toHaveBeenCalledWith(repo, { depth: 5 });
      });
    });

    it("shows usage for non-numeric depth", () => {
      const ctx = mockCtx();
      trySlashCommand("/log abc", ctx);
      expect(lastAppended(ctx).text).toContain("Usage");
    });

    it("shows unavailable when git disabled", () => {
      const ctx = mockCtx();
      const repo = (ctx.engine as never as { getRepo(): { isEnabled: ReturnType<typeof vi.fn> } }).getRepo();
      repo.isEnabled.mockReturnValue(false);
      trySlashCommand("/log", ctx);
      expect(lastAppended(ctx).text).toContain("unavailable");
    });
  });

  describe("/rollback", () => {
    it("calls performRollback with correct target", async () => {
      const ctx = mockCtx();
      trySlashCommand("/rollback 3", ctx);
      await vi.waitFor(() => {
        const repo = (ctx.engine as never as { getRepo(): unknown }).getRepo();
        expect(performRollback).toHaveBeenCalledWith(repo, "exchanges_ago:3", "/campaign", expect.anything());
      });
    });

    it("calls onRollbackComplete with summary when available", async () => {
      const onRollbackComplete = vi.fn();
      const onReturnToMenu = vi.fn();
      const ctx = mockCtx({ onRollbackComplete, onReturnToMenu });
      trySlashCommand("/rollback 3", ctx);
      await vi.waitFor(() => {
        expect(onRollbackComplete).toHaveBeenCalledWith("ok");
        expect(onReturnToMenu).not.toHaveBeenCalled();
      });
    });

    it("falls back to onReturnToMenu when onRollbackComplete not set", async () => {
      const onReturnToMenu = vi.fn();
      const ctx = mockCtx({ onReturnToMenu });
      trySlashCommand("/rollback 3", ctx);
      await vi.waitFor(() => {
        expect(onReturnToMenu).toHaveBeenCalled();
      });
    });

    it("shows usage when no argument", () => {
      const ctx = mockCtx();
      trySlashCommand("/rollback", ctx);
      expect(lastAppended(ctx).text).toContain("Usage");
    });

    it("shows usage for non-numeric argument", () => {
      const ctx = mockCtx();
      trySlashCommand("/rollback abc", ctx);
      expect(lastAppended(ctx).text).toContain("Usage");
    });

    it("shows usage for zero", () => {
      const ctx = mockCtx();
      trySlashCommand("/rollback 0", ctx);
      expect(lastAppended(ctx).text).toContain("Usage");
    });

    it("shows unavailable when git disabled", () => {
      const ctx = mockCtx();
      const repo = (ctx.engine as never as { getRepo(): { isEnabled: ReturnType<typeof vi.fn> } }).getRepo();
      repo.isEnabled.mockReturnValue(false);
      trySlashCommand("/rollback 3", ctx);
      expect(lastAppended(ctx).text).toContain("unavailable");
    });
  });

  describe("/scene", () => {
    it("calls transitionScene with title", async () => {
      const ctx = mockCtx();
      trySlashCommand("/scene The Market", ctx);
      await vi.waitFor(() => {
        expect((ctx.engine as never as { transitionScene: ReturnType<typeof vi.fn> }).transitionScene)
          .toHaveBeenCalledWith("The Market");
      });
    });

    it("shows acknowledgement", () => {
      const ctx = mockCtx();
      trySlashCommand("/scene The Market", ctx);
      expect(lastAppended(ctx).text).toContain("Transitioning: The Market");
    });

    it("shows usage when no title", () => {
      const ctx = mockCtx();
      trySlashCommand("/scene", ctx);
      expect(lastAppended(ctx).text).toContain("Usage");
    });

    it("shows unavailable when no engine", () => {
      const ctx = mockCtx({ engine: null });
      trySlashCommand("/scene Foo", ctx);
      expect(lastAppended(ctx).text).toContain("unavailable");
    });
  });

  describe("/ooc", () => {
    it("enters OOC mode", () => {
      const ctx = mockCtx();
      trySlashCommand("/ooc", ctx);
      expect(createOOCSession).toHaveBeenCalled();
      expect(ctx.setActiveSession).toHaveBeenCalled();
      expect(ctx.setVariant).toHaveBeenCalledWith("ooc");
      expect(ctx.setPreviousVariant).toHaveBeenCalledWith("exploration");
    });

    it("exits OOC when already in OOC", () => {
      const ctx = mockCtx({
        activeSession: { send: vi.fn() as never, label: "OOC", tier: "medium" as const },
      });
      trySlashCommand("/ooc", ctx);
      expect(ctx.setActiveSession).toHaveBeenCalledWith(null);
      expect(lastAppended(ctx).text).toContain("Exiting OOC Mode");
    });

    it("shows unavailable when no client", () => {
      const ctx = mockCtx({ client: null });
      trySlashCommand("/ooc", ctx);
      expect(lastAppended(ctx).text).toContain("unavailable");
    });
  });

  describe("/dev", () => {
    it("enters Dev mode", () => {
      const ctx = mockCtx();
      trySlashCommand("/dev", ctx);
      expect(createDevSession).toHaveBeenCalled();
      expect(ctx.setActiveSession).toHaveBeenCalled();
      expect(ctx.setVariant).toHaveBeenCalledWith("dev");
      expect(ctx.setPreviousVariant).toHaveBeenCalledWith("exploration");
    });

    it("exits Dev when already in Dev", () => {
      const ctx = mockCtx({
        activeSession: { send: vi.fn() as never, label: "Dev", tier: "medium" as const },
      });
      trySlashCommand("/dev", ctx);
      expect(ctx.setActiveSession).toHaveBeenCalledWith(null);
      expect(lastAppended(ctx).text).toContain("Exiting Dev Mode");
    });

    it("exits OOC and enters Dev when in OOC", () => {
      const ctx = mockCtx({
        activeSession: { send: vi.fn() as never, label: "OOC", tier: "medium" as const },
      });
      trySlashCommand("/dev", ctx);
      // Should have exited OOC first
      expect(ctx.setActiveSession).toHaveBeenCalledWith(null);
      // Then entered Dev
      expect(createDevSession).toHaveBeenCalled();
    });
  });

  describe("/snapshot", () => {
    it("writes a heap snapshot file", () => {
      const ctx = mockCtx();
      trySlashCommand("/snapshot", ctx);

      expect(v8.writeHeapSnapshot).toHaveBeenCalled();
      expect(writeFileSync).toHaveBeenCalled();
      const text = lastAppended(ctx).text;
      expect(text).toContain("Heap snapshot written");
    });

    it("reports error when snapshot fails", () => {
      const ctx = mockCtx();
      vi.mocked(writeFileSync).mockImplementationOnce(() => {
        throw new Error("ENOSPC");
      });

      trySlashCommand("/snapshot", ctx);

      const text = lastAppended(ctx).text;
      expect(text).toContain("Snapshot failed");
      expect(text).toContain("ENOSPC");
    });

    it("appears in /help output", () => {
      const ctx = mockCtx();
      trySlashCommand("/help", ctx);
      expect(lastAppended(ctx).text).toContain("/snapshot");
    });
  });

  describe("/retry", () => {
    it("shows unavailable when no engine", () => {
      const ctx = mockCtx({ engine: null });
      trySlashCommand("/retry", ctx);
      expect(lastAppended(ctx).text).toContain("unavailable");
    });

    it("retries last failed turn when pending retry exists", () => {
      const retryLastTurn = vi.fn();
      const hasPendingRetry = vi.fn().mockReturnValue(true);
      const ctx = mockCtx();
      Object.assign(ctx.engine!, { retryLastTurn, hasPendingRetry });
      trySlashCommand("/retry", ctx);
      expect(retryLastTurn).toHaveBeenCalled();
    });

    it("pops last exchange and retries when no pending error", () => {
      const retryLastExchange = vi.fn().mockReturnValue(true);
      const hasPendingRetry = vi.fn().mockReturnValue(false);
      const ctx = mockCtx();
      Object.assign(ctx.engine!, { retryLastExchange, hasPendingRetry });
      trySlashCommand("/retry", ctx);
      expect(retryLastExchange).toHaveBeenCalled();
      expect(lastAppended(ctx).text).toContain("Retrying last turn");
    });

    it("shows nothing-to-retry when no history", () => {
      const retryLastExchange = vi.fn().mockReturnValue(false);
      const hasPendingRetry = vi.fn().mockReturnValue(false);
      const ctx = mockCtx();
      Object.assign(ctx.engine!, { retryLastExchange, hasPendingRetry });
      trySlashCommand("/retry", ctx);
      expect(lastAppended(ctx).text).toContain("Nothing to retry");
    });

    it("appears in /help output", () => {
      const ctx = mockCtx();
      trySlashCommand("/help", ctx);
      expect(lastAppended(ctx).text).toContain("/retry");
    });
  });

  describe("/swatch", () => {
    it("invokes setActiveModal with swatch kind", () => {
      const setActiveModal = vi.fn();
      const ctx = mockCtx({ setActiveModal });
      trySlashCommand("/swatch", ctx);
      expect(setActiveModal).toHaveBeenCalledWith({ kind: "swatch" });
    });

    it("appends fallback system message when setActiveModal is absent", () => {
      const ctx = mockCtx();
      // setActiveModal is not in the default mockCtx
      trySlashCommand("/swatch", ctx);
      expect(lastAppended(ctx).text).toContain("Swatch modal unavailable");
      expect(lastAppended(ctx).kind).toBe("system");
    });

    it("appears in /help output", () => {
      const ctx = mockCtx();
      trySlashCommand("/help", ctx);
      expect(lastAppended(ctx).text).toContain("/swatch");
    });
  });

  it("is case-insensitive for command names", () => {
    const ctx = mockCtx();
    expect(trySlashCommand("/HELP", ctx)).toBe(true);
    expect(lastAppended(ctx).text).toContain("/help");
  });
});
