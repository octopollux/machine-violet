import { describe, it, expect, vi } from "vitest";
import type { LLMProvider, ChatResult, NormalizedUsage, SystemBlock } from "../../providers/types.js";

// Mock loadWorldBySlug so we can test world_slug resolution without real .mvworld files
vi.mock("../../config/world-loader.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    loadWorldBySlug: vi.fn((slug: string) => {
      if (slug === "the-shattered-crown") {
        return { name: "The Shattered Crown", summary: "A kingdom torn apart", genres: ["fantasy"], detail: "Secret detail about the crown." };
      }
      if (slug === "scoped-seed") {
        return { name: "Scoped Seed", summary: "A seed with a baked-in scope.", genres: ["fantasy"], detail: "Some detail.", campaign_scope: "open-ended" };
      }
      if (slug === "forked-seed") {
        return {
          name: "Forked Seed", summary: "A seed with forks.", genres: ["fantasy"],
          detail: "Base premise.",
          forks: [
            { id: "wrapper", label: "Genre wrapper", chooser: "agent", options: [
              { id: "fantasy", name: "Fantasy", description: "stone", detail: "Temples of stone." },
              { id: "scifi", name: "Sci-Fi", description: "servers", detail: "Server farms." },
            ] },
            { id: "faction", label: "Your faction", chooser: "player", options: [
              { id: "iron", name: "Iron", description: "military" },
              { id: "gold", name: "Gold", description: "merchants" },
            ] },
          ],
        };
      }
      return undefined;
    }),
  };
});

// Spy on the personality loader so we can assert userPersonalitiesDir threading
// without depending on the contents of the personalities/ directory.
vi.mock("../../config/personality-loader.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    loadAllPersonalities: vi.fn((userDir?: string) => {
      const original = actual.loadAllPersonalities as (d?: string) => unknown[];
      return original(userDir);
    }),
    getPersonality: vi.fn((name: string, userDir?: string) => {
      const original = actual.getPersonality as (n: string, d?: string) => unknown;
      return original(name, userDir);
    }),
  };
});

import { createSetupConversation, renderWorldForAgent } from "./setup-conversation.js";
import type { WorldFile } from "@machine-violet/shared/types/world.js";

/** Flatten SystemBlock[] | string to a single string for content assertions. */
function flattenSystem(sp: string | SystemBlock[]): string {
  if (typeof sp === "string") return sp;
  return sp.map((b) => b.text).join("");
}

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

/** Empty refusal — what providers that don't throw on system failure return. */
function refusalResponse(): ChatResult {
  return {
    text: "",
    toolCalls: [],
    usage: mockUsage(0, 0),
    stopReason: "refusal",
    assistantContent: [],
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

describe("renderWorldForAgent setup_detail channel", () => {
  const base: WorldFile = {
    format: "machine-violet-world", version: 1, name: "W", summary: "s", genres: ["fantasy"],
  };

  it("surfaces setup_detail to the agent while excluding the DM-only detail", () => {
    const out = renderWorldForAgent({ ...base, detail: "DM-SECRET-BASE", setup_detail: "Present the rhythm options." });
    expect(out).toContain("Setup-only guidance");
    expect(out).toContain("Present the rhythm options.");
    // The DM-only base detail must never appear in the agent's view.
    expect(out).not.toContain("DM-SECRET-BASE");
  });

  it("expands includes (and dot-variants) inside setup_detail", () => {
    const out = renderWorldForAgent({ ...base, setup_detail: "<!--include:Pacing.EndlessCampaigns-->" });
    // The EndlessCampaigns block resolved into the agent's view...
    expect(out).toContain("Open-Ended");
    expect(out).toContain("Serialized");
    // ...and the raw directive is gone.
    expect(out).not.toContain("<!--include:");
  });

  it("omits the section entirely when there is no setup_detail", () => {
    expect(renderWorldForAgent(base)).not.toContain("Setup-only guidance");
  });
});

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

  it("hasPendingChoice tracks the present_choices lifecycle", async () => {
    const provider = mockProvider([
      presentChoicesResponse("Pick:", "Genre:", ["Fantasy", "Sci-Fi"]),
      textResponse("Fantasy it is."),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");

    expect(conv.hasPendingChoice).toBe(false);

    await conv.start(noop);
    expect(conv.hasPendingChoice).toBe(true);

    await conv.resolveChoice("Fantasy", noop);
    expect(conv.hasPendingChoice).toBe(false);
  });

  it("resolveChoice() throws when no pending choice", async () => {
    const provider = mockProvider([textResponse("Hello!")]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    await conv.start(noop);

    await expect(conv.resolveChoice("anything", noop)).rejects.toThrow("No pending choice to resolve");
  });

  it("throws a clear error when the provider returns an empty refusal", async () => {
    // Mirrors the Codex `status: "failed"` case the openai-chatgpt
    // provider now throws on directly. This is the defense-in-depth path
    // for any other provider that returns refusal + empty content
    // (Anthropic safety filter, OpenAI content_filter incomplete, etc).
    // Previously this caused setup to render nothing — the player saw a
    // hang. It must now surface as a visible error.
    const provider = mockProvider([refusalResponse()]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    await expect(conv.start(noop)).rejects.toThrow(/refused or failed to respond/);
  });

  it("does NOT throw on refusal when the model still produced some content", async () => {
    // A refusal that still has narrative text shouldn't be treated as a
    // dead end — the model said something, just with a refusal stop reason.
    const partial: ChatResult = {
      text: "I can't help with that, but here's a different idea.",
      toolCalls: [],
      usage: mockUsage(),
      stopReason: "refusal",
      assistantContent: [{ type: "text", text: "I can't help with that, but here's a different idea." }],
    };
    const provider = mockProvider([partial]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    const result = await conv.start(noop);
    expect(result.text).toContain("different idea");
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

  it("finalize_setup passes through handoff_note", async () => {
    const note = "Player leans noir-burnout. Wants ensemble scenes, not solo monologues.";
    const input = { ...FINALIZE_INPUT, handoff_note: note };
    const provider = mockProvider([
      finalizeResponse(input),
      textResponse("Onward!"),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    const result = await conv.start(noop);

    expect(result.finalized).toBeDefined();
    expect(result.finalized!.handoffNote).toBe(note);
  });

  it("finalize_setup leaves handoffNote undefined when the model omits it", async () => {
    // Defensive: the schema marks handoff_note required, but handleFinalize
    // must not crash if the model misbehaves.
    const provider = mockProvider([
      finalizeResponse(FINALIZE_INPUT),
      textResponse("Onward!"),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    const result = await conv.start(noop);

    expect(result.finalized).toBeDefined();
    expect(result.finalized!.handoffNote).toBeUndefined();
  });

  it("finalize_setup trims whitespace-only handoff_note to undefined", async () => {
    const input = { ...FINALIZE_INPUT, handoff_note: "   \n  \t  " };
    const provider = mockProvider([
      finalizeResponse(input),
      textResponse("Onward!"),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    const result = await conv.start(noop);

    expect(result.finalized!.handoffNote).toBeUndefined();
  });

  it("finalize_setup passes through opening_scene", async () => {
    const scene = "Open with Kael asleep in a hayloft, woken by a stranger saddling a horse below.";
    const input = { ...FINALIZE_INPUT, opening_scene: scene };
    const provider = mockProvider([
      finalizeResponse(input),
      textResponse("Onward!"),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    const result = await conv.start(noop);

    expect(result.finalized).toBeDefined();
    expect(result.finalized!.openingScene).toBe(scene);
  });

  it("finalize_setup leaves openingScene undefined when the model omits it", async () => {
    // Defensive: the schema marks opening_scene required, but handleFinalize
    // must not crash if the model misbehaves.
    const provider = mockProvider([
      finalizeResponse(FINALIZE_INPUT),
      textResponse("Onward!"),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    const result = await conv.start(noop);

    expect(result.finalized).toBeDefined();
    expect(result.finalized!.openingScene).toBeUndefined();
  });

  it("finalize_setup trims whitespace-only opening_scene to undefined", async () => {
    const input = { ...FINALIZE_INPUT, opening_scene: "   \n  \t  " };
    const provider = mockProvider([
      finalizeResponse(input),
      textResponse("Onward!"),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    const result = await conv.start(noop);

    expect(result.finalized!.openingScene).toBeUndefined();
  });

  it("finalize_setup passes through a valid campaign_scope", async () => {
    const input = { ...FINALIZE_INPUT, campaign_scope: "grand-campaign" };
    const provider = mockProvider([
      finalizeResponse(input),
      textResponse("Onward!"),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    const result = await conv.start(noop);

    expect(result.finalized!.campaignScope).toBe("grand-campaign");
  });

  it("finalize_setup defaults campaign_scope to few-sessions when omitted", async () => {
    // Setup prompt + tool description document few-sessions as the default
    // when the player declines to choose. The stored config must match.
    const provider = mockProvider([
      finalizeResponse(FINALIZE_INPUT),
      textResponse("Onward!"),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    const result = await conv.start(noop);

    expect(result.finalized!.campaignScope).toBe("few-sessions");
  });

  it("finalize_setup defaults campaign_scope to few-sessions when given an unknown value", async () => {
    const input = { ...FINALIZE_INPUT, campaign_scope: "epic-saga" };
    const provider = mockProvider([
      finalizeResponse(input),
      textResponse("Onward!"),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    const result = await conv.start(noop);

    expect(result.finalized!.campaignScope).toBe("few-sessions");
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

  it("finalize_setup tool result forbids DM-style narration (regression guard)", async () => {
    // Without an explicit prohibition, the model stretches "say a brief
    // farewell" into a full improvised cold-open scene that the real DM then
    // rewrites with different content — the player reads two contradictory
    // openings. This test pins the wording so a future drift can't
    // reintroduce the bug.
    const provider = mockProvider([
      finalizeResponse(FINALIZE_INPUT),
      textResponse("Let's begin.\n\n---"),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    await conv.start(noop);

    // The second stream call carries the tool_result fed back into the model.
    expect(provider.stream).toHaveBeenCalledTimes(2);
    const secondCallParams = (provider.stream as ReturnType<typeof vi.fn>).mock.calls[1][0];
    const serialized = JSON.stringify(secondCallParams);
    // Must instruct the agent NOT to narrate on the DM's behalf.
    expect(serialized).toMatch(/don't narrate/i);
    // Must request a separator so the handoff to the DM has a clean visual seam.
    expect(serialized).toContain("---");
  });

  it("co-emitted load_world + present_choices: both tool_results flushed on resolveChoice", async () => {
    // Model emits load_world AND present_choices in the same assistant turn.
    // Regression: previously the load_world tool_result was discarded on early-return,
    // leaving its tool_use orphaned — Anthropic 400s on the next request.
    const coEmitted: ChatResult = {
      text: "Let me check that world...",
      toolCalls: [
        { id: "toolu_load_1", name: "load_world", input: { slug: "the-shattered-crown" } },
        { id: "toolu_choices_1", name: "present_choices", input: { prompt: "Pick one:", choices: ["A", "B"] } },
      ],
      usage: mockUsage(),
      stopReason: "tool_use",
      assistantContent: [
        { type: "text", text: "Let me check that world..." },
        { type: "tool_use", id: "toolu_load_1", name: "load_world", input: { slug: "the-shattered-crown" } },
        { type: "tool_use", id: "toolu_choices_1", name: "present_choices", input: { prompt: "Pick one:", choices: ["A", "B"] } },
      ],
    };
    const provider = mockProvider([coEmitted, textResponse("Good pick!")]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");

    const first = await conv.start(noop);
    expect(first.pendingChoices).toBeDefined();

    await conv.resolveChoice("A", noop);

    // Second API call's user message must satisfy BOTH tool_uses
    const streamCalls = (provider.stream as ReturnType<typeof vi.fn>).mock.calls;
    const secondCall = streamCalls[1][0];
    const userMsg = secondCall.messages.find(
      (m: { role: string; content?: unknown }) => m.role === "user" && Array.isArray(m.content),
    );
    expect(userMsg).toBeDefined();
    const ids = (userMsg.content as { type: string; tool_use_id: string }[])
      .filter((c) => c.type === "tool_result")
      .map((c) => c.tool_use_id);
    expect(ids).toContain("toolu_load_1");
    expect(ids).toContain("toolu_choices_1");
  });

  it("co-emitted load_world + present_choices: both tool_results flushed on dismissal", async () => {
    // Same scenario but the user dismisses the modal (send instead of resolveChoice).
    const coEmitted: ChatResult = {
      text: "",
      toolCalls: [
        { id: "toolu_load_2", name: "load_world", input: { slug: "the-shattered-crown" } },
        { id: "toolu_choices_2", name: "present_choices", input: { prompt: "Pick one:", choices: ["A", "B"] } },
      ],
      usage: mockUsage(),
      stopReason: "tool_use",
      assistantContent: [
        { type: "tool_use", id: "toolu_load_2", name: "load_world", input: { slug: "the-shattered-crown" } },
        { type: "tool_use", id: "toolu_choices_2", name: "present_choices", input: { prompt: "Pick one:", choices: ["A", "B"] } },
      ],
    };
    const provider = mockProvider([coEmitted, textResponse("Got it.")]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");

    await conv.start(noop);
    await conv.send("never mind, let's do something else", noop);

    const streamCalls = (provider.stream as ReturnType<typeof vi.fn>).mock.calls;
    const secondCall = streamCalls[1][0];
    const userMsg = secondCall.messages.find(
      (m: { role: string; content?: unknown }) => m.role === "user" && Array.isArray(m.content),
    );
    expect(userMsg).toBeDefined();
    const ids = (userMsg.content as { type: string; tool_use_id: string }[])
      .filter((c) => c.type === "tool_result")
      .map((c) => c.tool_use_id);
    expect(ids).toContain("toolu_load_2");
    expect(ids).toContain("toolu_choices_2");
  });

  it("hits MAX_ROUNDS with chained tools → wraps with a tools-disabled call", async () => {
    // Model keeps calling load_world every round. After MAX_ROUNDS (4) iterations
    // we must do one final tools-disabled call so the tool_use chain terminates
    // and the next runTurn doesn't see two consecutive user messages.
    const loadResp = (n: number): ChatResult => ({
      text: `chain ${n}`,
      toolCalls: [{ id: `toolu_load_${n}`, name: "load_world", input: { slug: "the-shattered-crown" } }],
      usage: mockUsage(),
      stopReason: "tool_use",
      assistantContent: [
        { type: "text", text: `chain ${n}` },
        { type: "tool_use", id: `toolu_load_${n}`, name: "load_world", input: { slug: "the-shattered-crown" } },
      ],
    });
    // 4 chained load_world responses + 1 wrap-up text response = 5 calls total
    const provider = mockProvider([loadResp(1), loadResp(2), loadResp(3), loadResp(4), textResponse("OK, ready when you are.")]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");

    const result = await conv.start(noop);

    expect(provider.stream).toHaveBeenCalledTimes(5);
    expect(result.text).toContain("OK, ready when you are.");

    // The wrap-up call must have NO tools to prevent the chain from extending
    const streamCalls = (provider.stream as ReturnType<typeof vi.fn>).mock.calls;
    const wrapCall = streamCalls[4][0];
    expect(wrapCall.tools).toBeUndefined();
  });

  it("load_world in round 1 → present_choices in round 2 is captured as pendingChoices", async () => {
    // Regression: previously the follow-up round's tool calls were ignored,
    // so suboption choices (which need load_world's detail before they can
    // be presented) were silently dropped and the turn ended without a modal.
    const loadWorldResp: ChatResult = {
      text: "Let me pull up that world...",
      toolCalls: [{ id: "toolu_load_1", name: "load_world", input: { slug: "the-shattered-crown" } }],
      usage: mockUsage(),
      stopReason: "tool_use",
      assistantContent: [
        { type: "text", text: "Let me pull up that world..." },
        { type: "tool_use", id: "toolu_load_1", name: "load_world", input: { slug: "the-shattered-crown" } },
      ],
    };
    const presentSuboptions: ChatResult = {
      text: "What kind of story?",
      toolCalls: [{
        id: "toolu_subopts",
        name: "present_choices",
        input: { prompt: "Pick a tone:", choices: ["Heroic", "Tragic"] },
      }],
      usage: mockUsage(),
      stopReason: "tool_use",
      assistantContent: [
        { type: "text", text: "What kind of story?" },
        { type: "tool_use", id: "toolu_subopts", name: "present_choices", input: { prompt: "Pick a tone:", choices: ["Heroic", "Tragic"] } },
      ],
    };
    const provider = mockProvider([loadWorldResp, presentSuboptions]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");

    const result = await conv.start(noop);

    expect(provider.stream).toHaveBeenCalledTimes(2);
    expect(result.pendingChoices).toBeDefined();
    expect(result.pendingChoices!.prompt).toBe("Pick a tone:");
    expect(result.pendingChoices!.choices).toEqual(["Heroic", "Tragic"]);

    // Concatenated text from both rounds
    expect(result.text).toContain("Let me pull up that world...");
    expect(result.text).toContain("What kind of story?");
  });

  it("threads userWorldsDir through load_world tool dispatch", async () => {
    // Regression for #375: setup conversation must pass userWorldsDir into
    // loadWorldBySlug so user-imported .mvworld files are reachable.
    const loadWorldResp: ChatResult = {
      text: "Loading...",
      toolCalls: [{ id: "toolu_load_dir", name: "load_world", input: { slug: "the-shattered-crown" } }],
      usage: mockUsage(),
      stopReason: "tool_use",
      assistantContent: [
        { type: "text", text: "Loading..." },
        { type: "tool_use", id: "toolu_load_dir", name: "load_world", input: { slug: "the-shattered-crown" } },
      ],
    };
    const provider = mockProvider([loadWorldResp, textResponse("Done.")]);
    const { loadWorldBySlug } = await import("../../config/world-loader.js");
    const conv = createSetupConversation(
      provider,
      "claude-sonnet-4-6",
      undefined,
      undefined,
      "/fake/user/worlds",
    );

    await conv.start(noop);

    expect(loadWorldBySlug).toHaveBeenCalledWith("the-shattered-crown", "/fake/user/worlds");
  });

  it("threads userPersonalitiesDir into the personality loader and finalize lookup", async () => {
    // User .mvdm files in ~/.machine-violet/personalities/ must reach both the
    // setup prompt builder (so they appear in the offered list) and the finalize
    // lookup (so the chosen personality resolves to the user's prompt fragment,
    // not the synthesized "You are <name>." stub).
    const provider = mockProvider([
      finalizeResponse({ ...FINALIZE_INPUT, dm_personality: "Custom Voice" }),
      textResponse("Done."),
    ]);
    const { loadAllPersonalities, getPersonality } = await import("../../config/personality-loader.js");
    const conv = createSetupConversation(
      provider,
      "claude-sonnet-4-6",
      undefined,
      undefined,
      undefined,
      "/fake/user/personalities",
    );

    await conv.start(noop);

    expect(loadAllPersonalities).toHaveBeenCalledWith("/fake/user/personalities");
    expect(getPersonality).toHaveBeenCalledWith("Custom Voice", "/fake/user/personalities");
  });

  it("load_world surfaces campaign_scope as a clean standalone slug line", async () => {
    // When a world declares campaign_scope, the tool result must emit
    // `Required campaign_scope: <slug>` on its own line (with the instruction
    // prose as a separate paragraph) so the model doesn't accidentally copy
    // the parenthetical into finalize_setup as the scope value.
    const loadResp: ChatResult = {
      text: "",
      toolCalls: [{ id: "toolu_load_s", name: "load_world", input: { slug: "scoped-seed" } }],
      usage: mockUsage(),
      stopReason: "tool_use",
      assistantContent: [
        { type: "tool_use", id: "toolu_load_s", name: "load_world", input: { slug: "scoped-seed" } },
      ],
    };
    const provider = mockProvider([loadResp, textResponse("Got it.")]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");

    await conv.start(noop);

    // The second call's history contains the tool_result for load_world
    const streamCalls = (provider.stream as ReturnType<typeof vi.fn>).mock.calls;
    const secondCall = streamCalls[1][0];
    const userMsg = secondCall.messages.find(
      (m: { role: string; content?: unknown }) => m.role === "user" && Array.isArray(m.content),
    );
    expect(userMsg).toBeDefined();
    const toolResult = (userMsg.content as { type: string; tool_use_id: string; content: string }[])
      .find((c) => c.type === "tool_result" && c.tool_use_id === "toolu_load_s");
    expect(toolResult).toBeDefined();

    // The slug appears on its own line, exactly — no parenthetical glued on.
    expect(toolResult!.content).toMatch(/^Required campaign_scope: open-ended$/m);
    // The instruction prose is present, but on a separate paragraph.
    expect(toolResult!.content).toContain("do NOT ask the player about campaign length");
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
    const systemPrompt = flattenSystem(streamCalls[0][0].systemPrompt);

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
    const systemPrompt = flattenSystem(streamCalls[0][0].systemPrompt);

    expect(systemPrompt).toContain("## Known Players");
    expect(systemPrompt).toContain("Alice (age group: adult)");
    expect(systemPrompt).toContain("Bob (age group: teenager)");
    expect(systemPrompt).toContain("present_choices");
  });

  it("Known Players section appears before campaign worlds", async () => {
    const provider = mockProvider([textResponse("Welcome!")]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6", [
      { name: "Alice", ageGroup: "adult" },
    ]);
    await conv.start(noop);

    const streamCalls = (provider.stream as ReturnType<typeof vi.fn>).mock.calls;
    const systemPrompt = flattenSystem(streamCalls[0][0].systemPrompt);

    const knownIdx = systemPrompt.indexOf("## Known Players");
    const worldsIdx = systemPrompt.indexOf("## Available campaign worlds");
    expect(knownIdx).toBeGreaterThan(-1);
    expect(worldsIdx).toBeGreaterThan(-1);
    expect(knownIdx).toBeLessThan(worldsIdx);
  });

  it("single known player still uses present_choices instruction", async () => {
    const provider = mockProvider([textResponse("Welcome!")]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6", [
      { name: "Alice", ageGroup: "adult" },
    ]);
    await conv.start(noop);

    const streamCalls = (provider.stream as ReturnType<typeof vi.fn>).mock.calls;
    const systemPrompt = flattenSystem(streamCalls[0][0].systemPrompt);

    expect(systemPrompt).toContain("## Known Players");
    expect(systemPrompt).toContain("present_choices");
    expect(systemPrompt).toContain("Alice (age group: adult)");
  });

  it("system prompt omits Known Players section when no players provided", async () => {
    const provider = mockProvider([textResponse("Welcome!")]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    await conv.start(noop);

    const streamCalls = (provider.stream as ReturnType<typeof vi.fn>).mock.calls;
    const systemPrompt = flattenSystem(streamCalls[0][0].systemPrompt);

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
    const systemPrompt = flattenSystem(streamCalls[0][0].systemPrompt);

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
    const systemPrompt = flattenSystem(streamCalls[0][0].systemPrompt);

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

  it("system prompt uses SystemBlock[] with cache breakpoints", async () => {
    const provider = mockProvider([textResponse("Welcome!")]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    await conv.start(noop);

    const streamCalls = (provider.stream as ReturnType<typeof vi.fn>).mock.calls;
    const blocks = streamCalls[0][0].systemPrompt as SystemBlock[];

    // Must be an array (not a plain string)
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThanOrEqual(3);

    // Tier 1 blocks should have a 1h cache breakpoint on the last one
    // (base prompt + systems/chargen)
    const tier1Cached = blocks.filter((b: SystemBlock) => b.cacheControl?.ttl === "1h");
    expect(tier1Cached.length).toBeGreaterThanOrEqual(1);

    // Last block (Tier 3: seeds + personalities) should NOT have cache control
    const lastBlock = blocks[blocks.length - 1];
    expect(lastBlock.cacheControl).toBeUndefined();

    // Verify content is in the right tiers
    const fullText = flattenSystem(blocks);
    expect(fullText).toContain("Available game systems");
    expect(fullText).toContain("Available campaign worlds");
    expect(fullText).toContain("Available DM personalities");
  });

  it("system prompt includes cache breakpoint on Known Players block", async () => {
    const provider = mockProvider([textResponse("Welcome!")]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6", [
      { name: "Alice", ageGroup: "adult" },
    ]);
    await conv.start(noop);

    const streamCalls = (provider.stream as ReturnType<typeof vi.fn>).mock.calls;
    const blocks = streamCalls[0][0].systemPrompt as SystemBlock[];

    // Known Players block should be its own cached block (Tier 2)
    // Match the actual player data block, not the base prompt's instructions about Known Players
    const playersBlock = blocks.find((b: SystemBlock) => b.text.includes("Alice (age group: adult)"));
    expect(playersBlock).toBeDefined();
    expect(playersBlock!.cacheControl).toEqual({ ttl: "1h" });
  });

  it("ChatParams include cacheHints for tools and messages", async () => {
    const provider = mockProvider([textResponse("Welcome!")]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    await conv.start(noop);

    const streamCalls = (provider.stream as ReturnType<typeof vi.fn>).mock.calls;
    const params = streamCalls[0][0];

    expect(params.cacheHints).toBeDefined();
    expect(params.cacheHints).toContainEqual({ target: "tools", ttl: "1h" });
    expect(params.cacheHints).toContainEqual({ target: "messages" });
  });

  it("finalize_setup uses world_slug for detail lookup when campaign_name differs", async () => {
    // Agent renamed campaign from "The Shattered Crown" to "Crownfall" but passed world_slug
    const input = {
      ...FINALIZE_INPUT,
      campaign_name: "Crownfall",
      world_slug: "the-shattered-crown",
      // campaign_detail omitted — should fall back to world file lookup via world_slug
    };
    const provider = mockProvider([
      finalizeResponse(input),
      textResponse("Your adventure begins!"),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    const result = await conv.start(noop);

    expect(result.finalized).toBeDefined();
    expect(result.finalized!.campaignName).toBe("Crownfall");
    expect(result.finalized!.campaignDetail).toBe("Secret detail about the crown.");
  });

  it("finalize_setup falls back to campaign_name slug when world_slug is absent", async () => {
    // Campaign name matches the world slug directly
    const input = {
      ...FINALIZE_INPUT,
      campaign_name: "The Shattered Crown",
      // no world_slug, no campaign_detail — should derive slug from campaign_name
    };
    const provider = mockProvider([
      finalizeResponse(input),
      textResponse("Your adventure begins!"),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    const result = await conv.start(noop);

    expect(result.finalized).toBeDefined();
    expect(result.finalized!.campaignDetail).toBe("Secret detail about the crown.");
  });

  it("finalize_setup sanitizes world_slug (path traversal prevention)", async () => {
    const input = {
      ...FINALIZE_INPUT,
      campaign_name: "Evil Campaign",
      world_slug: "../../../etc/passwd",
      // Should be sanitized to "etc-passwd" which won't match any world
    };
    const provider = mockProvider([
      finalizeResponse(input),
      textResponse("Your adventure begins!"),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    const result = await conv.start(noop);

    expect(result.finalized).toBeDefined();
    expect(result.finalized!.campaignDetail).toBeNull();
  });

  it("finalize_setup assembles campaign_detail from base + selected fork branches", async () => {
    const input = {
      ...FINALIZE_INPUT,
      campaign_name: "Forked - Iron",
      world_slug: "forked-seed",
      fork_selections: { wrapper: "scifi", faction: "iron" },
    };
    const provider = mockProvider([
      finalizeResponse(input),
      textResponse("Your adventure begins!"),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    const result = await conv.start(noop);

    expect(result.finalized).toBeDefined();
    // Base + the SELECTED wrapper branch's detail. The faction (player fork)
    // carries no detail, so it adds nothing — and the unchosen "fantasy"
    // branch ("Temples of stone.") is absent.
    expect(result.finalized!.campaignDetail).toBe("Base premise.\n\nServer farms.");
    expect(result.finalized!.campaignDetail).not.toContain("Temples of stone");
    expect(result.finalized!.forkSelections).toEqual({ wrapper: "scifi", faction: "iron" });
  });

  it("finalize_setup drops fork selections that name unknown forks or options", async () => {
    const input = {
      ...FINALIZE_INPUT,
      campaign_name: "Forked",
      world_slug: "forked-seed",
      fork_selections: { wrapper: "nonexistent", bogus: "x" },
    };
    const provider = mockProvider([
      finalizeResponse(input),
      textResponse("Your adventure begins!"),
    ]);
    const conv = createSetupConversation(provider, "claude-sonnet-4-6");
    const result = await conv.start(noop);

    expect(result.finalized).toBeDefined();
    // No valid selection → base only, and nothing stored.
    expect(result.finalized!.campaignDetail).toBe("Base premise.");
    expect(result.finalized!.forkSelections).toBeUndefined();
  });
});
