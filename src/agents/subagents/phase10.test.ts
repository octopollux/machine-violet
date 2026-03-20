import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { generateChoices, shouldGenerateChoices } from "./choice-generator.js";
import { promoteCharacter } from "./character-promotion.js";

// --- Mock helpers ---

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

// --- Choice generation tests ---

describe("shouldGenerateChoices", () => {
  it("returns false when DM provided choices", () => {
    expect(shouldGenerateChoices("always", true)).toBe(false);
  });

  it("returns true for 'always' frequency", () => {
    expect(shouldGenerateChoices("always", false)).toBe(true);
  });

  it("returns false for 'none' frequency", () => {
    expect(shouldGenerateChoices("none", false)).toBe(false);
  });
});

describe("generateChoices", () => {
  it("parses choices from Haiku response", async () => {
    const client = mockClient([
      textResponse("Search the room for hidden passages\nSpeak to the old merchant\nLeave through the back door\nExamine the strange symbol on the wall"),
    ]);

    const result = await generateChoices(client, "You enter a dusty shop. An old merchant eyes you warily.", "Aldric");

    expect(result.choices).toHaveLength(4);
    expect(result.choices[0]).toContain("Search");
    expect(result.usage.inputTokens).toBe(50);
  });

  it("strips bullet markers from choices", async () => {
    const client = mockClient([
      textResponse("- Draw your sword\n• Cast a defensive spell\n1. Try to negotiate"),
    ]);

    const result = await generateChoices(client, "Goblins block the path.", "Aldric");

    expect(result.choices[0]).toBe("Draw your sword");
    expect(result.choices[1]).toBe("Cast a defensive spell");
    expect(result.choices[2]).toBe("Try to negotiate");
  });

  it("caps at 6 choices", async () => {
    const client = mockClient([
      textResponse("One\nTwo\nThree\nFour\nFive\nSix\nSeven\nEight"),
    ]);

    const result = await generateChoices(client, "...", "Aldric");
    expect(result.choices).toHaveLength(6);
  });
});

// --- Character promotion tests ---

describe("promoteCharacter", () => {
  it("parses updated sheet and changelog from response", async () => {
    const client = mockClient([
      textResponse(`# Aldric

**Type:** PC
**Level:** 5
**HP:** 42/42

A veteran warrior.

---CHANGELOG---
Level 5: +1 STR (16), Extra Attack, +5 HP (max 42)`),
    ]);

    const result = await promoteCharacter(client, {
      characterSheet: "# Aldric\n\n**Type:** PC\n**Level:** 4\n**HP:** 37/37",
      context: "Reached level 5 after defeating the dragon",
      characterName: "Aldric",
    });

    expect(result.updatedSheet).toContain("Level:** 5");
    expect(result.updatedSheet).toContain("HP:** 42");
    expect(result.changelogEntry).toContain("Extra Attack");
  });

  it("handles response without changelog separator", async () => {
    const client = mockClient([
      textResponse("# Aldric\n\n**Type:** PC\n**Level:** 5\n\nUpdated warrior."),
    ]);

    const result = await promoteCharacter(client, {
      characterSheet: "# Aldric\n\n**Type:** PC\n**Level:** 4",
      context: "Level up",
      characterName: "Aldric",
    });

    expect(result.updatedSheet).toContain("Level:** 5");
    expect(result.changelogEntry).toBe("Character promoted.");
  });

  it("uses player-facing mode when onStream provided", async () => {
    const client = mockClient([
      textResponse("# Rook\n\n**Level:** 4\n---CHANGELOG---\nLevel 4: +1 DEX"),
    ]);

    const onStream = vi.fn();
    await promoteCharacter(
      client,
      {
        characterSheet: "# Rook",
        context: "Level up",
        characterName: "Rook",
      },
      onStream,
    );

    expect(client.messages.stream).toHaveBeenCalled();
  });
});
