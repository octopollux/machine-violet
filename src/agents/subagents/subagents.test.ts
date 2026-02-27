import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { summarizeScene } from "./scene-summarizer.js";
import { updatePrecis, parsePrecisResult } from "./precis-updater.js";
import { updateChangelogs } from "./changelog-updater.js";
import { resolveAction } from "./resolve-action.js";

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

  it("extracts player read from response with PLAYER_READ block", async () => {
    const client = mockClient([
      textResponse('R4: Aldric hit G1 for 9 slash. G1: 3/12 HP.\nPLAYER_READ: {"engagement":"high","focus":["combat"],"tone":"aggressive","pacing":"pushing_forward","offScript":false}'),
    ]);

    const result = await updatePrecis(
      client,
      "Scene 14: Combat in throne room. R1-R3: ...",
      "[Aldric] I swing my longsword at the goblin.\nDM: The blade bites deep...",
    );

    expect(result.text).toContain("G1");
    expect(result.text).not.toContain("PLAYER_READ");
    expect(result.playerRead).toBeDefined();
    expect(result.playerRead!.engagement).toBe("high");
    expect(result.playerRead!.focus).toEqual(["combat"]);
    expect(result.playerRead!.tone).toBe("aggressive");
    expect(result.playerRead!.pacing).toBe("pushing_forward");
    expect(result.playerRead!.offScript).toBe(false);
  });

  it("returns undefined playerRead when PLAYER_READ block is missing", async () => {
    const client = mockClient([
      textResponse("R4: Aldric hit G1 for 9 slash. G1: 3/12 HP."),
    ]);

    const result = await updatePrecis(
      client,
      "Scene 14: Combat in throne room. R1-R3: ...",
      "[Aldric] I swing my longsword at the goblin.\nDM: The blade bites deep...",
    );

    expect(result.playerRead).toBeUndefined();
  });
});

describe("parsePrecisResult", () => {
  it("parses well-formed PLAYER_READ block", () => {
    const result = parsePrecisResult({
      text: 'Aldric entered the cave.\nPLAYER_READ: {"engagement":"moderate","focus":["exploration","puzzle"],"tone":"cautious","pacing":"exploratory","offScript":true}',
      usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });

    expect(result.text).toBe("Aldric entered the cave.");
    expect(result.playerRead).toEqual({
      engagement: "moderate",
      focus: ["exploration", "puzzle"],
      tone: "cautious",
      pacing: "exploratory",
      offScript: true,
    });
  });

  it("returns undefined playerRead for malformed JSON", () => {
    const result = parsePrecisResult({
      text: "Aldric entered the cave.\nPLAYER_READ: {not valid json}",
      usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });

    expect(result.text).toBe("Aldric entered the cave.");
    expect(result.playerRead).toBeUndefined();
  });

  it("returns full text when no PLAYER_READ line", () => {
    const result = parsePrecisResult({
      text: "Aldric entered the cave. Found a torch.",
      usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });

    expect(result.text).toBe("Aldric entered the cave. Found a torch.");
    expect(result.playerRead).toBeUndefined();
  });

  it("parses OPEN: line and strips it from precis text", () => {
    const result = parsePrecisResult({
      text: '[[Mira]] served drinks, seemed nervous.\nOPEN: [[Mira]]\'s nervousness, [[Corvin]]\'s offer\nPLAYER_READ: {"engagement":"high","focus":["npc_interaction"],"tone":"curious","pacing":"exploratory","offScript":false}',
      usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });

    expect(result.text).toBe("[[Mira]] served drinks, seemed nervous.");
    expect(result.openThreads).toBe("[[Mira]]'s nervousness, [[Corvin]]'s offer");
    expect(result.playerRead?.engagement).toBe("high");
  });

  it("returns undefined openThreads when OPEN: line is absent", () => {
    const result = parsePrecisResult({
      text: 'Corvin paid and left.\nPLAYER_READ: {"engagement":"moderate","focus":["npc_interaction"],"tone":"cautious","pacing":"pushing_forward","offScript":false}',
      usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });

    expect(result.openThreads).toBeUndefined();
    expect(result.text).toBe("Corvin paid and left.");
  });

  it("handles OPEN: without PLAYER_READ", () => {
    const result = parsePrecisResult({
      text: "Aldric searched the room.\nOPEN: hidden compartment",
      usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });

    expect(result.text).toBe("Aldric searched the room.");
    expect(result.openThreads).toBe("hidden compartment");
    expect(result.playerRead).toBeUndefined();
  });
});

describe("updatePrecis open threads", () => {
  it("passes currentOpenThreads into the prompt", async () => {
    const client = mockClient([
      textResponse("Aldric questioned [[Mira]].\nOPEN: [[Mira]]'s fear\nPLAYER_READ: {\"engagement\":\"high\",\"focus\":[\"npc_interaction\"],\"tone\":\"curious\",\"pacing\":\"exploratory\",\"offScript\":false}"),
    ]);

    await updatePrecis(
      client,
      "Scene 1: Aldric entered the tavern.",
      "Player: I ask Mira what's wrong.\nDM: She shakes her head.",
      "[[Mira]]'s nervousness",
    );

    const call = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.messages[0].content).toContain("[[Mira]]'s nervousness");
  });

  it("returns openThreads from OPEN: line", async () => {
    const client = mockClient([
      textResponse("Aldric questioned [[Mira]].\nOPEN: [[Mira]]'s fear, [[stranger]]'s identity\nPLAYER_READ: {\"engagement\":\"high\",\"focus\":[\"npc_interaction\"],\"tone\":\"cautious\",\"pacing\":\"exploratory\",\"offScript\":false}"),
    ]);

    const result = await updatePrecis(
      client,
      "Scene 1: Tavern.",
      "Player: I press Mira.\nDM: She glances at the door.",
    );

    expect(result.openThreads).toBe("[[Mira]]'s fear, [[stranger]]'s identity");
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
