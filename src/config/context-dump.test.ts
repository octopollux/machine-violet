import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  dumpContext,
  dumpThinking,
  setContextDumpDir,
  getContextDumpDir,
  resetContextDump,
} from "./context-dump.js";
import { resetDevMode } from "./dev-mode.js";

// Mock fs/promises so dumpContext doesn't write to disk
vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
}));

beforeEach(() => {
  resetContextDump();
  resetDevMode();
});

afterEach(() => {
  delete process.env.DEV_MODE;
  resetContextDump();
  resetDevMode();
});

// --- dumpContext guards ---

describe("dumpContext", () => {
  it("is a no-op when dev mode is off", async () => {
    const { writeFile } = await import("node:fs/promises");
    delete process.env.DEV_MODE;
    resetDevMode();
    setContextDumpDir("/tmp/test-dump");

    dumpContext("dm", {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: "sys",
      messages: [],
    });

    expect(writeFile).not.toHaveBeenCalled();
  });

  it("is a no-op when dump dir is not set", async () => {
    const { writeFile } = await import("node:fs/promises");
    process.env.DEV_MODE = "true";
    resetDevMode();

    dumpContext("dm", {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: "sys",
      messages: [],
    });

    expect(writeFile).not.toHaveBeenCalled();
  });

  it("writes raw JSON with .json extension", async () => {
    const { writeFile } = await import("node:fs/promises");
    (writeFile as ReturnType<typeof vi.fn>).mockClear();
    process.env.DEV_MODE = "true";
    resetDevMode();
    setContextDumpDir("/tmp/test-dump");

    dumpContext("dm", {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: "You are a DM.",
      messages: [{ role: "user", content: "Hello" }],
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining("dm.json"),
      expect.any(String),
      "utf-8",
    );

    const written = (writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.agent).toBe("dm");
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.model).toBe("claude-opus-4-6");
    expect(parsed.max_tokens).toBe(4096);
    expect(parsed.system).toBe("You are a DM.");
    expect(parsed.messages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("preserves all fields including unknown ones", async () => {
    const { writeFile } = await import("node:fs/promises");
    (writeFile as ReturnType<typeof vi.fn>).mockClear();
    process.env.DEV_MODE = "true";
    resetDevMode();
    setContextDumpDir("/tmp/test-dump");

    dumpContext("dm", {
      model: "claude-opus-4-6",
      max_tokens: 10240,
      system: "sys",
      messages: [],
      thinking: { type: "enabled", budget_tokens: 2048 },
      tools: [{ name: "roll_dice", description: "Roll dice." }],
      some_future_field: "preserved",
    });

    await new Promise((r) => setTimeout(r, 10));

    const written = (writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(parsed.tools).toEqual([{ name: "roll_dice", description: "Roll dice." }]);
    expect(parsed.some_future_field).toBe("preserved");
  });
});

// --- dumpThinking ---

describe("dumpThinking", () => {
  it("is a no-op when dev mode is off", async () => {
    const { writeFile } = await import("node:fs/promises");
    (writeFile as ReturnType<typeof vi.fn>).mockClear();
    delete process.env.DEV_MODE;
    resetDevMode();
    setContextDumpDir("/tmp/test-dump");

    dumpThinking("dm", 0, "Let me think about this...");

    expect(writeFile).not.toHaveBeenCalled();
  });

  it("is a no-op when dump dir is not set", async () => {
    const { writeFile } = await import("node:fs/promises");
    (writeFile as ReturnType<typeof vi.fn>).mockClear();
    process.env.DEV_MODE = "true";
    resetDevMode();

    dumpThinking("dm", 0, "Let me think about this...");

    expect(writeFile).not.toHaveBeenCalled();
  });

  it("writes thinking to {agent}-thinking.json", async () => {
    const { writeFile } = await import("node:fs/promises");
    (writeFile as ReturnType<typeof vi.fn>).mockClear();
    process.env.DEV_MODE = "true";
    resetDevMode();
    setContextDumpDir("/tmp/test-dump");

    dumpThinking("dm", 2, "The player wants to enter the cave...");

    await new Promise((r) => setTimeout(r, 10));

    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining("dm-thinking.json"),
      expect.any(String),
      "utf-8",
    );

    const written = (writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.agent).toBe("dm");
    expect(parsed.round).toBe(2);
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.thinking).toBe("The player wants to enter the cave...");
  });
});

// --- State management ---

describe("setContextDumpDir / resetContextDump", () => {
  it("sets and gets dump dir", () => {
    expect(getContextDumpDir()).toBeNull();
    setContextDumpDir("/some/dir");
    expect(getContextDumpDir()).toBe("/some/dir");
  });

  it("resets dump dir", () => {
    setContextDumpDir("/some/dir");
    resetContextDump();
    expect(getContextDumpDir()).toBeNull();
  });
});
