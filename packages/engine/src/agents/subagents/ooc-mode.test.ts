import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LLMProvider, ChatResult, SystemBlock } from "../../providers/types.js";
import {
  buildOOCPrompt,
  buildOOCTools,
  buildOOCToolHandler,
  enterOOC,
  parseEndOOCSignal,
  parseSummaryTag,
  extractSummary,
} from "./ooc-mode.js";
import type { DMSessionState } from "../dm-prompt.js";
import type { FileIO } from "../scene-manager.js";
import type { GameState } from "../game-state.js";
import { registry as singletonRegistry } from "../tool-registry.js";
import { CampaignRepo } from "../../tools/git/index.js";
import type { GitIO } from "../../tools/git/index.js";
import type { CampaignConfig } from "@machine-violet/shared/types/config.js";
import { createClocksState } from "../../tools/clocks/index.js";
import { createCombatState, createDefaultConfig } from "../../tools/combat/index.js";
import { createDecksState } from "../../tools/cards/index.js";
import { createObjectivesState } from "../../tools/objectives/index.js";
import { loadModelConfig } from "../../config/models.js";
import { resetPromptCache } from "../../prompts/load-prompt.js";

beforeEach(() => {
  loadModelConfig({ reset: true });
  resetPromptCache();
});

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

function mockConfig(overrides?: Partial<CampaignConfig>): CampaignConfig {
  return {
    name: "TestCampaign",
    system: "FATE",
    genre: "fantasy",
    mood: "dark",
    difficulty: "hard",
    premise: "A world in shadow",
    dm_personality: { name: "The Narrator", prompt_fragment: "You are mysterious." },
    players: [{ name: "Player1", character: "Kael", type: "human" }],
    combat: { initiative_method: "d20_dex", round_structure: "individual", surprise_rules: false },
    context: { retention_exchanges: 5, max_conversation_tokens: 4000, tool_result_stub_after: 200 },
    recovery: { auto_commit_interval: 3, max_commits: 100, enable_git: true },
    choices: { campaign_default: "never", player_overrides: {} },
    ...overrides,
  };
}

function mockSessionState(overrides?: Partial<DMSessionState>): DMSessionState {
  return {
    rulesAppendix: "## FATE Core\nAspects, Fate Points, etc.",
    campaignSummary: "Session 1: The party met at the tavern...",
    sessionRecap: "Last time: you defeated the goblins.",
    activeState: "Location: Tavern\nPCs:\n  Kael (HP 10/10)",
    scenePrecis: "The party is resting after the battle. [[Merchant Giles]] offered a quest.",
    ...overrides,
  };
}

// --- buildOOCPrompt ---

describe("buildOOCPrompt (legacy)", () => {
  it("includes campaign name", () => {
    const prompt = buildOOCPrompt({ campaignName: "Shadow of the Dragon" });
    expect(typeof prompt).toBe("string");
    expect(prompt as string).toContain("Campaign: Shadow of the Dragon");
  });

  it("includes rules and character sheet when provided", () => {
    const prompt = buildOOCPrompt({
      campaignName: "TestCampaign",
      systemRules: "FATE rules here",
      characterSheet: "Aldric the Bold",
    }) as string;
    expect(prompt).toContain("Game system rules:\nFATE rules here");
    expect(prompt).toContain("Active character:\nAldric the Bold");
  });

  it("omits optional blocks when absent", () => {
    const prompt = buildOOCPrompt({ campaignName: "TestCampaign" }) as string;
    expect(prompt).not.toContain("Game system rules:");
    expect(prompt).not.toContain("Active character:");
    expect(prompt).not.toContain("undefined");
  });
});

describe("buildOOCPrompt (structured — reuses DM prefix)", () => {
  it("returns SystemBlock[] when config and sessionState provided", () => {
    const result = buildOOCPrompt({
      campaignName: "TestCampaign",
      config: mockConfig(),
      sessionState: mockSessionState(),
    });
    expect(Array.isArray(result)).toBe(true);
    const blocks = result as SystemBlock[];
    expect(blocks.length).toBeGreaterThan(2);
    expect(blocks.every((b) => typeof b.text === "string")).toBe(true);
  });

  it("falls back to string when no sessionState", () => {
    const result = buildOOCPrompt({ campaignName: "TestCampaign" });
    expect(typeof result).toBe("string");
    expect(result).toContain("Campaign: TestCampaign");
  });

  it("falls back to string when no config", () => {
    const result = buildOOCPrompt({
      campaignName: "TestCampaign",
      sessionState: mockSessionState(),
    });
    expect(typeof result).toBe("string");
  });

  it("ends with the OOC-mode suffix block (uncached)", () => {
    const result = buildOOCPrompt({
      campaignName: "TestCampaign",
      config: mockConfig(),
      sessionState: mockSessionState(),
    }) as SystemBlock[];
    const last = result[result.length - 1];
    expect(last.text).toContain("Out-of-Character Mode");
    expect(last.cacheControl).toBeUndefined();
  });

  it("preserves DM-prefix cache breakpoints (BP1 and BP2)", () => {
    const result = buildOOCPrompt({
      campaignName: "TestCampaign",
      config: mockConfig(),
      sessionState: mockSessionState(),
    }) as SystemBlock[];

    const cached = result.filter((b) => "cacheControl" in b && b.cacheControl);
    // buildDMPrefix stamps BP1 on the last Tier 1 block and BP2 on the last
    // Tier 2 block. The OOC suffix added after is intentionally uncached.
    expect(cached.length).toBe(2);
  });

  it("includes DM-style campaign setting and rules in cached prefix", () => {
    const result = buildOOCPrompt({
      campaignName: "TestCampaign",
      config: mockConfig(),
      sessionState: mockSessionState(),
    }) as SystemBlock[];

    const allText = result.map((b) => b.text).join("\n");
    expect(allText).toContain("Campaign Setting");
    expect(allText).toContain("Genre: fantasy");
    expect(allText).toContain("Rules Reference");
    expect(allText).toContain("FATE Core");
  });

  it("includes session recap and scene precis from DM prefix", () => {
    const result = buildOOCPrompt({
      campaignName: "TestCampaign",
      config: mockConfig(),
      sessionState: mockSessionState(),
    }) as SystemBlock[];

    const allText = result.map((b) => b.text).join("\n");
    expect(allText).toContain("Last Session");
    expect(allText).toContain("defeated the goblins");
    expect(allText).toContain("Scene So Far");
    expect(allText).toContain("Merchant Giles");
  });

  it("appends DM-initiated entry context when wasMidNarration is true", () => {
    const result = buildOOCPrompt({
      campaignName: "TestCampaign",
      config: mockConfig(),
      sessionState: mockSessionState(),
      wasMidNarration: true,
      enterReason: "rules question about grappling",
    }) as SystemBlock[];

    const lastText = result[result.length - 1].text;
    expect(lastText).toContain("enter_ooc");
    expect(lastText).toContain("rules question about grappling");
  });

  it("omits entry context block when not provided", () => {
    const result = buildOOCPrompt({
      campaignName: "TestCampaign",
      config: mockConfig(),
      sessionState: mockSessionState(),
    }) as SystemBlock[];

    const lastText = result[result.length - 1].text;
    expect(lastText).not.toContain("OOC Entry Context");
  });
});

// --- enterOOC: summary / snapshot / streaming ---

describe("enterOOC", () => {
  it("returns summary from first sentence (no SUMMARY tag)", async () => {
    const provider = mockProvider([textResponse("Grappling lets you restrain foes. You need a STR check.")]);
    const result = await enterOOC(provider, "How does grappling work?", {
      campaignName: "Test",
      previousVariant: "playing",
      model: "claude-sonnet-4-6",
    });
    expect(result.summary).toBe("Grappling lets you restrain foes.");
  });

  it("prefers SUMMARY tag when present", async () => {
    const provider = mockProvider([textResponse(
      "Conversational reply here.\n<SUMMARY>Clarified grappling rules.</SUMMARY>\n<END_OOC />"
    )]);
    const result = await enterOOC(provider, "How does grappling work?", {
      campaignName: "Test",
      previousVariant: "playing",
      model: "claude-sonnet-4-6",
    });
    expect(result.summary).toBe("Clarified grappling rules.");
    expect(result.text).toBe("Conversational reply here.");
    expect(result.endSession).toBe(true);
  });

  it("truncates fallback summary over 100 chars", async () => {
    const longText = "A".repeat(110) + ". More text here.";
    const provider = mockProvider([textResponse(longText)]);
    const result = await enterOOC(provider, "Tell me everything", {
      campaignName: "Test",
      previousVariant: "playing",
      model: "claude-sonnet-4-6",
    });
    expect(result.summary).toHaveLength(100);
    expect(result.summary).toMatch(/\.\.\.$/);
  });

  it("defaults summary for empty text", async () => {
    const provider = mockProvider([textResponse("")]);
    const result = await enterOOC(provider, "test", {
      campaignName: "Test",
      previousVariant: "playing",
      model: "claude-sonnet-4-6",
    });
    expect(result.summary).toBe("OOC discussion.");
  });

  it("preserves snapshot with previousVariant and wasMidNarration", async () => {
    const provider = mockProvider([textResponse("Sure thing.")]);
    const result = await enterOOC(provider, "pause", {
      campaignName: "Test",
      previousVariant: "narrating",
      wasMidNarration: true,
      model: "claude-sonnet-4-6",
    });
    expect(result.snapshot.previousVariant).toBe("narrating");
    expect(result.snapshot.wasMidNarration).toBe(true);
  });

  it("defaults wasMidNarration to false", async () => {
    const provider = mockProvider([textResponse("Ok.")]);
    const result = await enterOOC(provider, "pause", {
      campaignName: "Test",
      previousVariant: "playing",
      model: "claude-sonnet-4-6",
    });
    expect(result.snapshot.wasMidNarration).toBe(false);
  });

  it("uses stream when onStream callback provided", async () => {
    const provider = mockProvider([textResponse("Response.")]);
    const onStream = vi.fn();
    await enterOOC(provider, "question", {
      campaignName: "Test",
      previousVariant: "playing",
      model: "claude-sonnet-4-6",
    }, onStream);
    expect(provider.stream).toHaveBeenCalled();
  });

  it("accumulates usage stats", async () => {
    const provider = mockProvider([textResponse("Done.")]);
    const result = await enterOOC(provider, "test", {
      campaignName: "Test",
      previousVariant: "playing",
      model: "claude-sonnet-4-6",
    });
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(20);
  });

  it("always advertises the OOC-only extras even with no registry/fileIO/repo", async () => {
    const provider = mockProvider([textResponse("Done.")]);
    await enterOOC(provider, "test", {
      campaignName: "Test",
      previousVariant: "playing",
      model: "claude-sonnet-4-6",
    });

    const createCall = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(createCall).toBeDefined();
    const names = createCall.tools.map((t: { name: string }) => t.name);
    // Extras are always present so the prompt's tool advertisement stays
    // truthful regardless of caller plumbing. They return recoverable errors
    // at dispatch time when their backing capability isn't wired up.
    expect(names).toEqual(expect.arrayContaining([
      "read_file", "find_references", "validate_campaign", "get_commit_log",
    ]));
    // No DM tools without a registry.
    expect(names).not.toContain("roll_dice");
    expect(names).not.toContain("scribe");
  });
});

// --- enterOOC volatile context injection ---

describe("enterOOC volatile context", () => {
  it("wraps player text with a <context> block when volatileContext is provided", async () => {
    const provider = mockProvider([textResponse("Done.")]);
    await enterOOC(provider, "What's my HP?", {
      campaignName: "Test",
      previousVariant: "playing",
      volatileContext: "## Current State\nTurn: Kael",
      model: "claude-sonnet-4-6",
    });

    const createCall = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(createCall).toBeDefined();
    const userMsg = createCall.messages[0].content as string;
    expect(userMsg).toContain("<context>");
    expect(userMsg).toContain("Turn: Kael");
    expect(userMsg).toContain("What's my HP?");
  });

  it("passes the raw player text when volatileContext is omitted", async () => {
    const provider = mockProvider([textResponse("Done.")]);
    await enterOOC(provider, "What's my HP?", {
      campaignName: "Test",
      previousVariant: "playing",
      model: "claude-sonnet-4-6",
    });

    const createCall = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const userMsg = createCall.messages[0].content as string;
    expect(userMsg).toBe("What's my HP?");
  });
});

// --- enterOOC DM-toolset wiring ---

describe("enterOOC with gameState + DM registry", () => {
  it("passes the full DM toolset (minus enter_ooc) when gameState + registry are provided", async () => {
    const gs = mockGameState();
    const fio = mockFileIO();
    const provider = mockProvider([textResponse("Done.")]);
    await enterOOC(provider, "test", {
      campaignName: "Test",
      previousVariant: "playing",
      fileIO: fio,
      campaignRoot: "/camp",
      gameState: gs,
      registry: singletonRegistry,
      model: "claude-sonnet-4-6",
    });

    const createCall = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(createCall).toBeDefined();
    const names = createCall.tools.map((t: { name: string }) => t.name);

    // Hard contract: enter_ooc is excluded; rollback/show_character_sheet
    // (DM-excluded but OOC-included) are present; OOC-only file extras are present.
    expect(names).not.toContain("enter_ooc");
    expect(names).toContain("rollback");
    expect(names).toContain("show_character_sheet");
    expect(names).toContain("read_file");
    expect(names).toContain("find_references");
    expect(names).toContain("validate_campaign");

    // Smoke: representative DM tools are present.
    expect(names).toContain("roll_dice");
    expect(names).toContain("scribe");
    expect(names).toContain("style_scene");
    expect(names).toContain("promote_character");
    expect(names).toContain("resolve_turn");
  });
});

// --- buildOOCTools ---

describe("buildOOCTools", () => {
  it("returns just the OOC-only extras when given an empty registry", () => {
    const tools = buildOOCTools({ getDefinitions: () => [] } as unknown as Parameters<typeof buildOOCTools>[0]);
    const names = tools.map((t) => t.name);
    expect(names).toEqual(["read_file", "find_references", "validate_campaign", "get_commit_log"]);
  });

  it("returns all DM tools (minus enter_ooc) plus extras with the real registry", () => {
    const tools = buildOOCTools(singletonRegistry);
    const names = tools.map((t) => t.name);

    expect(names).not.toContain("enter_ooc");
    expect(names).toContain("roll_dice");
    expect(names).toContain("scribe");
    expect(names).toContain("rollback");
    expect(names).toContain("read_file");
    expect(names).toContain("get_commit_log");
  });
});

// --- buildOOCToolHandler ---

describe("buildOOCToolHandler — OOC-only extras", () => {
  it("get_commit_log returns commit log with distinct dates", async () => {
    const git = mockGitIO();
    const repo = new CampaignRepo({ dir: "/tmp/campaign", git });
    await repo.sceneCommit("The Dragon's Lair");
    await repo.autoCommit("auto: exchanges");

    const handler = buildOOCToolHandler(singletonRegistry, mockGameState(), undefined, repo);
    const result = await handler("get_commit_log", {});
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("Dragon's Lair");
  });

  it("read_file reads a campaign file", async () => {
    const fio = mockFileIO({ "/camp/characters/kael.md": "# Kael\n**Type:** PC" });
    const handler = buildOOCToolHandler(singletonRegistry, mockGameState(), undefined, undefined, "/camp", fio);

    const result = await handler("read_file", { path: "characters/kael.md" });
    expect(result.is_error).toBeUndefined();
    expect(result.content).toBe("# Kael\n**Type:** PC");
  });

  it("read_file rejects path traversal", async () => {
    const fio = mockFileIO();
    const handler = buildOOCToolHandler(singletonRegistry, mockGameState(), undefined, undefined, "/camp", fio);

    const result = await handler("read_file", { path: "../etc/passwd" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Path traversal not allowed");
  });

  it("read_file errors when fileIO is missing", async () => {
    const handler = buildOOCToolHandler(singletonRegistry, mockGameState(), undefined);
    const result = await handler("read_file", { path: "characters/kael.md" });
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("File I/O not available");
  });

  it("find_references finds wikilinks", async () => {
    const fio = mockFileIO(
      {
        "/camp/characters/kael.md": "# Kael\n**Type:** PC",
        "/camp/campaign/log.md": "Met [Kael](../characters/kael.md) at the tavern.",
      },
      { "/camp/characters": ["kael.md"] },
    );
    const handler = buildOOCToolHandler(singletonRegistry, mockGameState(), undefined, undefined, "/camp", fio);

    const result = await handler("find_references", { path: "characters/kael.md" });
    expect(result.is_error).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.references).toHaveLength(1);
  });
});

describe("buildOOCToolHandler — DM tool dispatch via singleton registry", () => {
  it("roll_dice dispatches via the singleton registry", async () => {
    const gs = mockGameState();
    const handler = buildOOCToolHandler(singletonRegistry, gs, undefined);
    const result = await handler("roll_dice", { expression: "1d6" });
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("1d6");
    expect(result.content).toContain("→");
  });

  it("alarm dispatches via the singleton registry", async () => {
    const gs = mockGameState();
    const handler = buildOOCToolHandler(singletonRegistry, gs, undefined);
    const result = await handler("alarm", { operation: "check" });
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("calendar");
  });

  it("unknown tool returns an error", async () => {
    const handler = buildOOCToolHandler(singletonRegistry, mockGameState(), undefined);
    const result = await handler("nonexistent_tool_xyz", {});
    expect(result.is_error).toBe(true);
  });
});

describe("buildOOCToolHandler — engine async chain", () => {
  it("delegates to engineAsync when it returns a non-null ToolResult", async () => {
    const engineAsync = vi.fn(async (name: string) => {
      if (name === "search_campaign") return { content: "engine-handled" };
      return null;
    });
    const handler = buildOOCToolHandler(singletonRegistry, mockGameState(), engineAsync);
    const result = await handler("search_campaign", { query: "hello" });
    expect(engineAsync).toHaveBeenCalledWith("search_campaign", { query: "hello" });
    expect(result.content).toBe("engine-handled");
  });

  it("falls through to registry dispatch when engineAsync returns null", async () => {
    const engineAsync = vi.fn(async () => null);
    const handler = buildOOCToolHandler(singletonRegistry, mockGameState(), engineAsync);
    const result = await handler("roll_dice", { expression: "1d6" });
    expect(engineAsync).toHaveBeenCalled();
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("1d6");
  });
});

// --- parseEndOOCSignal ---

describe("parseEndOOCSignal", () => {
  it("detects self-closing tag", () => {
    const result = parseEndOOCSignal("Thanks for asking!\n<END_OOC />");
    expect(result.found).toBe(true);
    expect(result.playerAction).toBeUndefined();
    expect(result.cleanedText).toBe("Thanks for asking!");
  });

  it("detects self-closing tag without space", () => {
    const result = parseEndOOCSignal("Done.<END_OOC/>");
    expect(result.found).toBe(true);
    expect(result.cleanedText).toBe("Done.");
  });

  it("detects tag with player action payload", () => {
    const result = parseEndOOCSignal("Back to the game!\n<END_OOC>I attack the goblin</END_OOC>");
    expect(result.found).toBe(true);
    expect(result.playerAction).toBe("I attack the goblin");
    expect(result.cleanedText).toBe("Back to the game!");
  });

  it("preserves multiline payload", () => {
    const result = parseEndOOCSignal('OK!\n<END_OOC>I say to the guard:\n"Let us pass."</END_OOC>');
    expect(result.found).toBe(true);
    expect(result.playerAction).toBe('I say to the guard:\n"Let us pass."');
  });

  it("returns found=false when no signal present", () => {
    const text = "Here's how grappling works in FATE...";
    const result = parseEndOOCSignal(text);
    expect(result.found).toBe(false);
    expect(result.cleanedText).toBe(text);
    expect(result.playerAction).toBeUndefined();
  });

  it("ignores signal that is not at the end", () => {
    const result = parseEndOOCSignal("<END_OOC /> and then some more text");
    expect(result.found).toBe(false);
  });

  it("handles trailing whitespace after tag", () => {
    const result = parseEndOOCSignal("Done.\n<END_OOC />  \n");
    expect(result.found).toBe(true);
    expect(result.cleanedText).toBe("Done.");
  });

  it("trims payload whitespace", () => {
    const result = parseEndOOCSignal("OK!\n<END_OOC>  I draw my sword  </END_OOC>");
    expect(result.found).toBe(true);
    expect(result.playerAction).toBe("I draw my sword");
  });
});

// --- parseSummaryTag ---

describe("parseSummaryTag", () => {
  it("extracts summary content and strips the tag", () => {
    const result = parseSummaryTag("Reply text.\n<SUMMARY>One-line digest.</SUMMARY>");
    expect(result.summary).toBe("One-line digest.");
    expect(result.cleanedText).toBe("Reply text.");
  });

  it("returns no summary when tag is absent", () => {
    const result = parseSummaryTag("Just a plain reply.");
    expect(result.summary).toBeUndefined();
    expect(result.cleanedText).toBe("Just a plain reply.");
  });

  it("trims surrounding whitespace in the summary payload", () => {
    const result = parseSummaryTag("Reply.\n<SUMMARY>  trimmed  </SUMMARY>\n");
    expect(result.summary).toBe("trimmed");
  });

  it("strips the SUMMARY tag even when it sits before END_OOC", () => {
    const text = "Reply body.\n<SUMMARY>Digest.</SUMMARY>\n<END_OOC />";
    const result = parseSummaryTag(text);
    expect(result.summary).toBe("Digest.");
    // SUMMARY tag is removed; END_OOC remains in cleanedText for the next parser.
    expect(result.cleanedText).toContain("<END_OOC />");
    expect(result.cleanedText).not.toContain("<SUMMARY>");
  });
});

// --- enterOOC END_OOC integration ---

describe("enterOOC END_OOC integration", () => {
  it("sets endSession when agent emits END_OOC", async () => {
    const provider = mockProvider([textResponse("Grappling uses Athletics.\n<END_OOC />")]);
    const result = await enterOOC(provider, "How does grappling work?", {
      campaignName: "Test",
      previousVariant: "exploration",
      model: "claude-sonnet-4-6",
    });
    expect(result.endSession).toBe(true);
    expect(result.playerAction).toBeUndefined();
    expect(result.text).toBe("Grappling uses Athletics.");
  });

  it("captures playerAction from END_OOC payload", async () => {
    const provider = mockProvider([textResponse("Back to the game!\n<END_OOC>I grab the guard</END_OOC>")]);
    const result = await enterOOC(provider, "I grab the guard", {
      campaignName: "Test",
      previousVariant: "exploration",
      model: "claude-sonnet-4-6",
    });
    expect(result.endSession).toBe(true);
    expect(result.playerAction).toBe("I grab the guard");
    expect(result.text).toBe("Back to the game!");
  });

  it("does not set endSession when no signal", async () => {
    const provider = mockProvider([textResponse("Here's how that works...")]);
    const result = await enterOOC(provider, "How does X work?", {
      campaignName: "Test",
      previousVariant: "exploration",
      model: "claude-sonnet-4-6",
    });
    expect(result.endSession).toBeUndefined();
    expect(result.playerAction).toBeUndefined();
  });

  it("combines SUMMARY + END_OOC: summary forwarded, both tags stripped from visible text", async () => {
    const text = "Conversational reply.\n<SUMMARY>Clarified rules.</SUMMARY>\n<END_OOC>I attack</END_OOC>";
    const provider = mockProvider([textResponse(text)]);
    const result = await enterOOC(provider, "x", {
      campaignName: "Test",
      previousVariant: "exploration",
      model: "claude-sonnet-4-6",
    });
    expect(result.endSession).toBe(true);
    expect(result.summary).toBe("Clarified rules.");
    expect(result.playerAction).toBe("I attack");
    expect(result.text).toBe("Conversational reply.");
  });
});

// --- extractSummary fallback ---

describe("extractSummary", () => {
  it("extracts first substantive sentence", () => {
    expect(extractSummary("Grappling lets you restrain foes. You need a STR check."))
      .toBe("Grappling lets you restrain foes.");
  });

  it("skips filler phrases and takes second sentence", () => {
    expect(extractSummary("No worries. Clarified the grappling rules for the player."))
      .toBe("Clarified the grappling rules for the player.");
  });

  it("handles end-of-string without trailing space", () => {
    expect(extractSummary("Corrected HP from 12 to 18."))
      .toBe("Corrected HP from 12 to 18.");
  });

  it("returns fallback for empty text", () => {
    expect(extractSummary("")).toBe("OOC discussion.");
    expect(extractSummary("   ")).toBe("OOC discussion.");
  });

  it("truncates over 100 chars", () => {
    const long = "A".repeat(110) + ".";
    const result = extractSummary(long);
    expect(result).toHaveLength(100);
    expect(result).toMatch(/\.\.\.$/);
  });

  it("uses first sentence when all sentences are short filler", () => {
    expect(extractSummary("Got it. OK. Done.")).toBe("Got it.");
  });

  it("adds period if sentence lacks punctuation", () => {
    expect(extractSummary("Explained the combat rules to the player"))
      .toBe("Explained the combat rules to the player.");
  });
});

// --- Mocks ---

const MOCK_BASE_TS = Math.floor(new Date("2025-03-15T12:00:00Z").getTime() / 1000);

function mockGitIO(): GitIO {
  const commits: { message: string; oid: string; timestamp: number }[] = [];
  const staged = new Set<string>();
  let oidCounter = 0;

  return {
    init: vi.fn(async () => {}),
    add: vi.fn(async (_dir, filepath) => { staged.add(filepath); }),
    commit: vi.fn(async (_dir, message) => {
      const oid = `commit_${++oidCounter}`;
      commits.unshift({ message, oid, timestamp: MOCK_BASE_TS + oidCounter * 86400 });
      staged.clear();
      return oid;
    }),
    log: vi.fn(async (_dir, depth = 50) =>
      commits.slice(0, depth).map((c) => ({
        oid: c.oid,
        commit: { message: c.message, author: { timestamp: c.timestamp } },
      })),
    ),
    checkout: vi.fn(async () => {}),
    resetTo: vi.fn(async () => {}),
    pruneUnreachable: vi.fn(async () => 0),
    statusMatrix: vi.fn(async () =>
      staged.size > 0
        ? [...staged].map((f) => [f, 1, 2, 2] as [string, number, number, number])
        : [["config.json", 1, 2, 1] as [string, number, number, number]],
    ),
    listFiles: vi.fn(async () => ["config.json"]),
    remove: vi.fn(async () => {}),
  };
}

function mockFileIO(
  files: Record<string, string> = {},
  dirs: Record<string, string[]> = {},
): FileIO {
  const n = (p: string) => p.replace(/\\/g, "/");
  const normFiles: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) normFiles[n(k)] = v;
  const normDirs: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(dirs)) normDirs[n(k)] = v;

  return {
    readFile: vi.fn(async (p: string) => {
      const np = n(p);
      if (np in normFiles) return normFiles[np];
      throw new Error(`ENOENT: ${p}`);
    }),
    writeFile: vi.fn(async () => {}),
    appendFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    exists: vi.fn(async (p: string) => n(p) in normFiles || n(p) in normDirs),
    listDir: vi.fn(async (p: string) => {
      const np = n(p);
      if (np in normDirs) return normDirs[np];
      throw new Error(`ENOENT: ${p}`);
    }),
    deleteFile: vi.fn(async () => {}),
  };
}

function mockGameState(overrides?: Partial<GameState>): GameState {
  return {
    maps: {},
    clocks: createClocksState(),
    combat: createCombatState(),
    combatConfig: createDefaultConfig(),
    decks: createDecksState(),
    objectives: createObjectivesState(),
    config: {
      name: "TestCampaign",
      dm_personality: { name: "Narrator", prompt_fragment: "terse" },
      players: [{ name: "Player1", character: "Kael", type: "human" }],
      combat: createDefaultConfig(),
      context: { retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 },
      recovery: { auto_commit_interval: 300, max_commits: 100, enable_git: false },
      choices: { campaign_default: "never", player_overrides: {} },
    },
    campaignRoot: "/camp",
    homeDir: "/tmp/home",
    activePlayerIndex: 0,
    displayResources: {},
    resourceValues: {},
    ...overrides,
  } as GameState;
}
