import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { PlayerConfig } from "../../types/config.js";
import { buildAIPlayerPrompt, aiPlayerTurn } from "./ai-player.js";
import type { AIPlayerContext } from "./ai-player.js";

function mockUsage(): Anthropic.Usage {
  return { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
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

function mockClient(responses: Anthropic.Message[]): Anthropic {
  let callIdx = 0;
  return {
    messages: {
      create: vi.fn(async () => responses[callIdx++]),
      stream: vi.fn(() => ({
        on: vi.fn(),
        finalMessage: vi.fn(async () => responses[callIdx++]),
      })),
    },
  } as unknown as Anthropic;
}

function makePlayer(overrides?: Partial<PlayerConfig>): PlayerConfig {
  return {
    name: "TestPlayer",
    character: "Aldric",
    type: "ai",
    ...overrides,
  };
}

function makeContext(overrides?: Partial<AIPlayerContext>): AIPlayerContext {
  return {
    player: makePlayer(),
    characterSheet: "Fighter, HP 20/20, STR 16",
    recentNarration: "The goblin snarls and raises its blade.",
    ...overrides,
  };
}

describe("buildAIPlayerPrompt", () => {
  it("includes character name", () => {
    const prompt = buildAIPlayerPrompt(makeContext());
    expect(prompt).toContain("You are Aldric");
  });

  it("includes personality when set", () => {
    const ctx = makeContext({ player: makePlayer({ personality: "Reckless and brave" }) });
    const prompt = buildAIPlayerPrompt(ctx);
    expect(prompt).toContain("Personality: Reckless and brave");
  });

  it("includes situation when set", () => {
    const ctx = makeContext({ situation: "In a dark cave, torches flickering" });
    const prompt = buildAIPlayerPrompt(ctx);
    expect(prompt).toContain("Current situation: In a dark cave, torches flickering");
  });

  it("omits personality and situation when absent", () => {
    const prompt = buildAIPlayerPrompt(makeContext());
    expect(prompt).not.toContain("Personality:");
    expect(prompt).not.toContain("Current situation:");
    expect(prompt).not.toContain("undefined");
  });
});

describe("aiPlayerTurn", () => {
  it("returns trimmed action", async () => {
    const client = mockClient([textResponse("  I swing my sword at the goblin.  ")]);
    const result = await aiPlayerTurn(client, makeContext());
    expect(result.action).toBe("I swing my sword at the goblin.");
  });

  it("uses fallback when recentNarration is empty", async () => {
    const client = mockClient([textResponse("I look around.")]);
    await aiPlayerTurn(client, makeContext({ recentNarration: "" }));

    const call = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.messages[0].content).toBe("It's your turn. What do you do?");
  });

  it("defaults to small model (haiku)", async () => {
    const client = mockClient([textResponse("Action.")]);
    await aiPlayerTurn(client, makeContext());

    const call = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.model).toContain("haiku");
  });

  it("uses medium model for sonnet players", async () => {
    const client = mockClient([textResponse("Action.")]);
    await aiPlayerTurn(client, makeContext({ player: makePlayer({ model: "sonnet" }) }));

    const call = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.model).toContain("sonnet");
  });

  it("returns usage stats", async () => {
    const client = mockClient([textResponse("Done.")]);
    const result = await aiPlayerTurn(client, makeContext());
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(20);
  });
});
