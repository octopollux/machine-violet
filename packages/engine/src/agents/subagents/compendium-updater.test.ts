import { describe, it, expect, vi, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  emptyCompendium,
  filterPlayerTranscript,
  parseCompendiumOutput,
  renderCompendiumForDM,
  updateCompendium,
} from "./compendium-updater.js";
import { resetPromptCache } from "../../prompts/load-prompt.js";
import type { Compendium, CompendiumEntry } from "@machine-violet/shared/types/compendium.js";

function mockUsage(): Anthropic.Usage {
  return { input_tokens: 50, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null, inference_geo: null, server_tool_use: null, service_tier: null };
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

function entry(overrides: Partial<CompendiumEntry> & { name: string; slug: string }): CompendiumEntry {
  return {
    summary: "",
    firstScene: 1,
    lastScene: 1,
    related: [],
    ...overrides,
  };
}

beforeEach(() => {
  resetPromptCache();
});

// --- emptyCompendium ---

describe("emptyCompendium", () => {
  it("returns valid empty structure", () => {
    const c = emptyCompendium();
    expect(c.version).toBe(1);
    expect(c.lastUpdatedScene).toBe(0);
    expect(c.characters).toEqual([]);
    expect(c.places).toEqual([]);
    expect(c.storyline).toEqual([]);
    expect(c.lore).toEqual([]);
    expect(c.objectives).toEqual([]);
  });
});

// --- filterPlayerTranscript ---

describe("filterPlayerTranscript", () => {
  it("removes tool result lines", () => {
    const transcript = [
      "**DM:** You enter the tavern.",
      "**Aldric:** I look around.",
      "> `roll_dice`: 2d20kh1+5: [18,7]→23",
      "**DM:** You spot a cloaked figure.",
    ].join("\n");

    const filtered = filterPlayerTranscript(transcript);
    expect(filtered).not.toContain("> `roll_dice`");
    expect(filtered).toContain("**DM:** You enter the tavern.");
    expect(filtered).toContain("**Aldric:** I look around.");
    expect(filtered).toContain("**DM:** You spot a cloaked figure.");
  });

  it("preserves transcript with no tool lines", () => {
    const transcript = "**DM:** Hello.\n**Player:** Hi.";
    expect(filterPlayerTranscript(transcript)).toBe(transcript);
  });
});

// --- parseCompendiumOutput ---

describe("parseCompendiumOutput", () => {
  const fallback = emptyCompendium();

  it("parses valid JSON", () => {
    const json = JSON.stringify({
      version: 1,
      lastUpdatedScene: 3,
      characters: [entry({ name: "Mira", slug: "mira", summary: "A smuggler." })],
      places: [],
      storyline: [],
      lore: [],
      objectives: [],
    });

    const result = parseCompendiumOutput(json, fallback);
    expect(result.characters).toHaveLength(1);
    expect(result.characters[0].name).toBe("Mira");
    expect(result.lastUpdatedScene).toBe(3);
  });

  it("strips markdown fences", () => {
    const json = JSON.stringify({
      version: 1,
      lastUpdatedScene: 1,
      characters: [],
      places: [],
      storyline: [],
      lore: [],
      objectives: [],
    });
    const wrapped = "```json\n" + json + "\n```";

    const result = parseCompendiumOutput(wrapped, fallback);
    expect(result.version).toBe(1);
    expect(result.characters).toEqual([]);
  });

  it("returns fallback on invalid JSON", () => {
    const result = parseCompendiumOutput("not json at all", fallback);
    expect(result).toBe(fallback);
  });

  it("returns fallback when category arrays are missing", () => {
    const json = JSON.stringify({ version: 1, lastUpdatedScene: 1, characters: "not an array" });
    const result = parseCompendiumOutput(json, fallback);
    expect(result).toBe(fallback);
  });

  it("ensures version is 1", () => {
    const json = JSON.stringify({
      version: 99,
      lastUpdatedScene: 1,
      characters: [],
      places: [],
      storyline: [],
      lore: [],
      objectives: [],
    });
    const result = parseCompendiumOutput(json, fallback);
    expect(result.version).toBe(1);
  });
});

// --- renderCompendiumForDM ---

describe("renderCompendiumForDM", () => {
  it("renders non-empty categories with wikilinks", () => {
    const compendium: Compendium = {
      version: 1,
      lastUpdatedScene: 5,
      characters: [
        entry({ name: "Mira", slug: "mira", summary: "Ally smuggler" }),
        entry({ name: "Captain Voss", slug: "captain-voss", summary: "Corrupt guard captain" }),
      ],
      places: [entry({ name: "The Undercroft", slug: "the-undercroft", summary: "Hidden tunnel network" })],
      storyline: [],
      lore: [],
      objectives: [entry({ name: "Find the Artifact", slug: "find-the-artifact", summary: "Locate the missing relic in the caves" })],
    };

    const rendered = renderCompendiumForDM(compendium);
    expect(rendered).toContain("Characters: [[Mira]] (ally smuggler), [[Captain Voss]] (corrupt guard captain)");
    expect(rendered).toContain("Places: [[The Undercroft]] (hidden tunnel network)");
    expect(rendered).not.toContain("Storyline:");
    expect(rendered).not.toContain("Lore:");
    expect(rendered).toContain("Objectives: [[Find the Artifact]] (locate the missing relic in the caves)");
  });

  it("returns empty string for empty compendium", () => {
    expect(renderCompendiumForDM(emptyCompendium())).toBe("");
  });

  it("omits long descriptions", () => {
    const compendium: Compendium = {
      ...emptyCompendium(),
      characters: [
        entry({
          name: "Mira",
          slug: "mira",
          summary: "A former smuggler who turned to adventuring after her ship was destroyed in a catastrophic storm off the coast of the Shattered Isles",
        }),
      ],
    };

    const rendered = renderCompendiumForDM(compendium);
    // Long description gets omitted (> 60 chars first clause)
    expect(rendered).toBe("Characters: [[Mira]]");
  });
});

// --- updateCompendium (integration with mock client) ---

describe("updateCompendium", () => {
  it("calls oneShot and parses result", async () => {
    const updated: Compendium = {
      version: 1,
      lastUpdatedScene: 3,
      characters: [entry({ name: "Mira", slug: "mira", summary: "A smuggler." })],
      places: [],
      storyline: [],
      lore: [],
      objectives: [],
    };
    const client = mockClient([textResponse(JSON.stringify(updated))]);

    const result = await updateCompendium(client, emptyCompendium(), "**DM:** You meet Mira.", 3);

    expect(result.compendium.characters).toHaveLength(1);
    expect(result.compendium.characters[0].name).toBe("Mira");
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(80);
  });

  it("falls back to current compendium on bad output", async () => {
    const current = emptyCompendium();
    const client = mockClient([textResponse("I don't understand the request")]);

    const result = await updateCompendium(client, current, "**DM:** Hello.", 1);
    expect(result.compendium).toBe(current);
  });

  it("passes alias context when provided", async () => {
    const client = mockClient([textResponse(JSON.stringify(emptyCompendium()))]);
    await updateCompendium(client, emptyCompendium(), "transcript", 1, "\n\nEntity aliases:\nfoo: Foo");

    const call = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.messages[0].content).toContain("Entity aliases");
  });

  it("filters tool results from transcript before sending", async () => {
    const client = mockClient([textResponse(JSON.stringify(emptyCompendium()))]);
    const transcript = '**DM:** Hello.\n> `roll_dice`: 2d6: [3,4]→7\n**Player:** Hi.';
    await updateCompendium(client, emptyCompendium(), transcript, 1);

    const call = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.messages[0].content).not.toContain("> `roll_dice`");
    expect(call.messages[0].content).toContain("**DM:** Hello.");
  });
});
