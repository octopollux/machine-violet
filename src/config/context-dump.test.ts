import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  renderDump,
  renderContent,
  dumpContext,
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

// --- renderDump ---

describe("renderDump", () => {
  it("renders string system prompt", () => {
    const result = renderDump("dm", {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: "You are a dungeon master.",
      messages: [],
    });

    expect(result).toContain("=== CONTEXT DUMP: dm ===");
    expect(result).toContain("Model: claude-opus-4-6");
    expect(result).toContain("Max Tokens: 4096");
    expect(result).toContain("=== SYSTEM PROMPT ===");
    expect(result).toContain("You are a dungeon master.");
    expect(result).toContain("=== MESSAGES (0) ===");
    expect(result).toContain("=== END ===");
  });

  it("renders TextBlockParam[] system prompt with cache markers", () => {
    const result = renderDump("dm", {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 2000,
      system: [
        { type: "text", text: "Identity block", cache_control: { type: "ephemeral" } },
        { type: "text", text: "Personality block" },
      ],
      messages: [],
    });

    expect(result).toContain("--- block 1 [cached] ---");
    expect(result).toContain("Identity block");
    expect(result).toContain("--- block 2 ---");
    expect(result).toContain("Personality block");
  });

  it("renders TTL in cache marker when present", () => {
    const result = renderDump("dm", {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 2000,
      system: [
        { type: "text", text: "Identity block", cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: "Personality block" },
      ],
      messages: [],
    });

    expect(result).toContain("--- block 1 [cached:1h] ---");
    expect(result).toContain("--- block 2 ---");
  });

  it("renders cached marker on last tool when cache_control is present", () => {
    const result = renderDump("dm", {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: "system",
      messages: [],
      tools: [
        { name: "roll_dice", description: "Roll dice." },
        { name: "draw_card", description: "Draw a card.", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
    });

    expect(result).toContain("1. roll_dice - Roll dice.");
    expect(result).toContain("2. draw_card - Draw a card. [cached:1h]");
  });

  it("renders messages with role headers", () => {
    const result = renderDump("dm", {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: "system",
      messages: [
        { role: "user", content: "Hello DM" },
        { role: "assistant", content: "Welcome, adventurer." },
      ],
    });

    expect(result).toContain("=== MESSAGES (2) ===");
    expect(result).toContain("--- [1] user ---");
    expect(result).toContain("Hello DM");
    expect(result).toContain("--- [2] assistant ---");
    expect(result).toContain("Welcome, adventurer.");
  });

  it("renders tools list with first line of description", () => {
    const result = renderDump("dm", {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: "system",
      messages: [],
      tools: [
        { name: "roll_dice", description: "Roll dice using standard notation.\nSupports XdY+Z." },
        { name: "draw_card", description: "Draw a card from a deck." },
      ],
    });

    expect(result).toContain("=== TOOLS (2) ===");
    expect(result).toContain("1. roll_dice - Roll dice using standard notation.");
    expect(result).toContain("2. draw_card - Draw a card from a deck.");
    // Second line of roll_dice description should NOT appear
    expect(result).not.toContain("Supports XdY+Z");
  });

  it("omits tools section when no tools", () => {
    const result = renderDump("summarizer", {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system: "Summarize.",
      messages: [{ role: "user", content: "Scene text..." }],
    });

    expect(result).not.toContain("=== TOOLS");
    expect(result).toContain("=== CONTEXT DUMP: summarizer ===");
  });

  it("includes timestamp", () => {
    const result = renderDump("dm", {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: "sys",
      messages: [],
    });

    expect(result).toMatch(/Timestamp: \d{4}-\d{2}-\d{2}T/);
  });
});

// --- renderContent ---

describe("renderContent", () => {
  it("renders string content directly", () => {
    expect(renderContent("Hello world")).toBe("Hello world");
  });

  it("renders text blocks", () => {
    const result = renderContent([
      { type: "text", text: "First paragraph." },
      { type: "text", text: "Second paragraph." },
    ]);
    expect(result).toBe("First paragraph.\nSecond paragraph.");
  });

  it("renders tool_use blocks", () => {
    const result = renderContent([
      { type: "tool_use", name: "roll_dice", id: "tu_1", input: { notation: "2d6+3" } },
    ]);
    expect(result).toBe('[tool_use: roll_dice({"notation":"2d6+3"})]');
  });

  it("renders tool_result blocks with truncation", () => {
    const longContent = "x".repeat(300);
    const result = renderContent([
      { type: "tool_result", tool_use_id: "tu_1", content: longContent },
    ]);
    expect(result).toContain("[tool_result: tu_1 |");
    expect(result).toContain("...");
    // Truncated to 200 chars + "..."
    expect(result.length).toBeLessThan(300);
  });

  it("renders tool_result error flag", () => {
    const result = renderContent([
      { type: "tool_result", tool_use_id: "tu_2", content: "Not found", is_error: true },
    ]);
    expect(result).toContain("[tool_result: tu_2 ERROR | Not found]");
  });

  it("renders image blocks", () => {
    const result = renderContent([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
    ]);
    expect(result).toBe("[image: image/png]");
  });

  it("renders unknown block types as JSON", () => {
    const result = renderContent([
      { type: "thinking", text: "Let me consider..." },
    ]);
    expect(result).toContain("[thinking:");
    expect(result).toContain("Let me consider...");
  });

  it("handles mixed content array", () => {
    const result = renderContent([
      { type: "text", text: "Here is the result:" },
      { type: "tool_use", name: "roll_dice", id: "tu_1", input: { notation: "1d20" } },
    ]);
    const lines = result.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("Here is the result:");
    expect(lines[1]).toContain("[tool_use: roll_dice");
  });
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

    // writeFile should not have been called for the dump (only for mkdir in setContextDumpDir)
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("is a no-op when dump dir is not set", async () => {
    const { writeFile } = await import("node:fs/promises");
    process.env.DEV_MODE = "true";
    resetDevMode();
    // Don't call setContextDumpDir

    dumpContext("dm", {
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: "sys",
      messages: [],
    });

    expect(writeFile).not.toHaveBeenCalled();
  });

  it("writes when dev mode is on and dir is set", async () => {
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

    // Give the fire-and-forget promise a tick to resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining("dm.txt"),
      expect.stringContaining("=== CONTEXT DUMP: dm ==="),
      "utf-8",
    );
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
