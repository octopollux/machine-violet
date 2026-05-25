import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LLMProvider, ChatResult, NormalizedUsage } from "../../providers/types.js";
import { styleTheme } from "./theme-styler.js";
import { resetPromptCache } from "../../prompts/load-prompt.js";
import { listAvailableThemes, resetThemeListCache } from "./theme-list.js";

// --- Mock helpers ---

function mockUsage(): NormalizedUsage {
  return { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };
}

function textResult(text: string): ChatResult {
  return {
    text,
    toolCalls: [],
    usage: mockUsage(),
    stopReason: "end",
    assistantContent: [{ type: "text", text }],
  };
}

function mockProvider(response: string): LLMProvider {
  return {
    providerId: "test",
    chat: vi.fn(async () => textResult(response)),
    stream: vi.fn(async (_params, onDelta) => {
      const result = textResult(response);
      if (result.text) onDelta(result.text);
      return result;
    }),
    healthCheck: vi.fn(),
  };
}

beforeEach(() => {
  resetPromptCache();
  resetThemeListCache();
});

describe("styleTheme", () => {
  it("parses a full theme command from JSON response", async () => {
    const provider = mockProvider('{"theme":"terminal","key_color":"#00ff88","preset":"cyberpunk","gradient":"hueShift"}');
    const result = await styleTheme(provider, "cyberpunk neon", undefined, undefined, "claude-haiku-4-5-20251001");

    expect(result.command).not.toBeNull();
    expect(result.command!.type).toBe("set_theme");
    expect(result.command!.theme).toBe("terminal");
    expect(result.command!.key_color).toBe("#00ff88");
  });

  it("parses a color-only response", async () => {
    const provider = mockProvider('{"key_color":"#cc4444"}');
    const result = await styleTheme(provider, "make it red", undefined, undefined, "claude-haiku-4-5-20251001");

    expect(result.command).not.toBeNull();
    expect(result.command!.key_color).toBe("#cc4444");
    expect(result.command!.theme).toBeUndefined();
  });

  it("handles markdown-fenced JSON", async () => {
    const provider = mockProvider('```json\n{"theme":"gothic","key_color":"#553388"}\n```');
    const result = await styleTheme(provider, "dark fantasy", undefined, undefined, "claude-haiku-4-5-20251001");

    expect(result.command).not.toBeNull();
    expect(result.command!.theme).toBe("gothic");
  });

  it("returns null command for unparseable response", async () => {
    const provider = mockProvider("I think you should use a blue color scheme.");
    const result = await styleTheme(provider, "make it blue", undefined, undefined, "claude-haiku-4-5-20251001");

    expect(result.command).toBeNull();
  });

  it("returns null command for empty JSON", async () => {
    const provider = mockProvider("{}");
    const result = await styleTheme(provider, "do something", undefined, undefined, "claude-haiku-4-5-20251001");

    expect(result.command).toBeNull();
  });

  it("includes current theme context in prompt when provided", async () => {
    const provider = mockProvider('{"key_color":"#884422"}');
    const result = await styleTheme(provider, "make it warmer", "gothic", "#8888aa", "claude-haiku-4-5-20251001");

    expect(result.command).not.toBeNull();
    // Verify the create call included the context
    const chatCall = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const userMsg = chatCall.messages[0].content;
    expect(userMsg).toContain("Current theme: gothic");
    expect(userMsg).toContain("Current key color: #8888aa");
  });

  it("returns usage stats", async () => {
    const provider = mockProvider('{"key_color":"#ff0000"}');
    const result = await styleTheme(provider, "red", undefined, undefined, "claude-haiku-4-5-20251001");

    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(20);
  });

  it("injects every bundled theme into the system prompt", async () => {
    const provider = mockProvider('{"theme":"gothic"}');
    await styleTheme(provider, "anything", undefined, undefined, "claude-haiku-4-5-20251001");

    const chatCall = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemBlocks = chatCall.systemPrompt as { text: string }[];
    const systemText = systemBlocks.map((b) => b.text).join("\n");
    const themes = listAvailableThemes();

    // Sanity: there should be many themes — guards against an empty asset dir.
    expect(themes.length).toBeGreaterThan(10);

    // Every bundled theme name should appear in the prompt.
    for (const theme of themes) {
      expect(systemText).toContain(theme.name);
    }

    // The placeholder must have been substituted.
    expect(systemText).not.toContain("{{themes_list}}");
  });
});
