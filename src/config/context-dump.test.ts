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

// --- Thinking accumulation ---

describe("thinking accumulation into dumpContext", () => {
  it("includes _thinking_trace from prior dumpThinking calls", async () => {
    const { writeFile } = await import("node:fs/promises");
    (writeFile as ReturnType<typeof vi.fn>).mockClear();
    process.env.DEV_MODE = "true";
    resetDevMode();
    setContextDumpDir("/tmp/test-dump");

    // Simulate: dumpContext(round 1) → API call → dumpThinking(round 1) → dumpContext(round 2)
    dumpContext("dm", { model: "test", messages: [], round: 1 });
    dumpThinking("dm", 1, "Thinking about round 1...");
    dumpContext("dm", { model: "test", messages: [], round: 2 });

    await new Promise((r) => setTimeout(r, 10));

    // Find the second dumpContext call (writes to dm.json)
    const contextCalls = (writeFile as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).endsWith("dm.json"),
    );
    expect(contextCalls.length).toBe(2);

    // First context dump should have no traces (nothing accumulated yet)
    const first = JSON.parse(contextCalls[0][1] as string);
    expect(first._thinking_trace).toBeUndefined();

    // Second context dump should include the thinking from round 1
    const second = JSON.parse(contextCalls[1][1] as string);
    expect(second._thinking_trace).toHaveLength(1);
    expect(second._thinking_trace[0].round).toBe(1);
    expect(second._thinking_trace[0].thinking).toBe("Thinking about round 1...");
    expect(second._thinking_trace[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("accumulates multiple thinking blocks", async () => {
    const { writeFile } = await import("node:fs/promises");
    (writeFile as ReturnType<typeof vi.fn>).mockClear();
    process.env.DEV_MODE = "true";
    resetDevMode();
    setContextDumpDir("/tmp/test-dump");

    dumpThinking("dm", 1, "First thought");
    dumpThinking("dm", 2, "Second thought");
    dumpContext("dm", { model: "test", messages: [] });

    await new Promise((r) => setTimeout(r, 10));

    const contextCalls = (writeFile as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).endsWith("dm.json"),
    );
    const parsed = JSON.parse(contextCalls[0][1] as string);
    expect(parsed._thinking_trace).toHaveLength(2);
    expect(parsed._thinking_trace[0].thinking).toBe("First thought");
    expect(parsed._thinking_trace[1].thinking).toBe("Second thought");
  });

  it("drains the accumulator after dumpContext", async () => {
    const { writeFile } = await import("node:fs/promises");
    (writeFile as ReturnType<typeof vi.fn>).mockClear();
    process.env.DEV_MODE = "true";
    resetDevMode();
    setContextDumpDir("/tmp/test-dump");

    dumpThinking("dm", 1, "Some thought");
    dumpContext("dm", { model: "test", messages: [] });
    // Second dump should have no traces
    dumpContext("dm", { model: "test", messages: [] });

    await new Promise((r) => setTimeout(r, 10));

    const contextCalls = (writeFile as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).endsWith("dm.json"),
    );
    const first = JSON.parse(contextCalls[0][1] as string);
    const second = JSON.parse(contextCalls[1][1] as string);
    expect(first._thinking_trace).toHaveLength(1);
    expect(second._thinking_trace).toBeUndefined();
  });

  it("keeps separate accumulators per agent", async () => {
    const { writeFile } = await import("node:fs/promises");
    (writeFile as ReturnType<typeof vi.fn>).mockClear();
    process.env.DEV_MODE = "true";
    resetDevMode();
    setContextDumpDir("/tmp/test-dump");

    dumpThinking("dm", 1, "DM thought");
    dumpThinking("summarizer", 1, "Summarizer thought");
    dumpContext("dm", { model: "test", messages: [] });

    await new Promise((r) => setTimeout(r, 10));

    const dmCalls = (writeFile as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).endsWith("dm.json"),
    );
    const parsed = JSON.parse(dmCalls[0][1] as string);
    expect(parsed._thinking_trace).toHaveLength(1);
    expect(parsed._thinking_trace[0].thinking).toBe("DM thought");
  });

  it("resetContextDump clears the accumulator", async () => {
    const { writeFile } = await import("node:fs/promises");
    (writeFile as ReturnType<typeof vi.fn>).mockClear();
    process.env.DEV_MODE = "true";
    resetDevMode();
    setContextDumpDir("/tmp/test-dump");

    dumpThinking("dm", 1, "Some thought");
    resetContextDump();
    setContextDumpDir("/tmp/test-dump");
    dumpContext("dm", { model: "test", messages: [] });

    await new Promise((r) => setTimeout(r, 10));

    const contextCalls = (writeFile as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).endsWith("dm.json"),
    );
    const parsed = JSON.parse(contextCalls[0][1] as string);
    expect(parsed._thinking_trace).toBeUndefined();
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
