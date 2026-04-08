import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LLMProvider, ChatResult } from "../providers/types.js";
import { SceneManager, parseTranscriptEntries, classifyTranscriptEntry, buildScenePrecis, buildScenePacing, buildSceneAnchor, detectSceneState } from "./scene-manager.js";
import type { SceneState, FileIO } from "./scene-manager.js";
import type { CampaignRepo } from "../tools/git/index.js";
import type { GameState } from "./game-state.js";
import { ConversationManager } from "../context/conversation.js";
import type { DMSessionState } from "./dm-prompt.js";
import { createClocksState } from "../tools/clocks/index.js";
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
      choices: { campaign_default: "often", player_overrides: {} },
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
      textResponse('Aldric entered the tavern.\nPLAYER_READ: {"engagement":"high","focus":["exploration"],"tone":"curious","pacing":"exploratory","offScript":true}'),
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
    expect(mgr.getScene().playerReads[0].engagement).toBe("high");
    expect(mgr.getScene().playerReads[0].tone).toBe("curious");
  });

  it("clears player reads on scene transition", async () => {
    const provider = transitionProvider([
      textResponse("- Summary\n---MINI---\nSummary."),
      textResponse(""),
    ]);

    const scene = mockScene();
    scene.playerReads = [
      { engagement: "high", focus: ["combat"], tone: "aggressive", pacing: "pushing_forward", offScript: false },
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

    const mgr = new SceneManager(
      mockState(),
      scene,
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      sessionState,
      fileIO,
    );

    const recap = await mgr.sessionResume();
    expect(recap).toContain("adventure began");
    expect(sessionState.campaignSummary).toContain("Campaign Log: Test Campaign");
    expect(sessionState.campaignSummary).toContain("Scene 1");
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
      { engagement: "high", focus: ["exploration"], tone: "curious", pacing: "exploratory", offScript: false },
    ];

    const sessionState = mockSessionState();
    const mgr = new SceneManager(
      mockState(),
      scene,
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      sessionState,
      fileIO,
    );

    await mgr.contextRefresh();

    expect(sessionState.campaignSummary).toContain("Campaign Log: Test Campaign");
    expect(sessionState.sessionRecap).toContain("Recap here");
    expect(sessionState.activeState).toContain("Aldric");
    expect(sessionState.scenePrecis).toBe("Current precis text");
    expect(sessionState.playerRead).toContain("high");
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

    await mgr.contextRefresh();
    expect(sessionState.activeState).toContain("Aldric");
    expect(sessionState.activeState).not.toContain("(also:");
  });

  it("buildAliasContext returns formatted alias lines across entity types", async () => {
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

    await mgr.contextRefresh();
    // The alias context is private, but we can verify it's passed to subagents
    // by checking the summarizer call in a transition
    const provider = transitionProvider([
      textResponse("- Summary\n---MINI---\nSummary."),
      textResponse(""),
    ]);
    await mgr.sceneTransition(provider, "Test");
    const createCall = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createCall.messages[0].content).toContain("Entity aliases");
    expect(createCall.messages[0].content).toContain("mysterious-stranger.md: also known as Grimjaw, Captain Grimjaw");
    expect(createCall.messages[0].content).toContain("old-tower/index.md: also known as Malachar's Prison");
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

    // Mock provider: summarizer + compendium (resolves before changelog due to fewer awaits) + changelog
    const provider = transitionProvider([
      textResponse("- Scene summary\n---MINI---\nScene summary."),
      EMPTY_COMPENDIUM_RESPONSE,
      textResponse("tavern/index.md: Party entered and caused a brawl"),
    ]);

    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      mockSessionState(),
      fileIO,
    );

    const result = await mgr.sceneTransition(provider, "Tavern Brawl");
    expect(result.changelogEntries).toHaveLength(1);

    // Verify changelog was written to the location's index.md
    const locationContent = files["/tmp/test-campaign/locations/tavern/index.md"];
    expect(locationContent).toContain("## Changelog");
    expect(locationContent).toContain("Party entered and caused a brawl");
  });

  it("entity tree from constructor appears in volatile context", () => {
    const sessionState = mockSessionState();
    const initialTree = {
      "phone-booth-man": { name: "Phone Booth Man", aliases: [], type: "character", path: "characters/phone-booth-man.md" },
    };
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      sessionState,
      mockFileIO(),
      undefined,
      initialTree,
    );

    const { volatile } = mgr.getSystemPrompt();
    expect(volatile).toContain("Entity Registry");
    expect(volatile).toContain("characters/phone-booth-man.md");
    expect(volatile).toContain("Phone Booth Man");
  });

  it("entity tree snapshot includes aliases", () => {
    const sessionState = mockSessionState();
    const initialTree = {
      "flood-street-watcher": { name: "Flood Street Watcher", aliases: ["The Watcher"], type: "character", path: "characters/flood-street-watcher.md" },
    };
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      sessionState,
      mockFileIO(),
      undefined,
      initialTree,
    );

    const { volatile } = mgr.getSystemPrompt();
    expect(volatile).toContain("Flood Street Watcher (character) aka The Watcher");
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

  it("mid-scene upserts update the tree but not the DM snapshot", () => {
    const sessionState = mockSessionState();
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      sessionState,
      mockFileIO(),
    );

    mgr.upsertEntity({ slug: "grimjaw", name: "Grimjaw", aliases: [], type: "character", path: "characters/grimjaw.md" });

    // In-memory tree has the entry
    expect(mgr.getEntityTree()["grimjaw"]).toBeDefined();
    // But the DM snapshot (frozen at construction) does not
    const { volatile } = mgr.getSystemPrompt();
    expect(volatile).not.toContain("Grimjaw");
  });

  it("entity tree snapshot refreshes after scene transition", async () => {
    const provider = transitionProvider([
      textResponse("- Summary\n---MINI---\nSummary."),
      textResponse(""),
    ]);

    const sessionState = mockSessionState();
    const mgr = new SceneManager(
      mockState(),
      mockScene(),
      new ConversationManager({ retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 }),
      sessionState,
      mockFileIO(),
    );

    // Upsert mid-scene — not in snapshot yet
    mgr.upsertEntity({ slug: "grimjaw", name: "Grimjaw", aliases: [], type: "character", path: "characters/grimjaw.md" });
    let { volatile } = mgr.getSystemPrompt();
    expect(volatile).not.toContain("Grimjaw");

    await mgr.sceneTransition(provider, "End of scene");

    // After transition, snapshot is refreshed — now includes Grimjaw
    ({ volatile } = mgr.getSystemPrompt());
    expect(volatile).toContain("Grimjaw");
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

  it("resumePendingTransition no-ops when step is done", async () => {
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
    // Scene number should NOT have advanced
    expect(mgr.getScene().sceneNumber).toBe(1);
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

  it("nudges when scene is long and thread-heavy", () => {
    const scene = mockScene();
    // 8 player exchanges
    scene.transcript = [];
    for (let i = 0; i < 8; i++) {
      scene.transcript.push(`**[Aldric]** Action ${i}.`);
      scene.transcript.push(`**DM:** Response ${i}.`);
    }
    scene.openThreads = "[[a]], [[b]], [[c]]";
    const result = buildScenePacing(scene)!;
    expect(result).toContain("Exchanges: 8");
    expect(result).toContain("Open threads: 3");
    expect(result).toContain("Scene is long and thread-heavy");
  });

  it("nudges when scene is long even with few threads", () => {
    const scene = mockScene();
    scene.transcript = [];
    for (let i = 0; i < 10; i++) {
      scene.transcript.push(`**[Aldric]** Action ${i}.`);
      scene.transcript.push(`**DM:** Response ${i}.`);
    }
    scene.openThreads = "[[a]]";
    const result = buildScenePacing(scene)!;
    expect(result).toContain("Exchanges: 10");
    expect(result).toContain("running long");
  });

  it("nudges when many threads are open even in short scene", () => {
    const scene = mockScene();
    scene.transcript = [
      "**[Aldric]** I look around.",
      "**DM:** You see many things.",
    ];
    scene.openThreads = "[[a]], [[b]], [[c]], [[d]]";
    const result = buildScenePacing(scene)!;
    expect(result).toContain("Open threads: 4");
    expect(result).toContain("Many open threads");
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
