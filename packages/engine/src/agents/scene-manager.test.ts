import { getCampaignKnowledge } from "../knowledge/store.js";
import { readPublicCampaignRecord } from "../entities/public-knowledge.js";
import { parseFrontMatter } from "../tools/filesystem/frontmatter.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LLMProvider, ChatResult } from "../providers/types.js";
import { SceneManager, parseTranscriptEntries, classifyTranscriptEntry, buildScenePrecis, buildScenePacing, buildSceneAnchor, detectSceneState } from "./scene-manager.js";
import type { SceneState, FileIO } from "./scene-manager.js";
import type { CampaignRepo } from "../tools/git/index.js";
import type { GameState } from "./game-state.js";
import { ConversationManager } from "../context/conversation.js";
import type { DMSessionState } from "./dm-prompt.js";
import { createClocksState, advanceCalendar } from "../tools/clocks/index.js";
import { createCombatState, createDefaultConfig } from "../tools/combat/index.js";
import { createDecksState } from "../tools/cards/index.js";
import { createObjectivesState } from "../tools/objectives/index.js";
import { norm } from "../utils/paths.js";

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

/** Empty compendium JSON response for the compendium updater subagent */
const EMPTY_COMPENDIUM_RESPONSE = textResponse(
  JSON.stringify({ version: 1, lastUpdatedScene: 1, characters: [], places: [], items: [], storyline: [], lore: [], objectives: [] }),
);

/**
 * Mock LLMProvider. Responses are consumed in order.
 * Pass `fallback` to handle extra calls (e.g. from parallel compendium subagent)
 * instead of crashing on exhaustion.
 */
function mockProvider(
  responses: ChatResult[],
  opts?: { fallback?: ChatResult },
): LLMProvider {
  let callIdx = 0;
  const next = async () => {
    const resp = responses[callIdx++];
    if (resp) return resp;
    if (opts?.fallback) return opts.fallback;
    throw new Error(`mockProvider: no response at index ${callIdx - 1}`);
  };
  return {
    providerId: "mock",
    chat: vi.fn(next),
    stream: vi.fn(next),
    healthCheck: vi.fn(async () => ({ ok: true })),
  } as unknown as LLMProvider;
}

/** Shorthand: mockProvider with compendium fallback for tests that run scene transitions. */
function transitionProvider(responses: ChatResult[]): LLMProvider {
  return mockProvider(responses, { fallback: EMPTY_COMPENDIUM_RESPONSE });
}

function mockState(): GameState {
  return {
    maps: {},
    clocks: createClocksState(),
    combat: createCombatState(),
    combatConfig: createDefaultConfig(),
    decks: createDecksState(),
    objectives: createObjectivesState(),
    config: {
      name: "Test Campaign",
      dm_personality: { name: "grim", prompt_fragment: "Be terse." },
      players: [{ name: "Alice", character: "Aldric", type: "human" }],
      combat: createDefaultConfig(),
      context: { retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 },
      recovery: { auto_commit_interval: 300, max_commits: 100, enable_git: false },
      choices: { campaign_default: "never", player_overrides: {} },
    },
    campaignRoot: "/tmp/test-campaign",
    homeDir: "/tmp/home",
    activePlayerIndex: 0,
    displayResources: {},
    resourceValues: {},
  };
}

function mockScene(): SceneState {
  return {
    sceneNumber: 1,
    slug: "tavern-meeting",
    transcript: [
      "**[Aldric]** I enter the tavern.",
      "**DM:** The tavern is warm and dimly lit.",
    ],
    precis: "",
    openThreads: "",
    npcIntents: "",

    playerReads: [],
    sessionNumber: 1,
    sessionRecapPending: false,
  };
}

function mockSessionState(): DMSessionState {
  return {
    rulesAppendix: undefined,
    campaignSummary: undefined,
    sessionRecap: undefined,
    activeState: undefined,
    scenePrecis: undefined,
  };
}

let files: Record<string, string>;
let dirs: Set<string>;

function mockFileIO(): FileIO {
  return {
    readFile: vi.fn(async (path: string) => files[norm(path)] ?? ""),
    writeFile: vi.fn(async (path: string, content: string) => { files[norm(path)] = content; }),
    appendFile: vi.fn(async (path: string, content: string) => { files[norm(path)] = (files[norm(path)] ?? "") + content; }),
    mkdir: vi.fn(async (path: string) => { dirs.add(norm(path)); }),
    exists: vi.fn(async (path: string) => norm(path) in files || dirs.has(norm(path))),
    listDir: vi.fn(async () => []),
    deleteFile: vi.fn(async (path: string) => { files[norm(path)] = undefined as unknown as string; }),
  };
}

/** Test-only narrative seed materialization; never a played-save compatibility path. */
async function seedNarrativeFixtures(io: FileIO): Promise<void> {
  const store = await getCampaignKnowledge("/tmp/test-campaign", io);
  const collections: Record<string, string> = { characters: "Characters", locations: "Locations", factions: "Factions", lore: "Lore", items: "Items" };
  for (const [path, raw] of Object.entries(files)) {
    const match = /\/(characters|locations|factions|lore|items)\/.+\.md$/.exec(path);
    if (!match || !raw) continue;
    const parsed = parseFrontMatter(raw);
    const name = String(parsed.frontMatter._title ?? "Fixture");
    if (await store.resolve(name)) continue;
    const aliases = String(parsed.frontMatter.additional_names ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    await store.mutate([{ op: "upsert", collection: collections[match[1]], name, aliases, fields: parsed.frontMatter, body: parsed.body }], { source: "fixture" });
  }
}

beforeEach(() => {
  files = {};
  dirs = new Set();
});

describe("SceneManager", () => {
  it("appends player input and DM response to transcript", () => {
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      mockFileIO(),
    );

    mgr.appendPlayerInput("Aldric", "I draw my sword.");
    mgr.appendDMResponse("The blade gleams in the candlelight.");
    mgr.appendToolResult("roll_dice", "1d20+5: [18]→23");

    const scene = mgr.getScene();
    expect(scene.transcript).toHaveLength(5); // 2 existing + 3 new
    expect(scene.transcript[2]).toContain("[Aldric]");
    expect(scene.transcript[3]).toContain("DM:");
    expect(scene.transcript[4]).toContain("roll_dice");
  });

  it("generates system prompt", () => {
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      mockFileIO(),
    );

    const { system } = mgr.getSystemPrompt();
    expect(system.length).toBeGreaterThan(0);
    expect(system[0].text).toContain("Dungeon Master");
  });

  it("handles dropped exchange by updating precis", async () => {
    const provider = mockProvider([
      textResponse("Aldric entered the tavern. Warm, dimly lit."),
    ]);

    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      mockFileIO(),
    );

    const usage = await mgr.handleDroppedExchange(provider, {
      exchange: {
        user: { role: "user", content: "I enter the tavern." },
        assistant: { role: "assistant", content: "The tavern is warm." },
        toolResults: [],
        estimatedTokens: 20,
      },
      reason: "exchange_count",
    });

    expect(usage.inputTokens).toBe(50);
    expect(mgr.getScene().precis).toContain("Aldric entered the tavern");
  });

  it("passes PC identification to precis updater", async () => {
    const provider = mockProvider([
      textResponse("Aldric entered the tavern."),
    ]);

    const state = mockState();
    state.config.players = [
      { name: "Alice", character: "Aldric", type: "human" },
      { name: "Bob", character: "Brin", type: "human" },
    ];

    const mgr = new SceneManager(
      state,
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      mockFileIO(),
    );

    await mgr.handleDroppedExchange(provider, {
      exchange: {
        user: { role: "user", content: "I enter the tavern." },
        assistant: { role: "assistant", content: "The tavern is warm." },
        toolResults: [],
        estimatedTokens: 20,
      },
      reason: "exchange_count",
    });

    const createCall = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const userMessage = createCall.messages[0].content;
    expect(userMessage).toContain("[[Aldric]] (Alice)");
    expect(userMessage).toContain("[[Brin]] (Bob)");
    expect(userMessage).toContain("Player characters:");
  });

  it("accumulates player reads from dropped exchanges", async () => {
    const provider = mockProvider([
      textResponse('Aldric entered the tavern.\nPLAYER_READ: {"focus":["exploration"],"tone":"curious","offScript":true}'),
    ]);

    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      mockFileIO(),
    );

    await mgr.handleDroppedExchange(provider, {
      exchange: {
        user: { role: "user", content: "I enter the tavern." },
        assistant: { role: "assistant", content: "The tavern is warm." },
        toolResults: [],
        estimatedTokens: 20,
      },
      reason: "exchange_count",
    });

    expect(mgr.getScene().playerReads).toHaveLength(1);
    expect(mgr.getScene().playerReads[0].tone).toBe("curious");
  });

  it("clears player reads on scene transition", async () => {
    const provider = transitionProvider([
      textResponse("- Summary\n---MINI---\nSummary."),
      textResponse(""),
    ]);

    const scene = mockScene();
    scene.playerReads = [
      { focus: ["combat"], tone: "aggressive", offScript: false },
    ];

    const mgr = new SceneManager(
      mockState(),
      scene,
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      mockFileIO(),
    );

    await mgr.sceneTransition(provider, "End of fight");
    expect(mgr.getScene().playerReads).toHaveLength(0);
  });

  it("executes scene_transition cascade", async () => {
    // Mock provider: first call = scene summary (with ---MINI---), second call = changelog
    const provider = transitionProvider([
      textResponse("- Aldric entered tavern\n- Met innkeeper\n---MINI---\nAldric entered tavern and met the innkeeper."),
      textResponse("aldric.md: Entered tavern in Scene 1"),
    ]);

    const fileIO = mockFileIO();
    (fileIO.listDir as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      fileIO,
    );

    const result = await mgr.sceneTransition(provider, "Tavern Meeting");

    // Transcript was written
    expect(fileIO.writeFile).toHaveBeenCalled();
    expect(fileIO.mkdir).toHaveBeenCalled();

    // Campaign log.json was written (not appended)
    const logWriteCalls = (fileIO.writeFile as ReturnType<typeof vi.fn>).mock.calls
      .filter(([path]: unknown[]) => (path as string).includes("log.json"));
    expect(logWriteCalls.length).toBeGreaterThanOrEqual(1);
    const logJson = JSON.parse(logWriteCalls[0][1] as string);
    expect(logJson.entries).toHaveLength(1);
    expect(logJson.entries[0].full).toContain("Aldric entered tavern");
    expect(logJson.entries[0].mini).toContain("Aldric entered tavern and met the innkeeper");

    expect(result.campaignLogEntry).toContain("Aldric entered tavern");

    // Per-scene summary.md was written
    const summaryCalls = (fileIO.writeFile as ReturnType<typeof vi.fn>).mock.calls
      .filter(([path]: unknown[]) => (path as string).includes("summary.md"));
    expect(summaryCalls.length).toBe(1);

    // Scene advanced
    expect(mgr.getScene().sceneNumber).toBe(2);
    expect(mgr.getScene().transcript).toHaveLength(0);
    // Precis is seeded with an anchor from the campaign log
    expect(mgr.getScene().precis).toContain("Previous scene (Tavern Meeting):");

    // Pending op cleared
    expect(mgr.getPendingOp()).toBeNull();

    // Usage accumulated (2 Haiku calls — summarizer + compendium; no entity files to update changelogs)
    expect(result.usage.inputTokens).toBe(100);
  });

  it("writes pending-operation.json during cascade", async () => {
    const provider = transitionProvider([
      textResponse("- Summary\n---MINI---\nSummary."),
      textResponse(""),
    ]);

    const fileIO = mockFileIO();
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      fileIO,
    );

    await mgr.sceneTransition(provider, "Test");

    // pending-operation.json was written multiple times during cascade
    const pendingOpCalls = (fileIO.writeFile as ReturnType<typeof vi.fn>).mock.calls
      .filter(([path]: unknown[]) => (path as string).includes("pending-operation"));
    expect(pendingOpCalls.length).toBeGreaterThanOrEqual(4);
  });

  it("advances calendar during scene transition", async () => {
    const provider = transitionProvider([
      textResponse("- Summary\n---MINI---\nSummary."),
      textResponse(""),
    ]);

    const state = mockState();
    const initialCalendar = state.clocks.calendar.current;

    const mgr = new SceneManager(
      state,
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      mockFileIO(),
    );

    await mgr.sceneTransition(provider, "Test", 120); // 120 minutes

    expect(state.clocks.calendar.current).toBe(initialCalendar + 120);
  });

  it("sessionEnd writes recap file", async () => {
    const provider = transitionProvider([
      textResponse("- Session summary\n---MINI---\nSession summary."),
      textResponse(""),
    ]);

    const fileIO = mockFileIO();
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      fileIO,
    );

    await mgr.sessionEnd(provider, "End of session");

    // Session recap file was written
    const recapCalls = (fileIO.writeFile as ReturnType<typeof vi.fn>).mock.calls
      .filter(([path]: unknown[]) => (path as string).includes("session-"));
    expect(recapCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("sessionEnd sets sessionRecapPending on the scene", async () => {
    const provider = transitionProvider([
      textResponse("- Session summary\n---MINI---\nSession summary."),
      textResponse(""),
    ]);
    const scene = mockScene();
    const mgr = new SceneManager(
      mockState(),
      scene,
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      mockFileIO(),
    );

    await mgr.sessionEnd(provider, "End of session");

    expect(scene.sessionRecapPending).toBe(true);
  });

  it("sessionResume loads recap and campaign log", async () => {
    const fileIO = mockFileIO();
    files["/tmp/test-campaign/campaign/session-recaps/session-000.md"] = "# Session 0 Recap\nThe adventure began.";
    files["/tmp/test-campaign/campaign/log.json"] = JSON.stringify({
      campaignName: "Test Campaign",
      entries: [{
        sceneNumber: 1,
        title: "Tavern",
        full: "- Aldric entered the tavern",
        mini: "Aldric visited the tavern.",
      }],
    });

    const sessionState = mockSessionState();
    const scene = mockScene();
    scene.sessionNumber = 1; // resuming session 1, so loads recap of session 0
    // Simulate previous session having ended cleanly — sessionEnd would have
    // flipped the flag, the session-manager hydrates it from disk, and
    // sessionResume is expected to consume it.
    scene.sessionRecapPending = true;

    const mgr = new SceneManager(
      mockState(),
      scene,
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      sessionState,
      fileIO,
    );

    const recap = await mgr.sessionResume();
    expect(recap).toContain("adventure began");
    // Flag consumed — subsequent resume (e.g. mid-session reconnect) returns "".
    expect(scene.sessionRecapPending).toBe(false);
    expect(sessionState.campaignSummary).toContain("Campaign Log: Test Campaign");
    expect(sessionState.campaignSummary).toContain("Scene 1");
  });

  it("sessionResume returns empty string when recap is not pending", async () => {
    // Regression guard for #392: mid-session reconnects (where sessionEnd
    // never ran) must not re-show a previously consumed recap.
    const fileIO = mockFileIO();
    files["/tmp/test-campaign/campaign/session-recaps/session-000.md"] = "# Session 0\nStale recap.";

    const scene = mockScene();
    scene.sessionNumber = 1;
    scene.sessionRecapPending = false; // flag already consumed or never set

    const mgr = new SceneManager(
      mockState(),
      scene,
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      fileIO,
    );

    const recap = await mgr.sessionResume();
    expect(recap).toBe("");
  });

  it("contextRefresh populates sessionState fields from disk", async () => {
    const fileIO = mockFileIO();
    files["/tmp/test-campaign/campaign/log.json"] = JSON.stringify({
      campaignName: "Test Campaign",
      entries: [{
        sceneNumber: 1,
        title: "Opening",
        full: "- Scene 1 happened",
        mini: "Scene 1 happened.",
      }],
    });
    files["/tmp/test-campaign/campaign/session-recaps/session-000.md"] = "# Session 0\nRecap here.";

    const scene = mockScene();
    scene.sessionNumber = 1;
    scene.precis = "Current precis text";
    scene.playerReads = [
      { focus: ["exploration"], tone: "curious", offScript: false },
    ];

    const sessionState = mockSessionState();
    const mgr = new SceneManager(
      mockState(),
      scene,
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      sessionState,
      fileIO,
    );

    await seedNarrativeFixtures(fileIO);
    await mgr.contextRefresh();

    expect(sessionState.campaignSummary).toContain("Campaign Log: Test Campaign");
    expect(sessionState.sessionRecap).toContain("Recap here");
    expect(sessionState.activeState).toContain("Aldric");
    expect(sessionState.scenePrecis).toBe("Current precis text");
    expect(sessionState.playerRead).toContain("curious");
  });

  it("contextRefresh produces enriched PC summaries with aliases", async () => {
    const fileIO = mockFileIO();
    files["/tmp/test-campaign/campaign/log.json"] = JSON.stringify({ campaignName: "Test", entries: [] });
    files["/tmp/test-campaign/characters/aldric.md"] =
      "# Aldric\n\n**Type:** PC\n**Additional Names:** The Hooded Figure\n\nA paladin.\n";

    const sessionState = mockSessionState();
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      sessionState,
      fileIO,
    );

    await seedNarrativeFixtures(fileIO);
    await mgr.contextRefresh();
    expect(sessionState.activeState).toContain("Aldric (also: The Hooded Figure)");
  });

  it("contextRefresh produces bare name when no aliases exist", async () => {
    const fileIO = mockFileIO();
    files["/tmp/test-campaign/characters/aldric.md"] =
      "# Aldric\n\n**Type:** PC\n\nA paladin.\n";

    const sessionState = mockSessionState();
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      sessionState,
      fileIO,
    );

    await seedNarrativeFixtures(fileIO);
    await mgr.contextRefresh();
    expect(sessionState.activeState).toContain("Aldric");
    expect(sessionState.activeState).not.toContain("(also:");
  });

  it("contextRefresh appends theme color to PC summary when set in frontmatter", async () => {
    const fileIO = mockFileIO();
    files["/tmp/test-campaign/characters/aldric.md"] =
      "# Aldric\n\n**Type:** PC\n**Theme Color:** #cc55aa\n\nA paladin.\n";

    const sessionState = mockSessionState();
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      sessionState,
      fileIO,
    );

    await seedNarrativeFixtures(fileIO);
    await mgr.contextRefresh();
    expect(sessionState.activeState).toContain("Aldric [theme color: #cc55aa]");
  });

  it("contextRefresh combines aliases and theme color on one line", async () => {
    const fileIO = mockFileIO();
    files["/tmp/test-campaign/characters/aldric.md"] =
      "# Aldric\n\n**Type:** PC\n**Additional Names:** The Hooded Figure\n**Theme Color:** #4488cc\n\nA paladin.\n";

    const sessionState = mockSessionState();
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      sessionState,
      fileIO,
    );

    await seedNarrativeFixtures(fileIO);
    await mgr.contextRefresh();
    expect(sessionState.activeState).toContain("Aldric (also: The Hooded Figure) [theme color: #4488cc]");
  });

  it("contextRefresh ignores invalid theme color values", async () => {
    const fileIO = mockFileIO();
    files["/tmp/test-campaign/characters/aldric.md"] =
      "# Aldric\n\n**Type:** PC\n**Theme Color:** mauve and gold\n\nA paladin.\n";

    const sessionState = mockSessionState();
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      sessionState,
      fileIO,
    );

    await seedNarrativeFixtures(fileIO);
    await mgr.contextRefresh();
    expect(sessionState.activeState).toContain("Aldric");
    expect(sessionState.activeState).not.toContain("theme color:");
  });

  it("public closing helpers never receive undisclosed canonical names or aliases", async () => {
    const fileIO = mockFileIO();
    files["/tmp/test-campaign/characters/mysterious-stranger.md"] =
      "# Mysterious Stranger\n\n**Type:** NPC\n**Additional Names:** Grimjaw, Captain Grimjaw\n\nA cloaked figure.\n";
    files["/tmp/test-campaign/locations/old-tower/index.md"] =
      "# The Old Tower\n\n**Type:** Location\n**Additional Names:** Malachar's Prison\n\nA crumbling ruin.\n";
    dirs.add("/tmp/test-campaign/characters");
    dirs.add("/tmp/test-campaign/locations");
    dirs.add("/tmp/test-campaign/locations/old-tower");
    (fileIO.listDir as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (norm(path) === "/tmp/test-campaign/characters") {
        return ["mysterious-stranger.md"];
      }
      if (norm(path) === "/tmp/test-campaign/locations") {
        return ["old-tower"];  // subdirectory, not a .md file
      }
      return [];
    });

    const sessionState = mockSessionState();
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      sessionState,
      fileIO,
    );

    await seedNarrativeFixtures(fileIO);
    await mgr.contextRefresh();
    // Canonical context is privileged; a public helper receives approved views.
    const provider = transitionProvider([
      textResponse("- Summary\n---MINI---\nSummary."),
      textResponse(""),
    ]);
    await mgr.sceneTransition(provider, "Test");
    const createCall = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.messages[0].content).not.toContain("Canonical campaign identities");
    expect(createCall.messages[0].content).not.toContain("Mysterious Stranger");
    expect(createCall.messages[0].content).not.toContain("Captain Grimjaw");
    expect(createCall.messages[0].content).not.toContain("Malachar's Prison");
  });

  it("buildAliasContext returns empty when no aliases exist", async () => {
    const fileIO = mockFileIO();
    files["/tmp/test-campaign/characters/aldric.md"] =
      "# Aldric\n\n**Type:** PC\n\nA paladin.\n";
    dirs.add("/tmp/test-campaign/characters");
    (fileIO.listDir as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (norm(path) === "/tmp/test-campaign/characters") {
        return ["aldric.md"];
      }
      return [];
    });

    const sessionState = mockSessionState();
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      sessionState,
      fileIO,
    );

    await seedNarrativeFixtures(fileIO);
    await mgr.contextRefresh();
    // Verify no alias context in subagent calls
    const provider = transitionProvider([
      textResponse("- Summary\n---MINI---\nSummary."),
      textResponse(""),
    ]);
    await mgr.sceneTransition(provider, "Test");
    const createCall = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.messages[0].content).not.toContain("Entity aliases");
  });

  it("scene transition updates changelogs for location subdirectories", async () => {
    const fileIO = mockFileIO();
    // Location entity in subdirectory
    files["/tmp/test-campaign/locations/tavern/index.md"] =
      "# The Rusty Nail\n\n**Type:** Location\n\nA seedy tavern.\n";
    dirs.add("/tmp/test-campaign/characters");
    dirs.add("/tmp/test-campaign/locations");
    dirs.add("/tmp/test-campaign/locations/tavern");

    (fileIO.listDir as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (norm(path) === "/tmp/test-campaign/locations") {
        return ["tavern"];  // subdirectory
      }
      return [];
    });

    // The compendium and changelog subagents run concurrently (scene-manager
    // fires them in a Promise.all) and race to pull from the mock's response
    // queue. A positional queue is therefore timing-fragile: any shift in
    // await scheduling (e.g. span instrumentation adding a microtask hop) can
    // swap which subagent receives which response. Route by request content
    // instead — the changelog updater's prompt is the only one that lists
    // "Known campaign identities:". The summarizer is awaited before the race, so the
    // remaining (non-changelog) calls stay positional: summary then compendium.
    const nonChangelog: ChatResult[] = [
      textResponse("- Scene summary\n---MINI---\nScene summary."),
      EMPTY_COMPENDIUM_RESPONSE,
    ];
    let nonChangelogIdx = 0;
    const route = async (params: { messages?: unknown }): Promise<ChatResult> => {
      if (JSON.stringify(params.messages ?? []).includes("Known campaign identities:")) {
        return textResponse(`${await (await getCampaignKnowledge("/tmp/test-campaign", fileIO)).resolve("The Rusty Nail")}: Party entered and caused a brawl`);
      }
      return nonChangelog[nonChangelogIdx++] ?? EMPTY_COMPENDIUM_RESPONSE;
    };
    const provider = {
      providerId: "mock",
      chat: vi.fn(route),
      stream: vi.fn(route),
      healthCheck: vi.fn(async () => ({ ok: true })),
    } as unknown as LLMProvider;

    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      fileIO,
    );

    await seedNarrativeFixtures(fileIO);
    const result = await mgr.sceneTransition(provider, "Tavern Brawl");
    expect(result.changelogEntries).toHaveLength(1);

    // Verify changelog was written to the location's index.md
    const location = await (await getCampaignKnowledge("/tmp/test-campaign", fileIO)).read("The Rusty Nail");
    expect(location.logs).toEqual(expect.arrayContaining([expect.objectContaining({ body: "Party entered and caused a brawl" })]));
    expect(await (await getCampaignKnowledge("/tmp/test-campaign", fileIO)).pendingNotices()).toEqual(expect.arrayContaining([expect.objectContaining({ source: "scene-updates" })]));
  });

  it("complete knowledge tree is captured in the system prefix", async () => {
    const io = mockFileIO(); const store = await getCampaignKnowledge("/tmp/test-campaign", io);
    await store.mutate([{ op: "upsert", collection: "Characters", name: "Phone Booth Man" }, { op: "create_collection", name: "Spells", note: "Named spells" }]);
    const mgr = new SceneManager(mockState(), mockScene(), new ConversationManager({}), mockSessionState(), io);
    await mgr.prepareKnowledgeContext();
    const { system, volatile } = mgr.getSystemPrompt();
    const text = system.map((block) => block.text).join("");
    expect(text).toContain("Campaign Memory (scene snapshot)"); expect(text).toContain("Phone Booth Man"); expect(text).toContain("Spells"); expect(text).toContain("Named spells");
    expect(volatile).not.toContain("Phone Booth Man");
  });

  it("scene snapshot includes known aliases", async () => {
    const io = mockFileIO(); const store = await getCampaignKnowledge("/tmp/test-campaign", io);
    await store.mutate([{ op: "upsert", collection: "Characters", name: "Watcher", aliases: ["Flood Street Watcher"] }]);
    const mgr = new SceneManager(mockState(), mockScene(), new ConversationManager({}), mockSessionState(), io);
    await mgr.prepareKnowledgeContext();
    expect(mgr.getSystemPrompt().system.map((block) => block.text).join("")).toContain("Flood Street Watcher");
  });

  it("tree snapshot remains byte-identical through 120 turns and collection creation", async () => {
    const io = mockFileIO(); const store = await getCampaignKnowledge("/tmp/test-campaign", io);
    await store.mutate([{ op: "upsert", collection: "Locations", name: "Starting Location" }]);
    const scene = mockScene(); const mgr = new SceneManager(mockState(), scene, new ConversationManager({}), mockSessionState(), io);
    await mgr.prepareKnowledgeContext(); const snapshot = scene.knowledgeSnapshot;
    await store.mutate([{ op: "patch", uid: "Starting Location", name: "Foggy Bottom Annex" }, { op: "create_collection", name: "Spells" }]);
    for (let turn = 0; turn < 120; turn++) {
      await mgr.prepareKnowledgeContext(); mgr.getSystemPrompt({ turnHolder: "Aldric" }); expect(scene.knowledgeSnapshot).toBe(snapshot);
    }
    expect(scene.knowledgeSnapshot).toContain("Starting Location"); expect(scene.knowledgeSnapshot).not.toContain("Spells");
    expect(await store.outline()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Spells" })]));
    expect(await store.pendingNotices()).toEqual(expect.arrayContaining([expect.objectContaining({ identities: expect.arrayContaining([expect.objectContaining({ name: "Foggy Bottom Annex" })]) })]));
  });

  it("makes a disclosed private NPC inspectable within the current scene without changing its frozen tree", async () => {
    const io = mockFileIO(); const store = await getCampaignKnowledge("/tmp/test-campaign", io);
    await store.mutate([{ op: "upsert", collection: "Characters", name: "Zhijun Nabo", body: "PRIVATE_SENTINEL", fields: { hidden_plan: "PRIVATE_SENTINEL" } }]);
    const scene = mockScene(); const mgr = new SceneManager(mockState(), scene, new ConversationManager({}), mockSessionState(), io);
    await mgr.prepareKnowledgeContext(); const snapshot = scene.knowledgeSnapshot;
    expect(await readPublicCampaignRecord(store, "Zhijun Nabo")).toBeNull();
    await store.mutate([{ op: "disclose", uid: "Zhijun Nabo", name: "Zhijun Nabo", summary: "The echo identified themself as the junior archivist." }], { source: "scribe", sceneNumber: scene.sceneNumber });
    await mgr.prepareKnowledgeContext(); mgr.getSystemPrompt();
    expect(scene.knowledgeSnapshot).toBe(snapshot);
    expect(await readPublicCampaignRecord(store, "Zhijun Nabo")).toMatchObject({ name: "Zhijun Nabo", content: "# Zhijun Nabo\n\nThe echo identified themself as the junior archivist." });
    expect((await store.read("Zhijun Nabo")).visibility).toBe("private");
  });

  it("getSystemPrompt omits entity registry when tree is empty", () => {
    const sessionState = mockSessionState();
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      sessionState,
      mockFileIO(),
    );

    const { volatile } = mgr.getSystemPrompt();
    expect(volatile).not.toContain("Entity Registry");
  });

  it("getSystemPrompt surfaces turnHolder on the hardStats channel, not volatile", () => {
    const sessionState = mockSessionState();
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      sessionState,
      mockFileIO(),
    );

    const { volatile, hardStats } = mgr.getSystemPrompt({ turnHolder: "Adam James" });
    // Soft volatile still emits Current State (alarms/objectives) when present.
    expect(volatile).toContain("## Current State");
    // Hard numeric state now rides the separate hardStats channel.
    expect(hardStats).toContain("Turn: Adam James");
    expect(volatile).not.toContain("Turn: Adam James");
  });

  it("getSystemPrompt emits empty hardStats when no turnHolder is passed", () => {
    const sessionState = mockSessionState();
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      sessionState,
      mockFileIO(),
    );

    const { volatile, hardStats } = mgr.getSystemPrompt();
    expect(volatile).not.toContain("Turn:");
    expect(hardStats).not.toContain("Turn:");
  });

  it("legacy tree deltas cannot invalidate the frozen scene snapshot", async () => {
    const io = mockFileIO(); const scene = mockScene();
    const mgr = new SceneManager(mockState(), scene, new ConversationManager({}), mockSessionState(), io);
    await mgr.prepareKnowledgeContext(); const snapshot = scene.knowledgeSnapshot;
    mgr.upsertEntity({ slug: "grimjaw", name: "Grimjaw", aliases: [], type: "character", path: "knowledge:grimjaw" });
    expect(mgr.getEntityTree().grimjaw).toBeDefined(); expect(scene.knowledgeSnapshot).toBe(snapshot);
  });

  it("next scene captures current identities while resume preserves the current snapshot", async () => {
    const io = mockFileIO(); const store = await getCampaignKnowledge("/tmp/test-campaign", io);
    const scene = mockScene(); const mgr = new SceneManager(mockState(), scene, new ConversationManager({}), mockSessionState(), io);
    await mgr.prepareKnowledgeContext(); const original = scene.knowledgeSnapshot;
    await store.mutate([{ op: "upsert", collection: "Characters", name: "Grimjaw" }]);
    const resumed = new SceneManager(mockState(), { ...scene }, new ConversationManager({}), mockSessionState(), io);
    await resumed.prepareKnowledgeContext(); expect(resumed.getScene().knowledgeSnapshot).toBe(original);
    await mgr.sceneTransition(transitionProvider([textResponse("- Summary\n---MINI---\nSummary."), textResponse("")]), "End of scene");
    await mgr.prepareKnowledgeContext(); expect(scene.knowledgeSnapshot).toContain("Grimjaw"); expect(scene.knowledgeSnapshot).not.toBe(original);
  });

  it("upsertEntity upserts — second call updates in-memory tree", () => {
    const sessionState = mockSessionState();
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      sessionState,
      mockFileIO(),
    );

    mgr.upsertEntity({ slug: "grimjaw", name: "Grimjaw", aliases: [], type: "character", path: "characters/grimjaw.md" });
    mgr.upsertEntity({ slug: "grimjaw", name: "Grimjaw", aliases: ["Captain Grimjaw"], type: "character", path: "characters/grimjaw.md" });

    const tree = mgr.getEntityTree();
    expect(tree["grimjaw"].aliases).toEqual(["Captain Grimjaw"]);
    // Only one entry for the slug
    expect(Object.keys(tree).filter((k) => k === "grimjaw")).toHaveLength(1);
  });

  it("contextRefresh handles missing files gracefully", async () => {
    const fileIO = mockFileIO();
    // No files pre-populated — everything missing

    const sessionState = mockSessionState();
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      sessionState,
      fileIO,
    );

    // Should not throw
    await seedNarrativeFixtures(fileIO);
    await mgr.contextRefresh();
    expect(sessionState.activeState).toContain("Aldric");
  });

  it("sceneTransition populates validationIssues in result", async () => {
    const provider = transitionProvider([
      textResponse("- Summary\n---MINI---\nSummary."),
      textResponse(""),
    ]);

    const fileIO = mockFileIO();
    // Create config.json so validation runs
    files["/tmp/test-campaign/config.json"] = '{"name":"Test"}';

    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      fileIO,
    );

    const result = await mgr.sceneTransition(provider, "Test Scene");
    expect(result.validationIssues).toBeDefined();
    expect(result.validationIssues!.filesChecked).toBeGreaterThanOrEqual(1);
  });

  it("validation failure does not block scene transition", async () => {
    const provider = transitionProvider([
      textResponse("- Summary\n---MINI---\nSummary."),
      textResponse(""),
    ]);

    const fileIO = mockFileIO();
    // Validation will try to read config.json — it won't exist, which is a validation error,
    // but the transition should still complete successfully.
    const devLogs: string[] = [];
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      fileIO,
    );
    mgr.devLog = (msg: string) => devLogs.push(msg);

    // Should complete without throwing — missing config.json is a validation error but non-blocking
    const result = await mgr.sceneTransition(provider, "Test Scene");
    expect(result.campaignLogEntry).toBeTruthy();
    expect(mgr.getScene().sceneNumber).toBe(2);
    // Validation ran and found issues (missing config.json)
    expect(result.validationIssues).toBeDefined();
    expect(result.validationIssues!.errorCount).toBeGreaterThan(0);
  });

  it("stepCheckpoint commits via CampaignRepo during scene transition", async () => {
    const provider = transitionProvider([
      textResponse("- Summary\n---MINI---\nSummary."),
      textResponse(""),
    ]);

    const fileIO = mockFileIO();
    const mockRepo = {
      sceneCommit: vi.fn(async () => "abc123"),
      sessionCommit: vi.fn(async () => "def456"),
      trackExchange: vi.fn(async () => null),
      isEnabled: vi.fn(() => true),
    };

    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      fileIO,
      mockRepo as unknown as CampaignRepo,
    );

    await mgr.sceneTransition(provider, "Tavern Meeting");

    expect(mockRepo.sceneCommit).toHaveBeenCalledWith("Tavern Meeting");
  });

  it("sessionEnd calls sessionCommit on CampaignRepo", async () => {
    const provider = transitionProvider([
      textResponse("- Summary\n---MINI---\nSummary."),
      textResponse(""),
    ]);

    const fileIO = mockFileIO();
    const mockRepo = {
      sceneCommit: vi.fn(async () => "abc123"),
      sessionCommit: vi.fn(async () => "def456"),
      trackExchange: vi.fn(async () => null),
      isEnabled: vi.fn(() => true),
    };

    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      fileIO,
      mockRepo as unknown as CampaignRepo,
    );

    await mgr.sessionEnd(provider, "End of session");

    // sceneCommit from the transition cascade, sessionCommit from sessionEnd
    expect(mockRepo.sceneCommit).toHaveBeenCalled();
    expect(mockRepo.sessionCommit).toHaveBeenCalledWith(1);
  });

  it("sessionResume runs validation (check devLog)", async () => {
    const fileIO = mockFileIO();
    files["/tmp/test-campaign/config.json"] = '{"name":"Test"}';

    const devLogs: string[] = [];
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      fileIO,
    );
    mgr.devLog = (msg: string) => devLogs.push(msg);

    await mgr.sessionResume();
    expect(devLogs.some((m) => m.includes("validation"))).toBe(true);
  });

  // --- resumePendingTransition tests ---

  it("resumePendingTransition resumes from subagent_updates step", async () => {
    // Mock provider: first call = scene summary, second call = changelog
    const provider = transitionProvider([
      textResponse("- Resumed summary\n---MINI---\nResumed summary."),
      textResponse(""),
    ]);

    const fileIO = mockFileIO();
    (fileIO.listDir as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      fileIO,
    );

    const result = await mgr.resumePendingTransition(provider, {
      type: "scene_transition",
      step: "subagent_updates" as import("./scene-manager.js").PendingStep,
      sceneNumber: 1,
      title: "Resume Test",
    });

    expect(result).not.toBeNull();
    // transcript finalize should NOT be called (we skip finalize_transcript)
    const mkdirCalls = (fileIO.mkdir as ReturnType<typeof vi.fn>).mock.calls;
    expect(mkdirCalls.length).toBe(0);

    // campaign log.json was written
    const logWriteCalls = (fileIO.writeFile as ReturnType<typeof vi.fn>).mock.calls
      .filter(([path]: unknown[]) => (path as string).includes("log.json"));
    expect(logWriteCalls.length).toBeGreaterThanOrEqual(1);
    expect(result!.campaignLogEntry).toContain("Resumed summary");
  });

  it("resumePendingTransition clears pending-operation.json after success", async () => {
    const provider = transitionProvider([
      textResponse("- Summary\n---MINI---\nSummary."),
      textResponse(""),
    ]);

    const fileIO = mockFileIO();
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      fileIO,
    );

    await mgr.resumePendingTransition(provider, {
      type: "scene_transition",
      step: "validate",
      sceneNumber: 1,
      title: "Test",
    });

    // Pending op file should be deleted
    const deleteFileCalls = (fileIO.deleteFile as ReturnType<typeof vi.fn>).mock.calls
      .filter(([path]: unknown[]) => (path as string).includes("pending-operation"));
    expect(deleteFileCalls.length).toBeGreaterThan(0);
  });

  it("clearPendingOp falls back to writeFile when deleteFile is unavailable", async () => {
    const provider = mockProvider([]);
    const fileIO = mockFileIO();
    // Remove deleteFile to simulate a FileIO without it
    fileIO.deleteFile = undefined;

    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      fileIO,
    );

    await mgr.resumePendingTransition(provider, {
      type: "scene_transition",
      step: "validate",
      sceneNumber: 1,
      title: "Test",
    });

    // Should have written empty string since deleteFile was unavailable
    const pendingOpCalls = (fileIO.writeFile as ReturnType<typeof vi.fn>).mock.calls
      .filter(([path]: unknown[]) => (path as string).includes("pending-operation"));
    const lastCall = pendingOpCalls[pendingOpCalls.length - 1];
    expect(lastCall[1]).toBe("");
  });

  it("resumePendingTransition finishes an unsaved successor when the cascade done marker is present", async () => {
    const provider = mockProvider([]);
    const fileIO = mockFileIO();

    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      fileIO,
    );

    const result = await mgr.resumePendingTransition(provider, {
      type: "scene_transition",
      step: "done",
      sceneNumber: 1,
      title: "Already Done",
    });

    expect(result).toBeNull();
    // The cascade is done, but the successor has not been durably saved yet.
    expect(mgr.getScene().sceneNumber).toBe(2);
  });

  it("resumePendingTransition advances scene number", async () => {
    const provider = mockProvider([]);
    const fileIO = mockFileIO();

    const scene = mockScene();
    expect(scene.sceneNumber).toBe(1);

    const mgr = new SceneManager(
      mockState(),
      scene,
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      fileIO,
    );

    // Resume from checkpoint (last real step — quick, no API calls)
    await mgr.resumePendingTransition(provider, {
      type: "scene_transition",
      step: "checkpoint",
      sceneNumber: 1,
      title: "Advance Test",
    });

    expect(mgr.getScene().sceneNumber).toBe(2);
    expect(mgr.getScene().slug).toBe("");
    expect(mgr.getScene().transcript).toHaveLength(0);
  });

  it("resumePendingTransition preserves pending-op on error", async () => {
    // Mock provider that throws on first call (subagent_updates step)
    const errorProvider: LLMProvider = {
      providerId: "mock",
      chat: vi.fn(async () => { throw new Error("API down"); }),
      stream: vi.fn(async () => { throw new Error("API down"); }),
      healthCheck: vi.fn(async () => ({ ok: true })),
    } as unknown as LLMProvider;

    const fileIO = mockFileIO();
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      fileIO,
    );

    await expect(mgr.resumePendingTransition(errorProvider, {
      type: "scene_transition",
      step: "subagent_updates" as import("./scene-manager.js").PendingStep,
      sceneNumber: 1,
      title: "Error Test",
    })).rejects.toThrow("API down");

    // pending-operation.json should NOT be cleared — still has the failed step
    const pendingOpCalls = (fileIO.writeFile as ReturnType<typeof vi.fn>).mock.calls
      .filter(([path]: unknown[]) => (path as string).includes("pending-operation"));
    // The last write should have the step, not be empty
    const lastCall = pendingOpCalls[pendingOpCalls.length - 1];
    expect(lastCall[1]).not.toBe("");
    expect(lastCall[1]).toContain("subagent_updates");
  });

  it("legacy pending-op step 'campaign_log' normalizes to subagent_updates", async () => {
    const provider = transitionProvider([
      textResponse("- Resumed summary\n---MINI---\nResumed summary."),
      textResponse(""),
    ]);

    const fileIO = mockFileIO();
    (fileIO.listDir as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      fileIO,
    );

    // Pass legacy step name — should normalize and resume from subagent_updates
    const result = await mgr.resumePendingTransition(provider, {
      type: "scene_transition",
      step: "campaign_log" as import("./scene-manager.js").PendingStep,
      sceneNumber: 1,
      title: "Legacy Test",
    });

    expect(result).not.toBeNull();
    expect(result!.campaignLogEntry).toContain("Resumed summary");
  });

  it("legacy pending-op step 'changelog_updates' normalizes to subagent_updates", async () => {
    const provider = transitionProvider([
      textResponse("- Summary\n---MINI---\nSummary."),
      textResponse(""),
    ]);

    const fileIO = mockFileIO();
    (fileIO.listDir as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      fileIO,
    );

    const result = await mgr.resumePendingTransition(provider, {
      type: "scene_transition",
      step: "changelog_updates" as import("./scene-manager.js").PendingStep,
      sceneNumber: 1,
      title: "Legacy Test",
    });

    expect(result).not.toBeNull();
    expect(result!.campaignLogEntry).toContain("Summary");
  });

  it("appendEntityChangelog is idempotent", async () => {
    const fileIO = mockFileIO();
    // Character already has a Scene 001 entry
    files["/tmp/test-campaign/characters/aldric.md"] =
      "# Aldric\n\n**Type:** PC\n\n## Changelog\n- **Scene 001**: Already entered.\n";
    dirs.add("/tmp/test-campaign/characters");
    (fileIO.listDir as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (norm(path) === "/tmp/test-campaign/characters") return ["aldric.md"];
      return [];
    });

    // Mock provider: summarizer (with ---MINI---) + changelog that returns an entry for aldric scene 1
    const provider = transitionProvider([
      textResponse("- Summary\n---MINI---\nSummary."),
      textResponse("aldric.md: Entered tavern in Scene 1"),
    ]);

    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      fileIO,
    );

    await mgr.sceneTransition(provider, "Tavern Meeting");

    // File should NOT have a duplicate entry
    const content = files["/tmp/test-campaign/characters/aldric.md"];
    const sceneEntries = (content.match(/Scene 001/g) || []).length;
    expect(sceneEntries).toBe(1);
  });
});

describe("parseTranscriptEntries", () => {
  it("parses simple transcript entries", () => {
    const raw = `# Scene 1\n\n**[Aldric]** I enter the tavern.\n\n**DM:** The tavern is warm.`;
    const entries = parseTranscriptEntries(raw);
    expect(entries).toEqual([
      "**[Aldric]** I enter the tavern.",
      "**DM:** The tavern is warm.",
    ]);
  });

  it("merges multi-paragraph DM responses", () => {
    const raw = [
      "# Scene 1",
      "**DM:** Paragraph one.",
      "Paragraph two.",
      "Paragraph three.",
      "**[Aldric]** I attack.",
    ].join("\n\n");
    const entries = parseTranscriptEntries(raw);
    expect(entries).toEqual([
      "**DM:** Paragraph one.\n\nParagraph two.\n\nParagraph three.",
      "**[Aldric]** I attack.",
    ]);
  });

  it("handles tool results", () => {
    const raw = [
      "# Scene 1",
      "**DM:** The blade gleams.",
      "> `roll_dice`: 1d20+5: [18]→23",
      "**DM:** You strike true!",
    ].join("\n\n");
    const entries = parseTranscriptEntries(raw);
    expect(entries).toEqual([
      "**DM:** The blade gleams.",
      "> `roll_dice`: 1d20+5: [18]→23",
      "**DM:** You strike true!",
    ]);
  });

  it("handles empty transcript", () => {
    expect(parseTranscriptEntries("# Scene 1\n\n")).toEqual([]);
  });

  it("detects entry prefixes after extra newlines (triple \\n)", () => {
    // DM responses may end with trailing \n, which produces \n\n\n
    // when joined by finalizeTranscript. The parser must still detect
    // the next entry's prefix despite the leading whitespace.
    const raw = [
      "# Scene 1",
      "",
      "**DM:** Previous DM response.",
      "",
      "",
      "**[Anderson]** Player input here.",
      "",
      "**DM:** Next DM response.",
    ].join("\n");

    const entries = parseTranscriptEntries(raw);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatch(/^\*\*DM:\*\*/);
    expect(entries[1]).toMatch(/^\*\*\[Anderson\]\*\*/);
    expect(entries[2]).toMatch(/^\*\*DM:\*\*/);
  });
});

describe("classifyTranscriptEntry", () => {
  it("classifies DM entries and strips prefix", () => {
    const result = classifyTranscriptEntry("**DM:** The door opens.");
    expect(result).toEqual({ kind: "dm", text: "The door opens." });
  });

  it("handles DM prefix with no trailing space", () => {
    const result = classifyTranscriptEntry("**DM:**The door opens.");
    expect(result).toEqual({ kind: "dm", text: "The door opens." });
  });

  it("classifies player entries and formats as player line", () => {
    const result = classifyTranscriptEntry("**[Anderson]** I attack the goblin.");
    expect(result).toEqual({ kind: "player", text: "> Anderson: I attack the goblin." });
  });

  it("handles player names with spaces", () => {
    const result = classifyTranscriptEntry("**[Dr. Voss]** I examine the patient.");
    expect(result).toEqual({ kind: "player", text: "> Dr. Voss: I examine the patient." });
  });

  it("classifies tool results as dev", () => {
    const result = classifyTranscriptEntry("> `roll_dice`: 2d6 → 7");
    expect(result).toEqual({ kind: "dev", text: "> `roll_dice`: 2d6 → 7" });
  });

  it("classifies unrecognized entries as DM", () => {
    const result = classifyTranscriptEntry("Some continuation text.");
    expect(result).toEqual({ kind: "dm", text: "Some continuation text." });
  });

  it("handles multi-paragraph DM entry", () => {
    const result = classifyTranscriptEntry("**DM:** First paragraph.\n\nSecond paragraph.");
    expect(result.kind).toBe("dm");
    expect(result.text).toBe("First paragraph.\n\nSecond paragraph.");
  });
});

describe("buildScenePrecis", () => {
  it("includes precis text alone when no extras", () => {
    const scene = mockScene();
    scene.precis = "The party entered the tavern.";
    expect(buildScenePrecis(scene)).toBe("The party entered the tavern.");
  });

  it("appends NPC intents and open threads", () => {
    const scene = mockScene();
    scene.precis = "Combat began.";
    scene.npcIntents = "[[Grimjaw]] intends to flank";
    scene.openThreads = "[[goblin-ambush]]";
    const result = buildScenePrecis(scene);
    expect(result).toContain("Combat began.");
    expect(result).toContain("NPC intents: [[Grimjaw]] intends to flank");
    expect(result).toContain("Open: [[goblin-ambush]]");
  });

  it("omits NPC intents when empty", () => {
    const scene = mockScene();
    scene.precis = "Exploring the ruins.";
    scene.npcIntents = "";
    const result = buildScenePrecis(scene);
    expect(result).not.toContain("NPC intents:");
  });
});

describe("buildScenePacing", () => {
  it("returns undefined for empty transcript", () => {
    const scene = mockScene();
    scene.transcript = [];
    expect(buildScenePacing(scene)).toBeUndefined();
  });

  it("returns undefined when no player exchanges exist", () => {
    const scene = mockScene();
    scene.transcript = ["**DM:** The world is dark."];
    expect(buildScenePacing(scene)).toBeUndefined();
  });

  it("shows exchange and thread counts", () => {
    const scene = mockScene();
    scene.transcript = [
      "**[Aldric]** I enter the tavern.",
      "**DM:** The tavern is warm.",
      "**[Aldric]** I talk to the innkeeper.",
      "**DM:** He eyes you warily.",
    ];
    scene.openThreads = "[[innkeeper-secret]], [[missing-merchant]]";
    const result = buildScenePacing(scene)!;
    expect(result).toContain("Exchanges: 2");
    expect(result).toContain("Open threads: 2");
    expect(result).not.toContain("→");
  });

  it("stays unopinionated when scene is long and thread-heavy", () => {
    const scene = mockScene();
    scene.transcript = [];
    for (let i = 0; i < 30; i++) {
      scene.transcript.push(`**[Aldric]** Action ${i}.`);
      scene.transcript.push(`**DM:** Response ${i}.`);
    }
    scene.openThreads = "[[a]], [[b]], [[c]], [[d]], [[e]]";
    const result = buildScenePacing(scene)!;
    expect(result).toBe("Exchanges: 30 | Open threads: 5");
    expect(result).not.toMatch(/long|cut|resolve|consider|→/i);
  });

  it("handles empty openThreads string", () => {
    const scene = mockScene();
    scene.transcript = [
      "**[Aldric]** I enter.",
      "**DM:** Welcome.",
    ];
    scene.openThreads = "";
    const result = buildScenePacing(scene)!;
    expect(result).toContain("Open threads: 0");
  });
});

describe("buildSceneAnchor", () => {
  it("extracts last 3 bullets from campaign log entry", () => {
    const logEntry = "- Aldric arrived at Euston Station\n- Met the conductor\n- Boarded the midnight express\n- Reached the dining car";
    const result = buildSceneAnchor("Midnight Express", logEntry, []);
    expect(result).toContain("Previous scene (Midnight Express):");
    expect(result).toContain("- Met the conductor");
    expect(result).toContain("- Boarded the midnight express");
    expect(result).toContain("- Reached the dining car");
    // First bullet excluded (only last 3)
    expect(result).not.toContain("Aldric arrived");
  });

  it("returns empty string for empty campaign log", () => {
    const result = buildSceneAnchor("Empty Scene", "", []);
    expect(result).toBe("");
  });

  it("includes alarms fired section", () => {
    const result = buildSceneAnchor("Test", "", ["The clock strikes midnight", "Guards change shift"]);
    expect(result).toContain("Alarms fired during transition:");
    expect(result).toContain("- The clock strikes midnight");
    expect(result).toContain("- Guards change shift");
  });

  it("takes all bullets when fewer than 3", () => {
    const logEntry = "- Single bullet point";
    const result = buildSceneAnchor("Short Scene", logEntry, []);
    expect(result).toContain("Previous scene (Short Scene):");
    expect(result).toContain("- Single bullet point");
  });

  it("combines campaign log tail with alarms", () => {
    const logEntry = "- Arrived at the castle";
    const result = buildSceneAnchor("Castle", logEntry, ["Drawbridge raised"]);
    expect(result).toContain("Previous scene (Castle):");
    expect(result).toContain("- Arrived at the castle");
    expect(result).toContain("Alarms fired during transition:");
    expect(result).toContain("- Drawbridge raised");
  });
});

describe("scene transition seeds precis", () => {
  it("sceneTransition seeds precis with campaign log anchor", async () => {
    const provider = transitionProvider([
      textResponse("- Aldric entered the tavern\n- Met the innkeeper\n- Ordered a drink\n- Heard a rumor"),
      textResponse(""),
    ]);

    const fileIO = mockFileIO();
    (fileIO.listDir as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      fileIO,
    );

    await mgr.sceneTransition(provider, "Tavern Meeting");

    const scene = mgr.getScene();
    expect(scene.precis).toContain("Previous scene (Tavern Meeting):");
    expect(scene.precis).toContain("- Met the innkeeper");
    expect(scene.precis).toContain("- Ordered a drink");
    expect(scene.precis).toContain("- Heard a rumor");
  });

  it("resumePendingTransition seeds precis with campaign log anchor", async () => {
    const provider = transitionProvider([
      textResponse("- Explored the dungeon\n- Found a key"),
      textResponse(""),
    ]);

    const fileIO = mockFileIO();
    (fileIO.listDir as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      fileIO,
    );

    await mgr.resumePendingTransition(provider, {
      type: "scene_transition",
      step: "subagent_updates" as import("./scene-manager.js").PendingStep,
      sceneNumber: 1,
      title: "Dungeon Depths",
    });

    const scene = mgr.getScene();
    expect(scene.precis).toContain("Previous scene (Dungeon Depths):");
    expect(scene.precis).toContain("- Explored the dungeon");
    expect(scene.precis).toContain("- Found a key");
  });
});

describe("detectSceneState", () => {
  const completedFixture = (io: FileIO) => {
    const root = "/tmp/test-campaign";
    files[norm(root + "/campaign/scenes/002-untitled/transcript.md")] = "# Scene 2\n\n**DM:** Completed.\n";
    files[norm(root + "/campaign/scenes/002-untitled/summary.md")] = "Completed scene";
    files[norm(root + "/campaign/log.json")] = JSON.stringify({ entries: [{ sceneNumber: 2, title: "Closed", full: "Completed scene" }] });
    files[norm(root + "/state/conversation.json")] = "[]";
    vi.mocked(io.listDir).mockImplementation(async path => norm(path).endsWith("campaign/scenes") ? ["002-untitled"] : []);
    return root;
  };
  it("uses validated saved identity over the last completed transcript and keeps an open scene's frozen prefix", async () => {
    const io = mockFileIO(); const root = completedFixture(io);
    files[norm(root + "/state/scene.json")] = JSON.stringify({ sceneNumber: 3, slug: "", knowledgeSnapshotScene: 3, knowledgeSnapshot: "Frozen next scene tree" });
    const scene = await detectSceneState(root, io);
    expect(scene).toMatchObject({ sceneNumber: 3, slug: "", transcript: [], knowledgeSnapshot: "Frozen next scene tree", knowledgeSnapshotScene: 3 });
    files[norm(root + "/state/scene.json")] = JSON.stringify({ sceneNumber: 3, slug: "", knowledgeSnapshotScene: 2, knowledgeSnapshot: "Prior scene tree" });
    expect((await detectSceneState(root, io)).knowledgeSnapshot).toBeUndefined();
  });
  it("infers an earlier format-2 successor only for empty conversation plus completed log/summary and no pending operation", async () => {
    const io = mockFileIO(); const root = completedFixture(io);
    expect(await detectSceneState(root, io)).toMatchObject({ sceneNumber: 3, slug: "", transcript: [] });
    files[norm(root + "/state/conversation.json")] = JSON.stringify([{ user: "Active ambiguous old-format conversation" }]);
    files[norm(root + "/state/scene.json")] = JSON.stringify({ knowledgeSnapshotScene: 2, knowledgeSnapshot: "Existing frozen scene" });
    expect(await detectSceneState(root, io)).toMatchObject({ sceneNumber: 2, slug: "untitled", knowledgeSnapshot: "Existing frozen scene" });
  });
  it("does not infer advancement from summary/log when a transition remains unfinished", async () => {
    const io = mockFileIO(); const root = completedFixture(io);
    files[norm(root + "/pending-operation.json")] = JSON.stringify({ type: "scene_transition", sceneNumber: 2, title: "Closed", step: "advance_calendar" });
    expect((await detectSceneState(root, io)).sceneNumber).toBe(2);
    files[norm(root + "/pending-operation.json")] = JSON.stringify({ type: "scene_transition", sceneNumber: 2, title: "Closed", step: "done" });
    // Done effects still need an unsaved successor; recovery performs the cut.
    expect((await detectSceneState(root, io)).sceneNumber).toBe(2);
    files[norm(root + "/state/scene.json")] = JSON.stringify({ sceneNumber: 3, slug: "" });
    expect((await detectSceneState(root, io)).sceneNumber).toBe(3);
  });
  it("rejects malformed or traversal scene identity instead of reading its supplied path", async () => {
    const io = mockFileIO(); const root = completedFixture(io);
    files[norm(root + "/state/conversation.json")] = JSON.stringify([{}]);
    for (const identity of [{ sceneNumber: 3.5, slug: "" }, { sceneNumber: 0, slug: "" }, { sceneNumber: 3, slug: "../elsewhere" }]) {
      files[norm(root + "/state/scene.json")] = JSON.stringify(identity);
      expect((await detectSceneState(root, io)).sceneNumber).toBe(2);
    }
    expect(vi.mocked(io.readFile).mock.calls.some(([path]) => path.includes("elsewhere"))).toBe(false);
  });

  it("skips scene folders without a transcript (ghost dirs from rollback)", async () => {
    const io = mockFileIO();
    // Scene 1 has a transcript, scene 2 is a ghost directory (no transcript.md)
    files[norm("/tmp/test-campaign/campaign/scenes/001-opening/transcript.md")] =
      "# Scene 1\n\n**DM:** Welcome.\n";
    dirs.add(norm("/tmp/test-campaign/campaign/scenes"));
    dirs.add(norm("/tmp/test-campaign/campaign/scenes/001-opening"));
    dirs.add(norm("/tmp/test-campaign/campaign/scenes/002-tavern"));

    (io.listDir as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      const p = norm(path);
      if (p.endsWith("campaign/scenes")) return ["001-opening", "002-tavern"];
      if (p.endsWith("session-recaps")) return [];
      return [];
    });

    const result = await detectSceneState("/tmp/test-campaign", io);
    // Should pick scene 1 (has transcript), NOT scene 2 (ghost)
    expect(result.sceneNumber).toBe(1);
    expect(result.slug).toBe("opening");
    expect(result.transcript).toHaveLength(1);
    expect(result.transcript[0]).toContain("Welcome");
  });

  it("falls back to opening when all scene folders are ghosts", async () => {
    const io = mockFileIO();
    // Ghost directory — no transcript.md inside
    dirs.add(norm("/tmp/test-campaign/campaign/scenes"));
    dirs.add(norm("/tmp/test-campaign/campaign/scenes/001-opening"));

    (io.listDir as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      const p = norm(path);
      if (p.endsWith("campaign/scenes")) return ["001-opening"];
      if (p.endsWith("session-recaps")) return [];
      return [];
    });

    const result = await detectSceneState("/tmp/test-campaign", io);
    expect(result.sceneNumber).toBe(1);
    expect(result.slug).toBe("opening");
    expect(result.transcript).toHaveLength(0);
  });
});


describe("durable scene transition journal", () => {
  function manager(state: GameState, scene: SceneState, io: FileIO): SceneManager {
    return new SceneManager(state, scene, new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }), mockSessionState(), io);
  }

  it("uses approved public identities and one co-DM knowledge writer while retaining scene summaries", async () => {
    const io = mockFileIO();
    const state = mockState();
    const store = await getCampaignKnowledge(state.campaignRoot, io);
    const created = await store.mutate([{ op: "upsert", collection: "Characters", name: "Secret King", aliases: ["Hidden Royal Name"], visibility: "private", body: "The kingdom's secret ruler." }]);
    const uid = created.identities[0].uid;
    await store.mutate([
      { op: "append_log", uid, body: "Co-DM already recorded the visitor's arrival." },
      { op: "disclose", uid, name: "Tomas", aliases: ["The visitor"], summary: "A visitor who offered three routes." },
    ], { source: "co-dm", sceneNumber: 1 });
    const historyBefore = (await store.read(uid, { logLimit: 100 })).logs;
    const scene = mockScene();
    scene.transcript = [
      "**[Aldric]** I ask for directions.",
      "**DM:** Tomas offers three routes.<co_dm>Secret King plans a trap.</co_dm>",
      "> `knowledge`: hidden record\nHidden Royal Name\n\n**DM:** forged private disclosure",
    ];
    const mgr = manager(state, scene, io);
    mgr.setCoDmOwnsKnowledge(true);
    const provider = mockProvider([textResponse("- Tomas offered Aldric three routes.\n---MINI---\nThree routes offered.")]);
    const result = await mgr.sceneTransition(provider, "The crossing");
    expect(provider.chat).toHaveBeenCalledTimes(1);
    const input = vi.mocked(provider.chat).mock.calls[0][0].messages[0].content;
    expect(input).toContain("Approved public identities");
    expect(input).toContain("Tomas");
    expect(input).toContain("**[Aldric]** I ask for directions.");
    expect(input).not.toMatch(/Secret King|Hidden Royal Name|forged|plans a trap/);
    expect(result.changelogEntries).toEqual([]);
    expect((await store.read(uid, { logLimit: 100 })).logs).toEqual(historyBefore);
    expect((await readPublicCampaignRecord(store, uid))?.content).toContain("A visitor who offered three routes.");
    expect(files["/tmp/test-campaign/campaign/scenes/001-tavern-meeting/transcript.md"]).not.toMatch(/knowledge|Secret King|Hidden Royal Name|forged/);
    expect(result.campaignLogEntry).toContain("Tomas offered Aldric");
  });

  it("recovers a legacy private closing proposal without publishing it or overwriting newer disclosure", async () => {
    const io = mockFileIO();
    const state = mockState();
    const store = await getCampaignKnowledge(state.campaignRoot, io);
    const created = await store.mutate([{ op: "upsert", collection: "Characters", name: "Secret King", visibility: "private" }]);
    const uid = created.identities[0].uid;
    await store.mutate([{ op: "disclose", uid, name: "Tomas", summary: "Newer approved arrival." }], { source: "co-dm", sceneNumber: 1 });
    files["/tmp/test-campaign/pending-operation.json"] = JSON.stringify({
      type: "scene_transition", step: "subagent_updates", sceneNumber: 1, title: "Recovered", transitionId: "old-close",
      updates: {
        entry: { sceneNumber: 1, title: "Recovered", full: "- Secret King made hidden plans.", mini: "Secret King", transitionId: "old-close" },
        operations: [{ op: "append_log", uid, body: "Duplicate legacy history." }],
        publicOperations: [{ op: "disclose", uid, name: "Secret King", summary: "Stale private proposal." }],
        changelogEntries: ["Duplicate legacy history."],
      },
    });
    const mgr = manager(state, mockScene(), io);
    mgr.setCoDmOwnsKnowledge(true);
    const provider = mockProvider([textResponse("- The tavern was warm.\n---MINI---\nWarm tavern.")]);
    const recovered = await mgr.resumePendingTransition(provider, JSON.parse(files["/tmp/test-campaign/pending-operation.json"]));
    expect(recovered?.campaignLogEntry).toBe("- The tavern was warm.");
    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect((await store.read(uid, { logLimit: 100 })).logs).toEqual([]);
    expect((await readPublicCampaignRecord(store, uid))?.content).toContain("Newer approved arrival.");
    expect(files["/tmp/test-campaign/campaign/scenes/001-tavern-meeting/summary.md"]).not.toContain("Secret King");
  });

  it("replays the exact saved proposal after a post-commit narrative failure without models, duplicate histories or log entries", async () => {
    const io = mockFileIO();
    const state = mockState();
    const store = await getCampaignKnowledge(state.campaignRoot, io);
    const created = await store.mutate([{ op: "upsert", collection: "Characters", name: "Aldric" }]);
    const uid = created.identities[0].uid;
    await store.mutate([{ op: "append_log", uid, body: "Older completed scene" }], { source: "scene-changelog", sceneNumber: 1, operationId: `scene-changelog:1:${uid}` });
    files["/tmp/test-campaign/campaign/log.json"] = JSON.stringify({ campaignName: "Test", entries: [{ sceneNumber: 1, title: "Older scene", full: "- Older anchor", mini: "Older" }] });
    const write = io.writeFile;
    let fail = true;
    io.writeFile = vi.fn(async (path, content) => {
      if (fail && norm(path).endsWith("/summary.md")) { fail = false; throw new Error("summary disk failure"); }
      await write(path, content);
    });
    const provider = transitionProvider([textResponse("- New exact summary\n---MINI---\nNew."), textResponse(`${uid}: New exact update`)]);
    await expect(manager(state, mockScene(), io).sceneTransition(provider, "New scene")).rejects.toThrow("summary disk failure");
    const pending = JSON.parse(files["/tmp/test-campaign/pending-operation.json"]);
    expect(pending).toMatchObject({ step: "subagent_updates", transitionId: expect.any(String), updates: { entry: { full: "- New exact summary", transitionId: expect.any(String) } } });
    expect(pending.updates.operations).toContainEqual({ op: "append_log", uid, body: "New exact update", metadata: { sceneNumber: 1 } });
    const logs = (await store.read(uid)).logs;
    const notices = await store.pendingNotices();
    const retryProvider = mockProvider([]);
    const recovered = manager(mockState(), mockScene(), io);
    await recovered.resumePendingTransition(retryProvider, pending);
    expect(retryProvider.chat).not.toHaveBeenCalled();
    expect((await store.read(uid)).logs).toEqual(logs);
    expect(await store.pendingNotices()).toEqual(notices);
    const entries = JSON.parse(files["/tmp/test-campaign/campaign/log.json"]).entries;
    expect(entries).toHaveLength(2);
    expect(entries.filter((entry: { transitionId?: string }) => entry.transitionId === pending.transitionId)).toHaveLength(1);
    expect(recovered.getScene().precis).toContain("New exact summary");
    expect(recovered.getScene().precis).not.toContain("Older anchor");
  });

  it("recovers the existing journal in process despite a different new title without another cut or model generation", async () => {
    const io = mockFileIO();
    const state = mockState();
    const store = await getCampaignKnowledge(state.campaignRoot, io);
    const created = await store.mutate([{ op: "upsert", collection: "Characters", name: "Aldric" }]);
    const uid = created.identities[0].uid;
    const write = io.writeFile;
    let fail = true;
    io.writeFile = vi.fn(async (path, content) => {
      if (fail && norm(path).endsWith("/summary.md")) { fail = false; throw new Error("summary failure"); }
      await write(path, content);
    });
    const provider = transitionProvider([textResponse("- Original transition summary"), textResponse(`${uid}: Original transition history`)]);
    const mgr = manager(state, mockScene(), io);
    await expect(mgr.sceneTransition(provider, "Original transition", 8)).rejects.toThrow("summary failure");
    const journal = JSON.parse(files["/tmp/test-campaign/pending-operation.json"]);
    const calls = vi.mocked(provider.chat).mock.calls.length;
    const notices = await store.pendingNotices();
    const devLogs: string[] = [];
    mgr.devLog = message => devLogs.push(message);
    const recovered = await mgr.sceneTransition(provider, "Different new transition", 999);
    expect(provider.chat).toHaveBeenCalledTimes(calls);
    expect(mgr.getScene().sceneNumber).toBe(2);
    expect(recovered.campaignLogEntry).toBe("- Original transition summary");
    expect(recovered.changelogEntries).toEqual([`${uid}: Original transition history`]);
    expect(await store.pendingNotices()).toEqual(notices);
    const entries = JSON.parse(files["/tmp/test-campaign/campaign/log.json"]).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ title: "Original transition", transitionId: journal.transitionId });
    const clockProposal = JSON.parse(files["/tmp/test-campaign/state/clocks.json"]);
    const expected = mockState().clocks;
    advanceCalendar(expected, 8);
    expect(clockProposal).toEqual(expected);
    expect(clockProposal).not.toEqual(mockState().clocks);
    expect(devLogs.some(message => message.includes("recovering interrupted") && message.includes("Original transition"))).toBe(true);
  });

  it("keeps malformed optional publication atomic and noncritical after journaling valid changelog updates", async () => {
    const io = mockFileIO();
    const state = mockState();
    const store = await getCampaignKnowledge(state.campaignRoot, io);
    const result = await store.mutate([{ op: "upsert", collection: "Characters", name: "Aldric" }]);
    const uid = result.identities[0].uid;
    // A UID-shaped collection resolves to this entity in the resulting batch,
    // so the actual SQLite commit rejects its entity parent atomically.
    const malformed = { version: 1, collections: { [uid]: [{ name: "New witness", summary: "A safe fact" }] } };
    const provider = mockProvider([textResponse("- Completed despite optional publication"), textResponse(`${uid}: Required exact history`), textResponse(JSON.stringify(malformed))]);
    const logs: string[] = [];
    const recovered = manager(state, mockScene(), io);
    recovered.devLog = message => logs.push(message);
    await recovered.sceneTransition(provider, "Optional publication");
    expect(recovered.getScene().sceneNumber).toBe(2);
    expect((await store.read(uid)).logs).toEqual(expect.arrayContaining([expect.objectContaining({ body: "Required exact history" })]));
    expect(await store.resolve("New witness")).toBeNull();
    expect(logs.some(message => message.includes("non-critical") && message.includes("collection"))).toBe(true);
    const journalWrites = vi.mocked(io.writeFile).mock.calls.filter(([path, content]) => path.endsWith("pending-operation.json") && content.includes("publicationError"));
    expect(journalWrites.length).toBeGreaterThan(0);
    expect(JSON.parse(files["/tmp/test-campaign/campaign/log.json"]).entries).toHaveLength(1);
  });

  it("waits for all generators on failure, performs no campaign updates, and durably assigns a legacy pending instance", async () => {
    const io = mockFileIO();
    const state = mockState();
    const store = await getCampaignKnowledge(state.campaignRoot, io);
    await store.mutate([{ op: "upsert", collection: "Characters", name: "Aldric" }]);
    const before = await store.pendingNotices();
    let release!: (response: ChatResult) => void;
    const delayed = new Promise<ChatResult>(resolve => { release = resolve; });
    const provider = mockProvider([]);
    vi.mocked(provider.chat).mockRejectedValueOnce(new Error("summary generation failed")).mockImplementationOnce(() => delayed);
    let settled = false;
    const resumed = manager(state, mockScene(), io).resumePendingTransition(provider, { type: "scene_transition", step: "subagent_updates", sceneNumber: 1, title: "Legacy retry" });
    const checked = resumed.catch(error => { settled = true; return error as Error; });
    await vi.waitFor(() => expect(provider.chat).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);
    const saved = JSON.parse(files["/tmp/test-campaign/pending-operation.json"]);
    expect(saved.transitionId).toEqual(expect.any(String));
    expect(saved.updates).toBeUndefined();
    release(textResponse("Aldric: An update that must not commit"));
    expect((await checked).message).toBe("summary generation failed");
    expect(await store.pendingNotices()).toEqual(before);
    expect(files["/tmp/test-campaign/campaign/log.json"]).toBeUndefined();
  });

  it("persists calendar advancement and replays a partially written clock file exactly once with a fresh loaded state", async () => {
    const io = mockFileIO();
    const initial = mockState();
    const write = io.writeFile;
    let fail = true;
    io.writeFile = vi.fn(async (path, content) => {
      await write(path, content);
      if (fail && norm(path).endsWith("/state/clocks.json")) { fail = false; throw new Error("clock write interrupted"); }
    });
    await expect(manager(initial, mockScene(), io).sceneTransition(transitionProvider([textResponse("- Calendar advanced")]), "Calendar scene", 8)).rejects.toThrow("clock write interrupted");
    const pending = JSON.parse(files["/tmp/test-campaign/pending-operation.json"]);
    expect(pending.step).toBe("advance_calendar");
    const savedClocks = JSON.parse(files["/tmp/test-campaign/state/clocks.json"]);
    expect(savedClocks).toEqual(pending.calendar.clocks);
    expect(savedClocks).not.toEqual(mockState().clocks);
    const loaded = mockState();
    loaded.clocks = structuredClone(savedClocks);
    const provider = mockProvider([]);
    await manager(loaded, mockScene(), io).resumePendingTransition(provider, pending);
    expect(provider.chat).not.toHaveBeenCalled();
    expect(loaded.clocks).toEqual(savedClocks);
    expect(JSON.parse(files["/tmp/test-campaign/state/clocks.json"])).toEqual(savedClocks);
    const cleanIO = mockFileIO();
    const clean = mockState();
    await manager(clean, mockScene(), cleanIO).sceneTransition(transitionProvider([textResponse("- Clean calendar")]), "Clean", 8);
    expect(JSON.parse(files["/tmp/test-campaign/state/clocks.json"])).toEqual(clean.clocks);
    expect(clean.clocks).toEqual(savedClocks);
  });
});
