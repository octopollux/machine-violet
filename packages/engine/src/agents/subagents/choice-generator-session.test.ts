import { describe, it, expect, vi } from "vitest";
import type { ChatParams, ChatResult, LLMProvider } from "../../providers/types.js";
import { createChoiceGeneratorSession } from "./choice-generator.js";

function mockUsage() {
  return { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };
}

function mockResponse(text: string): ChatResult {
  return {
    text,
    toolCalls: [],
    usage: mockUsage(),
    stopReason: "end",
    assistantContent: [{ type: "text", text }],
  };
}

/**
 * Provider mock that records every ChatParams call so tests can assert on
 * message history, system prompt shape, and cache hints.
 */
function recordingProvider(responses: ChatResult[]) {
  let i = 0;
  const calls: ChatParams[] = [];
  const provider = {
    providerId: "mock",
    chat: vi.fn(async (params: ChatParams) => {
      calls.push(params);
      const r = responses[i++];
      if (!r) throw new Error(`mock exhausted (call #${i})`);
      return r;
    }),
    stream: vi.fn(),
    healthCheck: vi.fn(async () => ({ ok: true })),
  } as unknown as LLMProvider;
  return { provider, calls };
}

const baseOpts = (provider: LLMProvider) => ({
  provider,
  model: "claude-haiku-mock",
  characterSheets: "# Aldric\n**Class:** Rogue\n**Inventory:** poisoned dagger",
});

const turn = (narration: string, playerAction = "I do a thing") => ({
  narration,
  playerAction,
  volatileContext: "<context><active_turn>Aldric</active_turn></context>",
  activeCharacterName: "Aldric",
});

describe("createChoiceGeneratorSession", () => {
  it("returns parsed choices from the first turn", async () => {
    const { provider } = recordingProvider([
      mockResponse("◆ Listen\n◆ Leave\n◆ <color=#cc4444>Strike</color>"),
    ]);
    const session = createChoiceGeneratorSession(baseOpts(provider));
    const result = await session.generate(turn("You see a dusty shop."));

    expect(result.choices).toEqual([
      "◆ Listen",
      "◆ Leave",
      "◆ <color=#cc4444>Strike</color>",
    ]);
    expect(result.usage.inputTokens).toBe(50);
  });

  it("accumulates stored history across turns (but no volatile context)", async () => {
    const { provider, calls } = recordingProvider([
      mockResponse("◆ Ask"),
      mockResponse("◆ Follow"),
      mockResponse("◆ Hide"),
    ]);
    const session = createChoiceGeneratorSession(baseOpts(provider));
    await session.generate(turn("Scene 1", "approach"));
    await session.generate(turn("Scene 2", "speak"));
    await session.generate(turn("Scene 3", "watch"));

    // Turn 3 should have sent: turn-1 user, turn-1 assistant, turn-2 user,
    // turn-2 assistant, turn-3 user (with volatile). 5 messages total.
    const turn3 = calls[2];
    expect(turn3.messages).toHaveLength(5);
    // Prior messages are persisted WITHOUT the volatile `<context>` block.
    expect(turn3.messages[0].role).toBe("user");
    expect(turn3.messages[0].content).not.toContain("<context>");
    expect(turn3.messages[1].role).toBe("assistant");
    expect(turn3.messages[2].role).toBe("user");
    expect(turn3.messages[2].content).not.toContain("<context>");
    // Current turn's user message DOES include volatile context.
    expect(turn3.messages[4].role).toBe("user");
    expect(turn3.messages[4].content).toContain("<context>");

    expect(session.getExchangeCount()).toBe(3);
  });

  it("places character sheets in the cached system prompt (Tier 2)", async () => {
    const { provider, calls } = recordingProvider([mockResponse("◆ Look")]);
    const session = createChoiceGeneratorSession(baseOpts(provider));
    await session.generate(turn("Something happens."));

    const sys = calls[0].systemPrompt;
    expect(Array.isArray(sys)).toBe(true);
    if (Array.isArray(sys)) {
      // Tier 1: core instructions (with 1h cache)
      expect(sys[0].cacheControl).toEqual({ ttl: "1h" });
      // Tier 2: character sheets (also 1h)
      expect(sys[1].cacheControl).toEqual({ ttl: "1h" });
      expect(sys[1].text).toContain("poisoned dagger");
    }
  });

  it("embeds the player action and DM narration into the current user message", async () => {
    const { provider, calls } = recordingProvider([mockResponse("◆ Wait")]);
    const session = createChoiceGeneratorSession(baseOpts(provider));
    await session.generate(turn("The merchant scowls at you.", "I clear my throat"));

    const last = calls[0].messages[calls[0].messages.length - 1];
    expect(typeof last.content).toBe("string");
    expect(last.content as string).toContain("I clear my throat");
    expect(last.content as string).toContain("The merchant scowls at you.");
    expect(last.content as string).toContain("Aldric");
  });

  it("reset() clears history by default", async () => {
    const { provider } = recordingProvider([
      mockResponse("◆ A"),
      mockResponse("◆ B"),
    ]);
    const session = createChoiceGeneratorSession(baseOpts(provider));
    await session.generate(turn("Scene 1"));
    expect(session.getExchangeCount()).toBe(1);

    session.reset();
    expect(session.getExchangeCount()).toBe(0);

    await session.generate(turn("Scene 2"));
    expect(session.getExchangeCount()).toBe(1);
  });

  it("reset(precis) seeds a synthetic exchange for cross-scene continuity", async () => {
    const { provider, calls } = recordingProvider([
      mockResponse("◆ A"),
      mockResponse("◆ B"),
    ]);
    const session = createChoiceGeneratorSession(baseOpts(provider));
    await session.generate(turn("First scene narration."));
    session.reset("The previous scene: you freed the prisoner and the jailor knows your face.");
    expect(session.getExchangeCount()).toBe(1); // the synthetic seed pair

    await session.generate(turn("Second scene narration."));
    // The second turn's messages should include the synthetic seed + the new turn.
    const turn2 = calls[1];
    expect(turn2.messages).toHaveLength(3);
    expect(turn2.messages[0].role).toBe("user");
    expect(turn2.messages[0].content).toContain("freed the prisoner");
    expect(turn2.messages[1].role).toBe("assistant");
  });

  it("parses choices even when the model returns markdown-style bullets", async () => {
    const { provider } = recordingProvider([
      mockResponse("- Climb the wall\n• Wait in the shadows\n1. Bluff the guard"),
    ]);
    const session = createChoiceGeneratorSession(baseOpts(provider));
    const result = await session.generate(turn("..."));
    expect(result.choices).toEqual([
      "Climb the wall",
      "Wait in the shadows",
      "Bluff the guard",
    ]);
  });

  it("caps choices at 6 even if the model returns more", async () => {
    const { provider } = recordingProvider([
      mockResponse("◆ 1\n◆ 2\n◆ 3\n◆ 4\n◆ 5\n◆ 6\n◆ 7\n◆ 8"),
    ]);
    const session = createChoiceGeneratorSession(baseOpts(provider));
    const result = await session.generate(turn("..."));
    expect(result.choices).toHaveLength(6);
  });

  it("omits the sheet block when no character sheets are supplied", async () => {
    const { provider, calls } = recordingProvider([mockResponse("◆ Wait")]);
    const session = createChoiceGeneratorSession({
      provider,
      model: "claude-haiku-mock",
      characterSheets: "",
    });
    await session.generate(turn("..."));

    const sys = calls[0].systemPrompt;
    if (Array.isArray(sys)) {
      expect(sys[1].text.trim()).toBe("");
    }
  });
});
