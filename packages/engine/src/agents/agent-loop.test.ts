import { describe, it, expect, vi } from "vitest";
import type { LLMProvider, ChatResult, ContentPart, NormalizedUsage } from "../providers/types.js";
import { agentLoop } from "./agent-loop.js";
import { extractStatus, retryDelay } from "../utils/retry.js";
import type { AgentLoopConfig } from "./agent-loop.js";
import { createTestRegistry } from "./tool-registry.js";
import type { GameState } from "./game-state.js";
import { createClocksState } from "../tools/clocks/index.js";
import { createCombatState, createDefaultConfig } from "../tools/combat/index.js";
import { createDecksState } from "../tools/cards/index.js";
import { createObjectivesState } from "../tools/objectives/index.js";

function mockState(): GameState {
  return {
    maps: {},
    clocks: createClocksState(),
    combat: createCombatState(),
    combatConfig: createDefaultConfig(),
    decks: createDecksState(),
    objectives: createObjectivesState(),
    config: {
      name: "Test",
      dm_personality: { name: "test", prompt_fragment: "" },
      players: [{ name: "Alice", character: "Aldric", type: "human" }],
      combat: createDefaultConfig(),
      context: { retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 },
      recovery: { auto_commit_interval: 300, max_commits: 100, enable_git: false },
      choices: { campaign_default: "never", player_overrides: {} },
    },
    campaignRoot: "/tmp/test",
    homeDir: "/tmp/home",
    activePlayerIndex: 0,
    displayResources: {},
    resourceValues: {},
  };
}

function mockUsage(): NormalizedUsage {
  return { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };
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

function toolUseResult(
  toolName: string,
  input: Record<string, unknown>,
  toolId = "toolu_test",
): ChatResult {
  return {
    text: "",
    toolCalls: [{ id: toolId, name: toolName, input }],
    usage: mockUsage(),
    stopReason: "tool_use",
    assistantContent: [{ type: "tool_use", id: toolId, name: toolName, input }],
  };
}

function textAndToolResult(
  text: string,
  toolName: string,
  input: Record<string, unknown>,
): ChatResult {
  return {
    text,
    toolCalls: [{ id: "toolu_test", name: toolName, input }],
    usage: mockUsage(),
    stopReason: "tool_use",
    assistantContent: [
      { type: "text", text },
      { type: "tool_use", id: "toolu_test", name: toolName, input },
    ],
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

function mockConfig(overrides?: Partial<AgentLoopConfig>): AgentLoopConfig {
  return {
    model: "claude-haiku-4-5-20251001",
    provider: mockProvider([]),
    maxTokens: 1024,
    maxToolRounds: 5,
    ...overrides,
  };
}

describe("agentLoop", () => {
  it("returns text from a simple response", async () => {
    const provider = mockProvider([textResult("The door creaks open.")]);
    const result = await agentLoop(
      provider,
      "You are a DM.",
      [{ role: "user", content: "I open the door." }],
      createTestRegistry(),
      mockState(),
      mockConfig({ provider }),
    );
    expect(result.text).toBe("The door creaks open.");
    expect(result.tuiCommands).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  it("handles tool_use → tool_result → text loop", async () => {
    const provider = mockProvider([
      toolUseResult("roll_dice", { expression: "1d20+5" }),
      textResult("You rolled a 17. The attack hits!"),
    ]);
    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();

    const result = await agentLoop(
      provider,
      "You are a DM.",
      [{ role: "user", content: "I attack the goblin." }],
      createTestRegistry(),
      mockState(),
      mockConfig({ provider, onToolStart, onToolEnd }),
    );

    expect(onToolStart).toHaveBeenCalledWith("roll_dice");
    expect(onToolEnd).toHaveBeenCalledWith("roll_dice", expect.objectContaining({ content: expect.stringContaining("→") }));
    expect(result.text).toBe("You rolled a 17. The attack hits!");
  });

  it("broadcasts style_scene immediately (no longer deferred)", async () => {
    const provider = mockProvider([
      toolUseResult("style_scene", { key_color: "#cc4444" }),
      textResult("The mood darkens."),
    ]);
    const onTuiCommand = vi.fn();

    const result = await agentLoop(
      provider,
      "You are a DM.",
      [{ role: "user", content: "I attack!" }],
      createTestRegistry(),
      mockState(),
      mockConfig({ provider, onTuiCommand }),
    );

    // style_scene is now immediate — broadcast via callback, not collected
    expect(onTuiCommand).toHaveBeenCalledOnce();
    expect(onTuiCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "style_scene", key_color: "#cc4444" }),
    );
    expect(result.tuiCommands).toHaveLength(0);
  });

  it("broadcasts non-deferred TUI commands immediately via onTuiCommand", async () => {
    const provider = mockProvider([
      toolUseResult("update_modeline", { text: "HP: 12/20" }),
      textResult("The battle rages on."),
    ]);
    const onTuiCommand = vi.fn();

    const result = await agentLoop(
      provider,
      "You are a DM.",
      [{ role: "user", content: "What's my HP?" }],
      createTestRegistry(),
      mockState(),
      mockConfig({ provider, onTuiCommand }),
    );

    // Non-deferred commands are broadcast immediately, not collected
    expect(onTuiCommand).toHaveBeenCalledOnce();
    expect(onTuiCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "update_modeline", text: "HP: 12/20" }),
    );
    expect(result.tuiCommands).toHaveLength(0);
  });

  it("deferred TUI commands are collected, not broadcast immediately", async () => {
    const provider = mockProvider([
      toolUseResult("scene_transition", { title: "Chapter 2" }),
      textResult("A new chapter begins."),
    ]);
    const onTuiCommand = vi.fn();

    const result = await agentLoop(
      provider,
      "You are a DM.",
      [{ role: "user", content: "Move on" }],
      createTestRegistry(),
      mockState(),
      mockConfig({ provider, onTuiCommand }),
    );

    // Deferred commands stay in tuiCommands for engine processing
    expect(onTuiCommand).not.toHaveBeenCalled();
    expect(result.tuiCommands).toHaveLength(1);
    expect(result.tuiCommands[0].type).toBe("scene_transition");
  });

  it("handles text + tool_use in same response", async () => {
    const provider = mockProvider([
      textAndToolResult("Let me roll for you... ", "roll_dice", { expression: "1d20" }),
      textResult("A natural 20!"),
    ]);

    const result = await agentLoop(
      provider,
      "You are a DM.",
      [{ role: "user", content: "I try to pick the lock." }],
      createTestRegistry(),
      mockState(),
      mockConfig({ provider }),
    );

    expect(result.text).toBe("Let me roll for you... A natural 20!");
  });

  it("accumulates usage across rounds", async () => {
    const provider = mockProvider([
      toolUseResult("roll_dice", { expression: "1d6" }),
      textResult("Done."),
    ]);

    const result = await agentLoop(
      provider,
      "System",
      [{ role: "user", content: "Roll" }],
      createTestRegistry(),
      mockState(),
      mockConfig({ provider }),
    );

    // Two API calls × 100 input + 50 output each
    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.outputTokens).toBe(100);
  });

  it("truncates at maxToolRounds", async () => {
    // Always returns tool_use, never ends
    const infiniteTools = Array.from({ length: 3 }, () =>
      toolUseResult("roll_dice", { expression: "1d6" }),
    );
    const provider = mockProvider(infiniteTools);

    const result = await agentLoop(
      provider,
      "System",
      [{ role: "user", content: "Roll a lot" }],
      createTestRegistry(),
      mockState(),
      mockConfig({ provider, maxToolRounds: 3 }),
    );

    expect(result.truncated).toBe(true);
  });

  it("calls onTextDelta for text blocks", async () => {
    const onTextDelta = vi.fn();
    const provider: LLMProvider = {
      providerId: "test",
      chat: vi.fn(async () => textResult("Hello world")),
      stream: vi.fn(async (_params, onDelta) => {
        onDelta("Hello world");
        return textResult("Hello world");
      }),
      healthCheck: vi.fn(),
    };

    await agentLoop(
      provider,
      "System",
      [{ role: "user", content: "Hi" }],
      createTestRegistry(),
      mockState(),
      mockConfig({ provider, onTextDelta }),
    );

    expect(onTextDelta).toHaveBeenCalledWith("Hello world");
  });

  it("calls onComplete with usage stats", async () => {
    const provider = mockProvider([textResult("Done.")]);
    const onComplete = vi.fn();

    await agentLoop(
      provider,
      "System",
      [{ role: "user", content: "Go" }],
      createTestRegistry(),
      mockState(),
      mockConfig({ provider, onComplete }),
    );

    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
      inputTokens: 100,
      outputTokens: 50,
    }));
  });

  it("passes through roundMessages from agent session", async () => {
    const provider = mockProvider([
      toolUseResult("roll_dice", { expression: "1d20" }),
      textResult("You rolled a 15!"),
    ]);

    const result = await agentLoop(
      provider,
      "System",
      [{ role: "user", content: "Roll" }],
      createTestRegistry(),
      mockState(),
      mockConfig({ provider }),
    );

    // Should have: assistant(tool_use), user(tool_result), assistant(text)
    expect(result.roundMessages).toHaveLength(3);
    expect(result.roundMessages[0].role).toBe("assistant");
    expect(result.roundMessages[1].role).toBe("user");
    expect(result.roundMessages[2].role).toBe("assistant");
  });

  it("executes multiple tool calls from a single response", async () => {
    const multiToolResult: ChatResult = {
      text: "",
      toolCalls: [
        { id: "toolu_1", name: "roll_dice", input: { expression: "1d20" } },
        { id: "toolu_2", name: "roll_dice", input: { expression: "1d6" } },
      ],
      usage: mockUsage(),
      stopReason: "tool_use",
      assistantContent: [
        { type: "tool_use", id: "toolu_1", name: "roll_dice", input: { expression: "1d20" } },
        { type: "tool_use", id: "toolu_2", name: "roll_dice", input: { expression: "1d6" } },
      ],
    };

    const provider = mockProvider([multiToolResult, textResult("Two rolls done!")]);
    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();

    const result = await agentLoop(
      provider,
      "System",
      [{ role: "user", content: "Roll two dice" }],
      createTestRegistry(),
      mockState(),
      mockConfig({ provider, onToolStart, onToolEnd }),
    );

    expect(onToolStart).toHaveBeenCalledTimes(2);
    expect(onToolEnd).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("Two rolls done!");

    // Verify both tool results were sent back in one user message
    const chatCalls = (provider.chat as ReturnType<typeof vi.fn>).mock.calls;
    const secondCallMsgs = chatCalls[1][0].messages;
    const toolResultMsg = secondCallMsgs.find(
      (m: { role: string; content: unknown }) =>
        m.role === "user" && Array.isArray(m.content),
    );
    expect(toolResultMsg).toBeDefined();
    const results = (toolResultMsg.content as ContentPart[]).filter((p) => p.type === "tool_result");
    expect(results).toHaveLength(2);
    expect(results[0].tool_use_id).toBe("toolu_1");
    expect(results[1].tool_use_id).toBe("toolu_2");
  });

  it("handles tool errors gracefully", async () => {
    const provider = mockProvider([
      toolUseResult("map", { operation: "view", map: "nonexistent", center: "0,0", radius: 1 }),
      textResult("I couldn't find that map."),
    ]);

    const onToolEnd = vi.fn();
    const result = await agentLoop(
      provider,
      "System",
      [{ role: "user", content: "Show map" }],
      createTestRegistry(),
      mockState(),
      mockConfig({ provider, onToolEnd }),
    );

    expect(onToolEnd).toHaveBeenCalledWith(
      "map",
      expect.objectContaining({ is_error: true }),
    );
    expect(result.text).toBe("I couldn't find that map.");
  });
});

describe("thinking block filtering", () => {
  it("strips thinking blocks from conversation history", async () => {
    // First response has thinking + tool_use, second is text-only
    const thinkingPlusToolResult: ChatResult = {
      text: "",
      toolCalls: [{ id: "toolu_1", name: "roll_dice", input: { notation: "1d20" } }],
      usage: mockUsage(),
      stopReason: "tool_use",
      thinkingText: "Let me consider...",
      // assistantContent should NOT include thinking (per spec: "Thinking blocks are excluded")
      assistantContent: [
        { type: "tool_use", id: "toolu_1", name: "roll_dice", input: { notation: "1d20" } },
      ],
    };

    const chatFn = vi.fn()
      .mockResolvedValueOnce(thinkingPlusToolResult)
      .mockResolvedValueOnce(textResult("You rolled a 15!"));

    const provider: LLMProvider = {
      providerId: "test",
      chat: chatFn,
      stream: vi.fn(),
      healthCheck: vi.fn(),
    };

    await agentLoop(
      provider,
      "System",
      [{ role: "user", content: "Roll a d20" }],
      createTestRegistry(),
      mockState(),
      mockConfig({ provider }),
    );

    // Second call should have the assistant message WITHOUT the thinking block
    const secondCallParams = chatFn.mock.calls[1][0];
    const assistantMsg = secondCallParams.messages.find(
      (m: { role: string }) => m.role === "assistant",
    );
    expect(assistantMsg).toBeDefined();
    const blockTypes = (assistantMsg!.content as ContentPart[]).map(
      (b: ContentPart) => b.type,
    );
    expect(blockTypes).not.toContain("thinking");
    expect(blockTypes).toContain("tool_use");
  });
});

describe("extractStatus", () => {
  it("extracts numeric .status from error objects", () => {
    expect(extractStatus({ status: 429, message: "rate limit" })).toBe(429);
    expect(extractStatus({ status: 529 })).toBe(529);
  });

  it("detects overloaded errors by message string", () => {
    expect(extractStatus(new Error("server overloaded"))).toBe(529);
  });

  it("detects network errors and maps to status 0", () => {
    expect(extractStatus(new Error("fetch failed"))).toBe(0);
    expect(extractStatus(new Error("connect ECONNRESET"))).toBe(0);
    expect(extractStatus(new Error("getaddrinfo ENOTFOUND api.anthropic.com"))).toBe(0);
    expect(extractStatus(new Error("connect ETIMEDOUT 1.2.3.4:443"))).toBe(0);
    expect(extractStatus(new Error("connect ECONNREFUSED 127.0.0.1:443"))).toBe(0);
    expect(extractStatus(new Error("socket hang up"))).toBe(0);
    expect(extractStatus(new Error("network error"))).toBe(0);
    expect(extractStatus(new Error("write EPIPE"))).toBe(0);
    expect(extractStatus(new Error("getaddrinfo EAI_AGAIN api.anthropic.com"))).toBe(0);
    // Anthropic SDK APIConnectionError uses this generic message
    expect(extractStatus(new Error("Connection error."))).toBe(0);
  });

  it("returns null for unknown errors", () => {
    expect(extractStatus(new Error("something unexpected"))).toBeNull();
    expect(extractStatus("just a string")).toBeNull();
  });
});

describe("retryDelay", () => {
  it("uses exponential backoff", () => {
    expect(retryDelay(0)).toBe(1000);
    expect(retryDelay(1)).toBe(2000);
    expect(retryDelay(2)).toBe(4000);
    expect(retryDelay(3)).toBe(8000);
  });

  it("caps at 12s", () => {
    expect(retryDelay(4)).toBe(12000);
    expect(retryDelay(5)).toBe(12000);
    expect(retryDelay(100)).toBe(12000);
  });
});
