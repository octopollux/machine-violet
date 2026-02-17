import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { agentLoop } from "./agent-loop.js";
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
