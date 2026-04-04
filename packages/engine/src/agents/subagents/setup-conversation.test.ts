import { describe, it, expect, vi } from "vitest";
import type { LLMProvider, ChatResult, NormalizedUsage } from "../../providers/types.js";
import { createSetupConversation } from "./setup-conversation.js";

function mockUsage(input = 50, output = 20): NormalizedUsage {
  return { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };
}

function textResponse(text: string, usage?: NormalizedUsage): ChatResult {
  return {
    text,
    toolCalls: [],
    usage: usage ?? mockUsage(),
    stopReason: "end",
    assistantContent: [{ type: "text", text }],
  };
}

function presentChoicesResponse(text: string, prompt: string, choices: string[]): ChatResult {
  return {
    text,
    toolCalls: [{ id: "toolu_choices_1", name: "present_choices", input: { prompt, choices } }],
    usage: mockUsage(),
    stopReason: "tool_use",
    assistantContent: [
      { type: "text", text },
      { type: "tool_use", id: "toolu_choices_1", name: "present_choices", input: { prompt, choices } },
    ],
  };
}

function finalizeResponse(input: Record<string, unknown>): ChatResult {
  return {
    text: "",
    toolCalls: [{ id: "toolu_finalize_1", name: "finalize_setup", input }],
    usage: mockUsage(),
    stopReason: "tool_use",
    assistantContent: [
      { type: "tool_use", id: "toolu_finalize_1", name: "finalize_setup", input },
    ],
  };
}

function mockProvider(responses: ChatResult[]): LLMProvider {
  let callIdx = 0;
  return {
    providerId: "mock",
    chat: vi.fn(async () => responses[callIdx++]),
    stream: vi.fn(async () => responses[callIdx++]),
    healthCheck: vi.fn(async () => ({ ok: true })),
  } as unknown as LLMProvider;
}

const FINALIZE_INPUT = {
  genre: "Dark fantasy",
  system: null,
  campaign_name: "Shadows of Eldara",
  campaign_premise: "Darkness rises in the ancient kingdom.",
  mood: "Grimdark",
  difficulty: "Balanced",
  dm_personality: "The Chronicler",
  player_name: "Alex",
  character_name: "Kael",
  character_description: "A scarred ranger seeking redemption",
};

const noop = () => {};

describe("createSetupConversation", () => {
  it("start() returns opening text", async () => {
    const provider = mockProvider([textResponse("Welcome, brave soul!")]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    const result = await conv.start(noop);
    expect(result.text).toBe("Welcome, brave soul!");
  });

  it("start() uses stream", async () => {
    const provider = mockProvider([textResponse("Welcome!")]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    await conv.start(noop);
    expect(provider.stream).toHaveBeenCalled();
  });

  it("send() returns text response", async () => {
    const provider = mockProvider([
      textResponse("Welcome!"),
      textResponse("Great choice! Dark fantasy it is."),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    await conv.start(noop);
    const result = await conv.send("I want dark fantasy", noop);
    expect(result.text).toBe("Great choice! Dark fantasy it is.");
  });

  it("present_choices returns pendingChoices", async () => {
    const provider = mockProvider([
      presentChoicesResponse(
        "What kind of world excites you?",
        "Choose your genre:",
        ["Classic Fantasy", "Sci-Fi", "Modern Supernatural"],
      ),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    const result = await conv.start(noop);

    expect(result.pendingChoices).toBeDefined();
    expect(result.pendingChoices!.prompt).toBe("Choose your genre:");
    expect(result.pendingChoices!.choices).toEqual(["Classic Fantasy", "Sci-Fi", "Modern Supernatural"]);
  });

  it("resolveChoice() sends selection and gets follow-up", async () => {
    const provider = mockProvider([
      presentChoicesResponse("Pick one:", "Genre:", ["Fantasy", "Sci-Fi"]),
      textResponse("Fantasy it is! Now tell me about your character."),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    await conv.start(noop);

    const result = await conv.resolveChoice("Fantasy", noop);
    expect(result.text).toBe("Fantasy it is! Now tell me about your character.");
  });

  it("resolveChoice() throws when no pending choice", async () => {
    const provider = mockProvider([textResponse("Hello!")]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    await conv.start(noop);

    await expect(conv.resolveChoice("anything", noop)).rejects.toThrow("No pending choice to resolve");
  });

  it("finalize_setup populates finalized result", async () => {
    const provider = mockProvider([
      finalizeResponse(FINALIZE_INPUT),
      textResponse("Farewell, brave adventurer!"),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    const result = await conv.start(noop);

    expect(result.finalized).toBeDefined();
    expect(result.finalized!.campaignName).toBe("Shadows of Eldara");
    expect(result.finalized!.genre).toBe("Dark fantasy");
    expect(result.finalized!.characterName).toBe("Kael");
    expect(result.finalized!.playerName).toBe("Alex");
    expect(result.finalized!.difficulty).toBe("Balanced");
    expect(result.finalized!.personality.name).toBe("The Chronicler");
    expect(result.finalized!.characterDetails).toBeNull();
  });

  it("finalize_setup passes through characterDetails", async () => {
    const input = { ...FINALIZE_INPUT, system: "dnd-5e", character_details: "Human Fighter, level 1, soldier background" };
    const provider = mockProvider([
      finalizeResponse(input),
      textResponse("May your blade stay sharp!"),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    const result = await conv.start(noop);

    expect(result.finalized).toBeDefined();
    expect(result.finalized!.characterDetails).toBe("Human Fighter, level 1, soldier background");
    expect(result.finalized!.system).toBe("dnd-5e");
  });

  it("finalize_setup triggers farewell follow-up", async () => {
    const provider = mockProvider([
      finalizeResponse(FINALIZE_INPUT),
      textResponse("May your blade stay sharp!"),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    const result = await conv.start(noop);

    // Two stream calls: the finalize response + the farewell follow-up
    expect(provider.stream).toHaveBeenCalledTimes(2);
    expect(result.text).toContain("May your blade stay sharp!");
  });

  it("send() after dismissed choice includes tool_result", async () => {
    const provider = mockProvider([
      presentChoicesResponse("Pick one:", "Genre:", ["Fantasy", "Sci-Fi"]),
      textResponse("Interesting! Tell me more about that."),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    await conv.start(noop);

    // User dismisses the choice modal and types free-form text instead
    const result = await conv.send("I want a pirate adventure", noop);
    expect(result.text).toBe("Interesting! Tell me more about that.");

    // Verify the message sent to the API included a tool_result (not plain text)
    const streamCalls = (provider.stream as ReturnType<typeof vi.fn>).mock.calls;
    const secondCall = streamCalls[1][0];
    const userMsg = secondCall.messages.find(
      (m: { role: string; content?: unknown }) => m.role === "user" && Array.isArray(m.content),
    );
    expect(userMsg).toBeDefined();
    expect(userMsg.content[0].type).toBe("tool_result");
    expect(userMsg.content[0].tool_use_id).toBe("toolu_choices_1");
    expect(userMsg.content[0].content).toContain("I want a pirate adventure");
  });

  it("system prompt includes complexity tiers and chargen rules", async () => {
    const provider = mockProvider([textResponse("Welcome!")]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    await conv.start(noop);

    const streamCalls = (provider.stream as ReturnType<typeof vi.fn>).mock.calls;
    const systemPrompt = streamCalls[0][0].systemPrompt as string;

    // Verify tiered system groups
    expect(systemPrompt).toContain("Light systems");
    expect(systemPrompt).toContain("Crunchy systems");

    // Verify descriptions are included
    expect(systemPrompt).toContain("Micro-RPG framework");
    expect(systemPrompt).toContain("Classic d20 system");

    // Verify chargen rules are injected
    expect(systemPrompt).toContain("Character creation rules by system");
    expect(systemPrompt).toContain("High concept");  // from FATE
    expect(systemPrompt).toContain("Choose race");    // from D&D
  });

  it("finalize_setup treats literal string 'null' system as null", async () => {
    const input = { ...FINALIZE_INPUT, system: "null" };
    const provider = mockProvider([
      finalizeResponse(input),
      textResponse("Adventure awaits!"),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    const result = await conv.start(noop);

    expect(result.finalized).toBeDefined();
    expect(result.finalized!.system).toBeNull();
  });

  it("finalize_setup treats literal string 'none' system as null", async () => {
    const input = { ...FINALIZE_INPUT, system: "None" };
    const provider = mockProvider([
      finalizeResponse(input),
      textResponse("Adventure awaits!"),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    const result = await conv.start(noop);

    expect(result.finalized).toBeDefined();
    expect(result.finalized!.system).toBeNull();
  });

  it("system prompt includes Known Players section when players provided", async () => {
    const provider = mockProvider([textResponse("Welcome!")]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6", [
      { name: "Alice", ageGroup: "adult" },
      { name: "Bob", ageGroup: "teenager" },
    ]);
    await conv.start(noop);

    const streamCalls = (provider.stream as ReturnType<typeof vi.fn>).mock.calls;
    const systemPrompt = streamCalls[0][0].systemPrompt as string;

    expect(systemPrompt).toContain("## Known Players");
    expect(systemPrompt).toContain("Alice (age group: adult)");
    expect(systemPrompt).toContain("Bob (age group: teenager)");
    expect(systemPrompt).toContain("present_choices");
  });

  it("Known Players section appears before campaign seeds", async () => {
    const provider = mockProvider([textResponse("Welcome!")]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6", [
      { name: "Alice", ageGroup: "adult" },
    ]);
    await conv.start(noop);

    const streamCalls = (provider.stream as ReturnType<typeof vi.fn>).mock.calls;
    const systemPrompt = streamCalls[0][0].systemPrompt as string;

    const knownIdx = systemPrompt.indexOf("## Known Players");
    const seedsIdx = systemPrompt.indexOf("## Available campaign seeds");
    expect(knownIdx).toBeGreaterThan(-1);
    expect(seedsIdx).toBeGreaterThan(-1);
    expect(knownIdx).toBeLessThan(seedsIdx);
  });

  it("single known player still uses present_choices instruction", async () => {
    const provider = mockProvider([textResponse("Welcome!")]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6", [
      { name: "Alice", ageGroup: "adult" },
    ]);
    await conv.start(noop);

    const streamCalls = (provider.stream as ReturnType<typeof vi.fn>).mock.calls;
    const systemPrompt = streamCalls[0][0].systemPrompt as string;

    expect(systemPrompt).toContain("## Known Players");
    expect(systemPrompt).toContain("present_choices");
    expect(systemPrompt).toContain("Alice (age group: adult)");
  });

  it("system prompt omits Known Players section when no players provided", async () => {
    const provider = mockProvider([textResponse("Welcome!")]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    await conv.start(noop);

    const streamCalls = (provider.stream as ReturnType<typeof vi.fn>).mock.calls;
    const systemPrompt = streamCalls[0][0].systemPrompt as string;

    expect(systemPrompt).not.toContain("## Known Players");
  });

  it("player names are sanitized in Known Players section", async () => {
    const provider = mockProvider([textResponse("Welcome!")]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6", [
      { name: "Alice<script>", ageGroup: "adult" },
      { name: "Bob\nEvil", ageGroup: "teenager" },
    ]);
    await conv.start(noop);

    const streamCalls = (provider.stream as ReturnType<typeof vi.fn>).mock.calls;
    const systemPrompt = streamCalls[0][0].systemPrompt as string;

    expect(systemPrompt).toContain("Alicescript");
    expect(systemPrompt).toContain("Bob Evil");
    expect(systemPrompt).not.toContain("<script>");
    expect(systemPrompt).not.toContain("\n- Bob\n");
  });

  it("caps known players at 9", async () => {
    const players = Array.from({ length: 12 }, (_, i) => ({ name: `Player${i}` }));
    const provider = mockProvider([textResponse("Welcome!")]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6", players);
    await conv.start(noop);

    const streamCalls = (provider.stream as ReturnType<typeof vi.fn>).mock.calls;
    const systemPrompt = streamCalls[0][0].systemPrompt as string;

    expect(systemPrompt).toContain("Player0");
    expect(systemPrompt).toContain("Player8");
    expect(systemPrompt).not.toContain("Player9");
  });

  it("usage accumulates across turns", async () => {
    const provider = mockProvider([
      textResponse("Welcome!", mockUsage(100, 30)),
      textResponse("Great!", mockUsage(80, 25)),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");

    await conv.start(noop);
    const result = await conv.send("dark fantasy", noop);

    expect(result.usage.inputTokens).toBe(180);
    expect(result.usage.outputTokens).toBe(55);
  });
});
