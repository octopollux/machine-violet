import { describe, it, expect, vi } from "vitest";
import type { LLMProvider, ChatResult, NormalizedUsage } from "../../providers/types.js";
import type { PlayerConfig } from "@machine-violet/shared/types/config.js";
import { buildAIPlayerPrompt, aiPlayerTurn } from "./ai-player.js";
import type { AIPlayerContext } from "./ai-player.js";

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
    const provider = mockProvider([textResult("  I swing my sword at the goblin.  ")]);
    const result = await aiPlayerTurn(provider, makeContext(), "claude-haiku-4-5-20251001");
    expect(result.action).toBe("I swing my sword at the goblin.");
  });

  it("uses fallback when recentNarration is empty", async () => {
    const provider = mockProvider([textResult("I look around.")]);
    await aiPlayerTurn(provider, makeContext({ recentNarration: "" }), "claude-haiku-4-5-20251001");

    const call = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.messages[0].content).toBe("It's your turn. What do you do?");
  });

  it("uses the model the caller passes (haiku)", async () => {
    // Tier resolution moved to the caller (game-engine.ts maps player.model to
    // small or medium tier). aiPlayerTurn now just trusts the passed model.
    const provider = mockProvider([textResult("Action.")]);
    await aiPlayerTurn(provider, makeContext(), "claude-haiku-4-5-20251001");

    const call = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.model).toContain("haiku");
  });

  it("uses the model the caller passes (sonnet)", async () => {
    const provider = mockProvider([textResult("Action.")]);
    await aiPlayerTurn(provider, makeContext({ player: makePlayer({ model: "sonnet" }) }), "claude-sonnet-4-6");

    const call = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.model).toContain("sonnet");
  });

  it("returns usage stats", async () => {
    const provider = mockProvider([textResult("Done.")]);
    const result = await aiPlayerTurn(provider, makeContext(), "claude-haiku-4-5-20251001");
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(20);
  });
});
