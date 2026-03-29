import { describe, it, expect, vi, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { styleTheme } from "./theme-styler.js";
import { resetPromptCache } from "../../prompts/load-prompt.js";

// --- Mock helpers ---

function mockUsage(): Anthropic.Usage {
  return { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null, inference_geo: null, server_tool_use: null, service_tier: null };
}

function textResponse(text: string): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: mockUsage(),
  } as Anthropic.Message;
}

function mockClient(response: string): Anthropic {
  return {
    messages: {
      create: vi.fn(async () => textResponse(response)),
      stream: vi.fn(() => ({
        on: vi.fn(),
        finalMessage: vi.fn(async () => textResponse(response)),
      })),
    },
  } as unknown as Anthropic;
}

beforeEach(() => {
  resetPromptCache();
});

describe("styleTheme", () => {
  it("parses a full theme command from JSON response", async () => {
    const client = mockClient('{"theme":"terminal","key_color":"#00ff88","preset":"cyberpunk","gradient":"hueShift"}');
    const result = await styleTheme(client, "cyberpunk neon");

    expect(result.command).not.toBeNull();
    expect(result.command!.type).toBe("set_theme");
    expect(result.command!.theme).toBe("terminal");
    expect(result.command!.key_color).toBe("#00ff88");
  });

  it("parses a color-only response", async () => {
    const client = mockClient('{"key_color":"#cc4444"}');
    const result = await styleTheme(client, "make it red");

    expect(result.command).not.toBeNull();
    expect(result.command!.key_color).toBe("#cc4444");
    expect(result.command!.theme).toBeUndefined();
  });

  it("handles markdown-fenced JSON", async () => {
    const client = mockClient('```json\n{"theme":"gothic","key_color":"#553388"}\n```');
    const result = await styleTheme(client, "dark fantasy");

    expect(result.command).not.toBeNull();
    expect(result.command!.theme).toBe("gothic");
  });

  it("returns null command for unparseable response", async () => {
    const client = mockClient("I think you should use a blue color scheme.");
    const result = await styleTheme(client, "make it blue");

    expect(result.command).toBeNull();
  });

  it("returns null command for empty JSON", async () => {
    const client = mockClient("{}");
    const result = await styleTheme(client, "do something");

    expect(result.command).toBeNull();
  });

  it("includes current theme context in prompt when provided", async () => {
    const client = mockClient('{"key_color":"#884422"}');
    const result = await styleTheme(client, "make it warmer", "gothic", "#8888aa");

    expect(result.command).not.toBeNull();
    // Verify the create call included the context
    const createCall = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const userMsg = createCall.messages[0].content;
    expect(userMsg).toContain("Current theme: gothic");
    expect(userMsg).toContain("Current key color: #8888aa");
  });

  it("returns usage stats", async () => {
    const client = mockClient('{"key_color":"#ff0000"}');
    const result = await styleTheme(client, "red");

    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(20);
  });
});
