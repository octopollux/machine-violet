import { describe, it, expect, vi } from "vitest";
import type { LLMProvider, ChatResult } from "../../providers/types.js";
import { generateChoices, shouldGenerateChoices } from "./choice-generator.js";
import { promoteCharacter } from "./character-promotion.js";

// --- Mock helpers ---

function mockUsage() {
  return { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };
}

function textResponse(text: string): ChatResult {
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
    providerId: "mock",
    chat: vi.fn(async () => responses[callIdx++]),
    stream: vi.fn(async () => responses[callIdx++]),
    healthCheck: vi.fn(async () => ({ ok: true })),
  } as unknown as LLMProvider;
}

// --- Choice generation tests ---

describe("shouldGenerateChoices", () => {
  it("returns false when DM provided choices", () => {
    expect(shouldGenerateChoices("always", true)).toBe(false);
  });

  it("returns true for 'always' frequency", () => {
    expect(shouldGenerateChoices("always", false)).toBe(true);
  });

  it("returns false for 'never' frequency", () => {
    expect(shouldGenerateChoices("never", false)).toBe(false);
  });

  it("accepts legacy 'none' alias as off", () => {
    expect(shouldGenerateChoices("none", false)).toBe(false);
  });

  it("rolls probabilistically for 'sometimes'", () => {
    const spy = vi.spyOn(Math, "random");
    spy.mockReturnValueOnce(0.4);
    expect(shouldGenerateChoices("sometimes", false)).toBe(true);
    spy.mockReturnValueOnce(0.6);
    expect(shouldGenerateChoices("sometimes", false)).toBe(false);
    spy.mockRestore();
  });
});

describe("generateChoices", () => {
  it("parses choices from Haiku response", async () => {
    const provider = mockProvider([
      textResponse("Search the room for hidden passages\nSpeak to the old merchant\nLeave through the back door\nExamine the strange symbol on the wall"),
    ]);

    const result = await generateChoices(provider, "You enter a dusty shop. An old merchant eyes you warily.", "Aldric", undefined, "claude-haiku-4-5-20251001");

    expect(result.choices).toHaveLength(4);
    expect(result.choices[0]).toContain("Search");
    expect(result.usage.inputTokens).toBe(50);
  });

  it("strips bullet markers from choices", async () => {
    const provider = mockProvider([
      textResponse("- Draw your sword\n• Cast a defensive spell\n1. Try to negotiate"),
    ]);

    const result = await generateChoices(provider, "Goblins block the path.", "Aldric", undefined, "claude-haiku-4-5-20251001");

    expect(result.choices[0]).toBe("Draw your sword");
    expect(result.choices[1]).toBe("Cast a defensive spell");
    expect(result.choices[2]).toBe("Try to negotiate");
  });

  it("caps at 6 choices", async () => {
    const provider = mockProvider([
      textResponse("One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight"),
    ]);

    const result = await generateChoices(provider, "...", "Aldric", undefined, "claude-haiku-4-5-20251001");
    expect(result.choices).toHaveLength(6);
  });
});

// --- Character promotion tests ---

describe("promoteCharacter", () => {
  it("parses updated sheet and changelog from response", async () => {
    const provider = mockProvider([
      textResponse(`# Aldric

**Type:** PC
**Level:** 5
**HP:** 42/42

A veteran warrior.

---CHANGELOG---
Level 5: +1 STR (16), Extra Attack, +5 HP (max 42)`),
    ]);

    const result = await promoteCharacter(provider, {
      characterSheet: "# Aldric\n\n**Type:** PC\n**Level:** 4\n**HP:** 37/37",
      context: "Reached level 5 after defeating the dragon",
      characterName: "Aldric",
    }, undefined, "claude-haiku-4-5-20251001");

    expect(result.updatedSheet).toContain("Level:** 5");
    expect(result.updatedSheet).toContain("HP:** 42");
    expect(result.changelogEntry).toContain("Extra Attack");
  });

  it("handles response without changelog separator", async () => {
    const provider = mockProvider([
      textResponse("# Aldric\n\n**Type:** PC\n**Level:** 5\n\nUpdated warrior."),
    ]);

    const result = await promoteCharacter(provider, {
      characterSheet: "# Aldric\n\n**Type:** PC\n**Level:** 4",
      context: "Level up",
      characterName: "Aldric",
    }, undefined, "claude-haiku-4-5-20251001");

    expect(result.updatedSheet).toContain("Level:** 5");
    expect(result.changelogEntry).toBe("Character promoted.");
  });

  it("uses player-facing mode when onStream provided", async () => {
    const provider = mockProvider([
      textResponse("# Rook\n\n**Level:** 4\n---CHANGELOG---\nLevel 4: +1 DEX"),
    ]);

    const onStream = vi.fn();
    await promoteCharacter(
      provider,
      {
        characterSheet: "# Rook",
        context: "Level up",
        characterName: "Rook",
      },
      onStream,
      "claude-haiku-4-5-20251001",
    );

    expect(provider.stream).toHaveBeenCalled();
  });
});
