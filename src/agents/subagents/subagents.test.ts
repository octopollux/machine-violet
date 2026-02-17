import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { summarizeScene } from "./scene-summarizer.js";
import { updatePrecis } from "./precis-updater.js";
import { updateChangelogs } from "./changelog-updater.js";
import { resolveAction } from "./resolve-action.js";

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
      stream: vi.fn(() => ({
        on: vi.fn(),
        finalMessage: vi.fn(async () => responses[callIdx++]),
      })),
    },
  } as unknown as Anthropic;
}

describe("summarizeScene", () => {
  it("returns campaign log entry", async () => {
    const client = mockClient([
      textResponse("- [Aldric](../characters/aldric.md) entered the throne room\n- Fought [G1](../characters/g1.md), eliminated R4"),
    ]);

    const result = await summarizeScene(client, "## Scene transcript\n[Aldric] I enter the throne room...");

    expect(result.text).toContain("Aldric");
    expect(result.text).toContain("throne room");
    expect(result.usage.inputTokens).toBe(50);
  });

  it("passes terse system prompt", async () => {
    const client = mockClient([textResponse("Summary.")]);
    await summarizeScene(client, "transcript");

    const call = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.system).toContain("terse");
    expect(call.system).toContain("wikilinks");
  });
});

describe("updatePrecis", () => {
  it("returns precis append", async () => {
    const client = mockClient([
      textResponse("R4: Aldric hit G1 for 9 slash. G1: 3/12 HP."),
    ]);

    const result = await updatePrecis(
      client,
      "Scene 14: Combat in throne room. R1-R3: ...",
      "[Aldric] I swing my longsword at the goblin.\nDM: The blade bites deep...",
    );

    expect(result.text).toContain("G1");
  });
});

describe("updateChangelogs", () => {
  it("returns entity changelog entries", async () => {
    const client = mockClient([
      textResponse("aldric.md: Took 14 damage in throne room combat, eliminated G1\ng1.md: Eliminated by Aldric in Scene 14"),
    ]);

    const result = await updateChangelogs(
      client,
      "## Transcript\nAldric fights G1...",
      14,
      ["aldric.md", "g1.md", "mayor-graves.md"],
    );

    expect(result.text).toContain("aldric.md");
    expect(result.text).toContain("g1.md");
    // mayor-graves wasn't involved, shouldn't be mentioned
  });
});

describe("resolveAction", () => {
  it("resolves an attack with roll_dice", async () => {
    const client = mockClient([
      toolUseResponse("roll_dice", { expression: "1d20+5" }),
      textResponse("Hit (23 vs AC 13). 9 slashing. G1: 3/12 HP."),
    ]);

    const result = await resolveAction(client, {
      actor: "Aldric",
      action: "Longsword attack",
      target: "G1",
      actorSheet: "STR +5, Longsword: 1d20+5 to hit, 1d8+3 damage",
      targetStats: "AC 13, HP 12/12",
    });

    expect(result.text).toContain("Hit");
    expect(result.text).toContain("G1");
  });

  it("works without target", async () => {
    const client = mockClient([
      toolUseResponse("roll_dice", { expression: "1d20+3" }),
      textResponse("Success (18 vs DC 15). Lock picked."),
    ]);

    const result = await resolveAction(client, {
      actor: "Aldric",
      action: "Pick lock",
      conditions: "Dim light, half cover",
      actorSheet: "DEX +3, Thieves' tools proficiency",
    });

    expect(result.text).toContain("Success");
  });

  it("streams for player-facing mode", async () => {
    const client = mockClient([
      textResponse("Use Divine Smite on this hit?"),
    ]);

    const onStream = vi.fn();
    await resolveAction(
      client,
      {
        actor: "Aldric",
        action: "Attack with smite option",
        actorSheet: "Paladin, 2 spell slots",
      },
      onStream,
    );

    // Should use stream() for player-facing
    expect(client.messages.stream).toHaveBeenCalled();
  });
});
