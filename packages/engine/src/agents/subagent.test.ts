import { describe, it, expect, vi } from "vitest";
import type { LLMProvider, ChatResult, NormalizedUsage } from "../providers/types.js";
import { spawnSubagent, oneShot, cacheSystemPrompt } from "./subagent.js";

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

function toolUseResult(name: string, input: Record<string, unknown>): ChatResult {
  return {
    text: "",
    toolCalls: [{ id: "toolu_test", name, input }],
    usage: mockUsage(),
    stopReason: "tool_use",
    assistantContent: [{ type: "tool_use", id: "toolu_test", name, input }],
  };
}

function mockProvider(responses: ChatResult[]): LLMProvider {
  let callIdx = 0;
  return {
    providerId: "test",
    chat: vi.fn(async () => responses[callIdx++]),
    stream: vi.fn(async (_params, onDelta) => {
      const result = responses[callIdx++];
      if (result.text) onDelta(result.text);
      return result;
    }),
    healthCheck: vi.fn(),
  };
}

describe("spawnSubagent", () => {
  it("returns text from silent subagent", async () => {
    const provider = mockProvider([textResult("Scene 14: Combat resolved.")]);

    const result = await spawnSubagent(provider, {
      name: "summarizer",
      model: "claude-haiku-4-5-20251001",
      visibility: "silent",
      systemPrompt: "Summarize in one line.",
      maxTokens: 128,
    }, "Summarize the scene.");

    expect(result.text).toBe("Scene 14: Combat resolved.");
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(20);
  });

  it("streams text for player-facing subagent", async () => {
    const provider = mockProvider([textResult("What would you like to discuss?")]);
    const onStream = vi.fn();

    const result = await spawnSubagent(provider, {
      name: "ooc",
      model: "claude-sonnet-4-5-20250929",
      visibility: "player_facing",
      systemPrompt: "You are the OOC assistant.",
      maxTokens: 512,
    }, "How does grappling work?", onStream);

    expect(result.text).toBe("What would you like to discuss?");
    // stream() was called instead of chat()
    expect(provider.stream).toHaveBeenCalled();
  });

  it("handles tool use in subagent", async () => {
    const provider = mockProvider([
      toolUseResult("roll_dice", { expression: "1d20+5" }),
      textResult("Hit (23 vs AC 13). 9 slash. G1: 3/12 HP."),
    ]);

    const toolHandler = vi.fn(() => ({ content: "1d20+5: [18]→23" }));

    const result = await spawnSubagent(provider, {
      name: "resolver",
      model: "claude-haiku-4-5-20251001",
      visibility: "silent",
      systemPrompt: "Resolve the action.",
      maxTokens: 256,
      tools: [{
        name: "roll_dice",
        description: "Roll dice",
        inputSchema: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
      }],
      toolHandler,
    }, "Aldric attacks G1 with longsword.");

    expect(toolHandler).toHaveBeenCalledWith("roll_dice", { expression: "1d20+5" });
    expect(result.text).toBe("Hit (23 vs AC 13). 9 slash. G1: 3/12 HP.");
    // Two API calls
    expect(result.usage.inputTokens).toBe(100);
  });

  it("enforces terse instruction in system prompt", async () => {
    const provider = mockProvider([textResult("Done.")]);

    await spawnSubagent(provider, {
      name: "test",
      model: "claude-haiku-4-5-20251001",
      visibility: "silent",
      systemPrompt: "You are a helper.",
      maxTokens: 128,
    }, "Do something.");

    const chatCall = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const systemText = Array.isArray(chatCall.systemPrompt)
      ? chatCall.systemPrompt.map((b: { text: string }) => b.text).join("")
      : chatCall.systemPrompt;
    expect(systemText).toContain("minimum tokens");
    expect(systemText).toContain("terse");
  });

  it("limits tool rounds", async () => {
    // Always returns tool_use
    const infiniteTools = Array.from({ length: 5 }, () =>
      toolUseResult("roll_dice", { expression: "1d6" }),
    );
    const provider = mockProvider(infiniteTools);

    const result = await spawnSubagent(provider, {
      name: "test",
      model: "claude-haiku-4-5-20251001",
      visibility: "silent",
      systemPrompt: "Test",
      maxTokens: 128,
      maxToolRounds: 2,
      tools: [{
        name: "roll_dice",
        description: "Roll",
        inputSchema: { type: "object", properties: {} },
      }],
      toolHandler: () => ({ content: "3" }),
    }, "Roll a lot.");

    // Should have called API exactly maxToolRounds times
    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(result.text).toBe(""); // no text blocks in tool_use responses
  });
});

describe("cacheSystemPrompt", () => {
  it("wraps string as SystemBlock[] with 1h cache_control", () => {
    const blocks = cacheSystemPrompt("You are a summarizer.");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("You are a summarizer.");
    expect(blocks[0].cacheControl).toEqual({ ttl: "1h" });
  });
});

describe("oneShot", () => {
  it("runs a simple one-shot query", async () => {
    const provider = mockProvider([textResult("Scene summary here.")]);

    const result = await oneShot(
      provider,
      "claude-haiku-4-5-20251001",
      "Summarize the scene.",
      "The party fought three goblins in the throne room.",
    );

    expect(result.text).toBe("Scene summary here.");
  });

  it("auto-wraps system prompt with cache_control", async () => {
    const provider = mockProvider([textResult("Done.")]);

    await oneShot(provider, "claude-haiku-4-5-20251001", "Test prompt.", "Go.");

    const call = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // System should be SystemBlock[] (cached prompt + terse suffix)
    expect(Array.isArray(call.systemPrompt)).toBe(true);
    const blocks = call.systemPrompt as { text: string; cacheControl?: { ttl: string } }[];
    expect(blocks[0].text).toBe("Test prompt.");
    expect(blocks[0].cacheControl).toEqual({ ttl: "1h" });
  });
});
