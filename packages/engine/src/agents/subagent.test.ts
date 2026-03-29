import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { spawnSubagent, oneShot, cacheSystemPrompt } from "./subagent.js";

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

function toolUseResponse(name: string, input: Record<string, unknown>): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: [{ type: "tool_use", id: "toolu_test", name, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: mockUsage(),
  } as Anthropic.Message;
}

function mockClient(responses: Anthropic.Message[]): Anthropic {
  let callIdx = 0;
  return {
    messages: {
      create: vi.fn(async () => responses[callIdx++]),
      stream: vi.fn(() => {
        const response = responses[callIdx++];
        return {
          on: vi.fn(),
          finalMessage: vi.fn(async () => response),
        };
      }),
    },
  } as unknown as Anthropic;
}

describe("spawnSubagent", () => {
  it("returns text from silent subagent", async () => {
    const client = mockClient([textResponse("Scene 14: Combat resolved.")]);

    const result = await spawnSubagent(client, {
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
    const client = mockClient([textResponse("What would you like to discuss?")]);
    const onStream = vi.fn();

    const result = await spawnSubagent(client, {
      name: "ooc",
      model: "claude-sonnet-4-5-20250929",
      visibility: "player_facing",
      systemPrompt: "You are the OOC assistant.",
      maxTokens: 512,
    }, "How does grappling work?", onStream);

    expect(result.text).toBe("What would you like to discuss?");
    // stream() was called instead of create()
    expect(client.messages.stream).toHaveBeenCalled();
  });

  it("handles tool use in subagent", async () => {
    const client = mockClient([
      toolUseResponse("roll_dice", { expression: "1d20+5" }),
      textResponse("Hit (23 vs AC 13). 9 slash. G1: 3/12 HP."),
    ]);

    const toolHandler = vi.fn(() => ({ content: "1d20+5: [18]→23" }));

    const result = await spawnSubagent(client, {
      name: "resolver",
      model: "claude-haiku-4-5-20251001",
      visibility: "silent",
      systemPrompt: "Resolve the action.",
      maxTokens: 256,
      tools: [{
        name: "roll_dice",
        description: "Roll dice",
        input_schema: { type: "object" as const, properties: { expression: { type: "string" } }, required: ["expression"] },
      }],
      toolHandler,
    }, "Aldric attacks G1 with longsword.");

    expect(toolHandler).toHaveBeenCalledWith("roll_dice", { expression: "1d20+5" });
    expect(result.text).toBe("Hit (23 vs AC 13). 9 slash. G1: 3/12 HP.");
    // Two API calls
    expect(result.usage.inputTokens).toBe(100);
  });

  it("enforces terse instruction in system prompt", async () => {
    const client = mockClient([textResponse("Done.")]);

    await spawnSubagent(client, {
      name: "test",
      model: "claude-haiku-4-5-20251001",
      visibility: "silent",
      systemPrompt: "You are a helper.",
      maxTokens: 128,
    }, "Do something.");

    const createCall = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.system).toContain("minimum tokens");
    expect(createCall.system).toContain("terse");
  });

  it("limits tool rounds", async () => {
    // Always returns tool_use
    const infiniteTools = Array.from({ length: 5 }, () =>
      toolUseResponse("roll_dice", { expression: "1d6" }),
    );
    const client = mockClient(infiniteTools);

    const result = await spawnSubagent(client, {
      name: "test",
      model: "claude-haiku-4-5-20251001",
      visibility: "silent",
      systemPrompt: "Test",
      maxTokens: 128,
      maxToolRounds: 2,
      tools: [{
        name: "roll_dice",
        description: "Roll",
        input_schema: { type: "object" as const, properties: {} },
      }],
      toolHandler: () => ({ content: "3" }),
    }, "Roll a lot.");

    // Should have called API exactly maxToolRounds times
    expect(client.messages.create).toHaveBeenCalledTimes(2);
    expect(result.text).toBe(""); // no text blocks in tool_use responses
  });
});

describe("cacheSystemPrompt", () => {
  it("wraps string as TextBlockParam[] with 1h cache_control", () => {
    const blocks = cacheSystemPrompt("You are a summarizer.");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toBe("You are a summarizer.");
    expect((blocks[0] as unknown as Record<string, unknown>).cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });
});

describe("oneShot", () => {
  it("runs a simple one-shot query", async () => {
    const client = mockClient([textResponse("Scene summary here.")]);

    const result = await oneShot(
      client,
      "claude-haiku-4-5-20251001",
      "Summarize the scene.",
      "The party fought three goblins in the throne room.",
    );

    expect(result.text).toBe("Scene summary here.");
  });

  it("auto-wraps system prompt with cache_control", async () => {
    const client = mockClient([textResponse("Done.")]);

    await oneShot(client, "claude-haiku-4-5-20251001", "Test prompt.", "Go.");

    const call = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // System should be TextBlockParam[] (cached prompt + terse suffix)
    expect(Array.isArray(call.system)).toBe(true);
    const blocks = call.system as Anthropic.TextBlockParam[];
    expect(blocks[0].text).toBe("Test prompt.");
    expect((blocks[0] as unknown as Record<string, unknown>).cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });
});
