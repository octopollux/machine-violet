import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { agentLoop, stampToolsCacheControl, _internal } from "./agent-loop.js";
import type { AgentLoopConfig } from "./agent-loop.js";
import { ToolRegistry } from "./tool-registry.js";
import type { GameState } from "./game-state.js";
import { createClocksState } from "../tools/clocks/index.js";
import { createCombatState, createDefaultConfig } from "../tools/combat/index.js";
import { createDecksState } from "../tools/cards/index.js";

function mockState(): GameState {
  return {
    maps: {},
    clocks: createClocksState(),
    combat: createCombatState(),
    combatConfig: createDefaultConfig(),
    decks: createDecksState(),
    config: {
      name: "Test",
      dm_personality: { name: "test", prompt_fragment: "" },
      players: [{ name: "Alice", character: "Aldric", type: "human" }],
      combat: createDefaultConfig(),
      context: { retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 },
      recovery: { auto_commit_interval: 300, max_commits: 100, enable_git: false },
      choices: { campaign_default: "often", player_overrides: {} },
    },
    campaignRoot: "/tmp/test",
    activePlayerIndex: 0,
  };
}

function mockConfig(overrides?: Partial<AgentLoopConfig>): AgentLoopConfig {
  return {
    model: "claude-haiku-4-5-20251001",
    maxTokens: 1024,
    maxToolRounds: 5,
    ...overrides,
  };
}

function mockUsage(): Anthropic.Usage {
  return { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

function textMessage(text: string): Anthropic.Message {
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

function toolUseMessage(
  toolName: string,
  input: Record<string, unknown>,
  toolId = "toolu_test",
): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: [{ type: "tool_use", id: toolId, name: toolName, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: mockUsage(),
  } as Anthropic.Message;
}

function textAndToolMessage(
  text: string,
  toolName: string,
  input: Record<string, unknown>,
): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: [
      { type: "text", text },
      { type: "tool_use", id: "toolu_test", name: toolName, input },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: mockUsage(),
  } as Anthropic.Message;
}

function mockClient(responses: Anthropic.Message[]): Anthropic {
  let callIdx = 0;
  return {
    messages: {
      create: vi.fn(async () => {
        return responses[callIdx++];
      }),
    },
  } as unknown as Anthropic;
}

describe("agentLoop", () => {
  it("returns text from a simple response", async () => {
    const client = mockClient([textMessage("The door creaks open.")]);
    const result = await agentLoop(
      client,
      "You are a DM.",
      [{ role: "user", content: "I open the door." }],
      new ToolRegistry(),
      mockState(),
      mockConfig(),
    );
    expect(result.text).toBe("The door creaks open.");
    expect(result.tuiCommands).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  it("handles tool_use → tool_result → text loop", async () => {
    const client = mockClient([
      toolUseMessage("roll_dice", { expression: "1d20+5" }),
      textMessage("You rolled a 17. The attack hits!"),
    ]);
    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();

    const result = await agentLoop(
      client,
      "You are a DM.",
      [{ role: "user", content: "I attack the goblin." }],
      new ToolRegistry(),
      mockState(),
      mockConfig({ onToolStart, onToolEnd }),
    );

    expect(onToolStart).toHaveBeenCalledWith("roll_dice");
    expect(onToolEnd).toHaveBeenCalledWith("roll_dice", expect.objectContaining({ content: expect.stringContaining("→") }));
    expect(result.text).toBe("You rolled a 17. The attack hits!");
  });

  it("collects TUI commands from tool calls", async () => {
    const client = mockClient([
      toolUseMessage("set_ui_style", { variant: "combat" }),
      textMessage("Combat begins!"),
    ]);

    const result = await agentLoop(
      client,
      "You are a DM.",
      [{ role: "user", content: "I attack!" }],
      new ToolRegistry(),
      mockState(),
      mockConfig(),
    );

    expect(result.tuiCommands).toHaveLength(1);
    expect(result.tuiCommands[0].type).toBe("set_ui_style");
    expect(result.tuiCommands[0].variant).toBe("combat");
  });

  it("handles text + tool_use in same response", async () => {
    const client = mockClient([
      textAndToolMessage("Let me roll for you... ", "roll_dice", { expression: "1d20" }),
      textMessage("A natural 20!"),
    ]);

    const result = await agentLoop(
      client,
      "You are a DM.",
      [{ role: "user", content: "I try to pick the lock." }],
      new ToolRegistry(),
      mockState(),
      mockConfig(),
    );

    expect(result.text).toBe("Let me roll for you... A natural 20!");
  });

  it("accumulates usage across rounds", async () => {
    const client = mockClient([
      toolUseMessage("roll_dice", { expression: "1d6" }),
      textMessage("Done."),
    ]);

    const result = await agentLoop(
      client,
      "System",
      [{ role: "user", content: "Roll" }],
      new ToolRegistry(),
      mockState(),
      mockConfig(),
    );

    // Two API calls × 100 input + 50 output each
    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.outputTokens).toBe(100);
  });

  it("truncates at maxToolRounds", async () => {
    // Always returns tool_use, never ends
    const infiniteTools = Array.from({ length: 3 }, () =>
      toolUseMessage("roll_dice", { expression: "1d6" }),
    );
    const client = mockClient(infiniteTools);

    const result = await agentLoop(
      client,
      "System",
      [{ role: "user", content: "Roll a lot" }],
      new ToolRegistry(),
      mockState(),
      mockConfig({ maxToolRounds: 3 }),
    );

    expect(result.truncated).toBe(true);
  });

  it("calls onTextDelta for text blocks", async () => {
    const client = mockClient([textMessage("Hello world")]);
    const onTextDelta = vi.fn();

    await agentLoop(
      client,
      "System",
      [{ role: "user", content: "Hi" }],
      new ToolRegistry(),
      mockState(),
      mockConfig({ onTextDelta }),
    );

    expect(onTextDelta).toHaveBeenCalledWith("Hello world");
  });

  it("calls onComplete with usage stats", async () => {
    const client = mockClient([textMessage("Done.")]);
    const onComplete = vi.fn();

    await agentLoop(
      client,
      "System",
      [{ role: "user", content: "Go" }],
      new ToolRegistry(),
      mockState(),
      mockConfig({ onComplete }),
    );

    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
      inputTokens: 100,
      outputTokens: 50,
    }));
  });

  it("handles tool errors gracefully", async () => {
    const client = mockClient([
      toolUseMessage("view_area", { map: "nonexistent", center: "0,0", radius: 1 }),
      textMessage("I couldn't find that map."),
    ]);

    const onToolEnd = vi.fn();
    const result = await agentLoop(
      client,
      "System",
      [{ role: "user", content: "Show map" }],
      new ToolRegistry(),
      mockState(),
      mockConfig({ onToolEnd }),
    );

    expect(onToolEnd).toHaveBeenCalledWith(
      "view_area",
      expect.objectContaining({ is_error: true }),
    );
    expect(result.text).toBe("I couldn't find that map.");
  });
});

describe("thinking block filtering", () => {
  it("strips thinking blocks from conversation history", async () => {
    // First response has a thinking block + tool_use, second is text-only
    const thinkingPlusToolMsg: Anthropic.Message = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5-20251001",
      content: [
        { type: "thinking", thinking: "Let me consider...", signature: "sig" } as unknown as Anthropic.ContentBlock,
        { type: "tool_use", id: "toolu_1", name: "roll_dice", input: { notation: "1d20" } },
      ] as Anthropic.ContentBlock[],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: mockUsage(),
    } as Anthropic.Message;

    const createFn = vi.fn()
      .mockResolvedValueOnce(thinkingPlusToolMsg)
      .mockResolvedValueOnce(textMessage("You rolled a 15!"));

    const client = { messages: { create: createFn } } as unknown as Anthropic;

    await agentLoop(
      client,
      "System",
      [{ role: "user", content: "Roll a d20" }],
      new ToolRegistry(),
      mockState(),
      mockConfig(),
    );

    // Second call should have the assistant message WITHOUT the thinking block
    const secondCallArgs = createFn.mock.calls[1][0] as { messages: Anthropic.MessageParam[] };
    const assistantMsg = secondCallArgs.messages.find(
      (m: Anthropic.MessageParam) => m.role === "assistant",
    );
    expect(assistantMsg).toBeDefined();
    const blockTypes = (assistantMsg!.content as Anthropic.ContentBlock[]).map(
      (b: Anthropic.ContentBlock) => b.type,
    );
    expect(blockTypes).not.toContain("thinking");
    expect(blockTypes).toContain("tool_use");
  });
});

describe("stampToolsCacheControl", () => {
  it("stamps cache_control on the last tool", () => {
    const tools: Anthropic.Tool[] = [
      { name: "roll_dice", description: "Roll dice.", input_schema: { type: "object", properties: {} } },
      { name: "draw_card", description: "Draw a card.", input_schema: { type: "object", properties: {} } },
    ];

    const result = stampToolsCacheControl(tools);
    const last = result[result.length - 1] as Record<string, unknown>;
    expect(last["cache_control"]).toEqual({ type: "ephemeral", ttl: "1h" });
    // First tool should NOT have cache_control
    const first = result[0] as Record<string, unknown>;
    expect(first["cache_control"]).toBeUndefined();
  });

  it("does not mutate the input array or tools", () => {
    const tools: Anthropic.Tool[] = [
      { name: "roll_dice", description: "Roll dice.", input_schema: { type: "object", properties: {} } },
    ];

    const result = stampToolsCacheControl(tools);
    // Input array not mutated
    expect(tools).not.toBe(result);
    // Input tool object not mutated
    expect((tools[0] as Record<string, unknown>)["cache_control"]).toBeUndefined();
    // Output has cache_control
    expect((result[0] as Record<string, unknown>)["cache_control"]).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("returns empty array unchanged", () => {
    const result = stampToolsCacheControl([]);
    expect(result).toEqual([]);
  });
});

describe("extractStatus", () => {
  const { extractStatus } = _internal;

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
  });

  it("returns null for unknown errors", () => {
    expect(extractStatus(new Error("something unexpected"))).toBeNull();
    expect(extractStatus("just a string")).toBeNull();
  });
});

describe("retryDelay", () => {
  const { retryDelay } = _internal;

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

describe("retry behavior via agentLoop", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("retries on 529 and eventually succeeds", async () => {
    const overloadedError = Object.assign(new Error("overloaded"), { status: 529 });
    let callCount = 0;
    const client = {
      messages: {
        create: vi.fn(async () => {
          callCount++;
          if (callCount <= 2) throw overloadedError;
          return textMessage("Success after retries");
        }),
      },
    } as unknown as Anthropic;

    const onRetry = vi.fn();
    const promise = agentLoop(
      client,
      "System",
      [{ role: "user", content: "Hi" }],
      new ToolRegistry(),
      mockState(),
      mockConfig({ onRetry }),
    );

    // Advance through both retry delays
    await vi.advanceTimersByTimeAsync(1000); // attempt 0 backoff
    await vi.advanceTimersByTimeAsync(2000); // attempt 1 backoff

    const result = await promise;
    expect(result.text).toBe("Success after retries");
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(529, expect.any(Number));
  });

  it("retries on network errors (ECONNRESET)", async () => {
    let callCount = 0;
    const client = {
      messages: {
        create: vi.fn(async () => {
          callCount++;
          if (callCount === 1) throw new Error("connect ECONNRESET");
          return textMessage("Reconnected");
        }),
      },
    } as unknown as Anthropic;

    const onRetry = vi.fn();
    const promise = agentLoop(
      client,
      "System",
      [{ role: "user", content: "Hi" }],
      new ToolRegistry(),
      mockState(),
      mockConfig({ onRetry }),
    );

    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result.text).toBe("Reconnected");
    expect(onRetry).toHaveBeenCalledWith(0, 1000);
  });

  it("throws immediately on non-retryable errors", async () => {
    const client = {
      messages: {
        create: vi.fn(async () => {
          throw Object.assign(new Error("bad request"), { status: 400 });
        }),
      },
    } as unknown as Anthropic;

    const onError = vi.fn();
    await expect(
      agentLoop(
        client,
        "System",
        [{ role: "user", content: "Hi" }],
        new ToolRegistry(),
        mockState(),
        mockConfig({ onError }),
      ),
    ).rejects.toThrow("bad request");
    expect(onError).toHaveBeenCalled();
  });
});
