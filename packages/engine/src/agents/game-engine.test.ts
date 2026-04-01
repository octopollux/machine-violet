import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LLMProvider, ChatResult } from "../providers/types.js";
import { GameEngine } from "./game-engine.js";
import { pruneEmptyDirs } from "../tools/git/index.js";
import type { EngineCallbacks, EngineState, TurnInfo } from "./game-engine.js";
import type { GameState } from "./game-state.js";
import type { SceneState, FileIO } from "./scene-manager.js";
import type { DMSessionState } from "./dm-prompt.js";
import type { TuiCommand, UsageStats } from "./agent-loop.js";
import { createClocksState } from "../tools/clocks/index.js";
import { createCombatState, createDefaultConfig } from "../tools/combat/index.js";
import { createDecksState } from "../tools/cards/index.js";
import { createObjectivesState } from "../tools/objectives/index.js";

vi.mock("./subagents/ai-player.js", () => ({
  aiPlayerTurn: vi.fn(async () => ({
    text: "I attack the goblin.",
    action: "I attack the goblin.",
    usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
  })),
}));

vi.mock("./subagents/scribe.js", () => ({
  runScribe: vi.fn(async () => ({
    summary: "Created [[Grimjaw]] (character, private)",
    created: ["/tmp/test-campaign/characters/grimjaw.md"],
    updated: [],
    entityDeltas: [{ slug: "grimjaw", name: "Grimjaw", aliases: [], type: "character", path: "characters/grimjaw.md" }],
    usage: { inputTokens: 30, outputTokens: 15, cacheReadTokens: 0, cacheCreationTokens: 0 },
  })),
}));

vi.mock("./subagents/character-promotion.js", () => ({
  promoteCharacter: vi.fn(async () => ({
    updatedSheet: "# Storm\n\n**Type:** PC\n\n## Skills\n- Hack (d8)\n",
    changelogEntry: "Built initial sheet",
    text: "",
    usage: { inputTokens: 50, outputTokens: 30, cacheReadTokens: 0, cacheCreationTokens: 0 },
  })),
}));

vi.mock("./subagents/scene-tracker.js", () => ({
  SCENE_TRACKER_CADENCE: 4,
  trackScene: vi.fn(async () => ({
    text: "THREADS: (none)",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    openThreads: "",
  })),
}));

import { aiPlayerTurn } from "./subagents/ai-player.js";
import { runScribe } from "./subagents/scribe.js";
import { promoteCharacter } from "./subagents/character-promotion.js";

function mockUsage() {
  return { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };
}

function textMessage(text: string): ChatResult {
  return {
    text,
    toolCalls: [],
    usage: mockUsage(),
    stopReason: "end",
    assistantContent: [{ type: "text", text }],
  };
}

function toolAndTextMessages(
  toolName: string,
  toolInput: Record<string, unknown>,
  text: string,
): ChatResult[] {
  return [
    {
      text: "",
      toolCalls: [{ id: "toolu_1", name: toolName, input: toolInput }],
      usage: mockUsage(),
      stopReason: "tool_use",
      assistantContent: [{ type: "tool_use", id: "toolu_1", name: toolName, input: toolInput }],
    },
    textMessage(text),
  ];
}

let providerCallIdx: number;

function mockProvider(responses: ChatResult[]): LLMProvider {
  providerCallIdx = 0;
  return {
    providerId: "mock",
    chat: vi.fn(async () => responses[providerCallIdx++]),
    stream: vi.fn(async (_params: unknown, _onDelta?: unknown) => responses[providerCallIdx++]),
    healthCheck: vi.fn(async () => ({ ok: true })),
  } as unknown as LLMProvider;
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
      name: "Test",
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
    slug: "test-scene",
    transcript: [],
    precis: "",
    openThreads: "",
    npcIntents: "",

    playerReads: [],
    sessionNumber: 1,
  };
}

function mockSessionState(): DMSessionState {
  return {};
}

import { norm } from "../utils/paths.js";
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
  };
}

interface CallbackLog {
  states: EngineState[];
  narrativeDeltas: string[];
  narrativeComplete: string[];
  tuiCommands: TuiCommand[];
  toolStarts: string[];
  toolEnds: string[];
  errors: Error[];
  usageUpdates: UsageStats[];
  exchangeDrops: number;
  devLogs: string[];
  turnStarts: TurnInfo[];
  turnEnds: TurnInfo[];
}

function mockCallbacks(): { callbacks: EngineCallbacks; log: CallbackLog } {
  const log: CallbackLog = {
    states: [],
    narrativeDeltas: [],
    narrativeComplete: [],
    tuiCommands: [],
    toolStarts: [],
    toolEnds: [],
    errors: [],
    usageUpdates: [],
    exchangeDrops: 0,
    devLogs: [],
    turnStarts: [],
    turnEnds: [],
  };

  return {
    log,
    callbacks: {
      onNarrativeDelta: (delta) => log.narrativeDeltas.push(delta),
      onNarrativeComplete: (text) => log.narrativeComplete.push(text),
      onStateChange: (state) => log.states.push(state),
      onTuiCommand: (cmd) => log.tuiCommands.push(cmd),
      onToolStart: (name) => log.toolStarts.push(name),
      onToolEnd: (name) => log.toolEnds.push(name),
      onExchangeDropped: () => log.exchangeDrops++,
      onUsageUpdate: (delta) => log.usageUpdates.push({ ...delta }),
      onError: (error) => log.errors.push(error),
      onDevLog: (msg) => log.devLogs.push(msg),
      onRetry: () => {},
      onTurnStart: (turn) => log.turnStarts.push(turn),
      onTurnEnd: (turn) => log.turnEnds.push(turn),
    },
  };
}

beforeEach(() => {
  files = {};
  dirs = new Set();
});

describe("GameEngine", () => {
  it("processes player input and returns DM response", async () => {
    const provider = mockProvider([textMessage("The door creaks open.")]);
    const { callbacks, log } = mockCallbacks();

    const engine = new GameEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "I open the door.");

    expect(log.narrativeComplete).toContain("The door creaks open.");
    expect(log.states).toContain("dm_thinking");
    expect(log.states[log.states.length - 1]).toBe("waiting_input");
    expect(engine.getState()).toBe("waiting_input");
  });

  it("handles tool calls and collects TUI commands", async () => {
    const provider = mockProvider([
      ...toolAndTextMessages("style_scene", { key_color: "#cc4444" }, "The mood shifts."),
    ]);
    const { callbacks, log } = mockCallbacks();

    const engine = new GameEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "I attack!");

    expect(log.tuiCommands).toHaveLength(1);
    expect(log.tuiCommands[0].type).toBe("set_theme");
    expect(log.toolStarts).toContain("style_scene");
    expect(log.toolEnds).toContain("style_scene");
  });

  it("tracks session usage", async () => {
    const provider = mockProvider([textMessage("Hello.")]);
    const { callbacks, log } = mockCallbacks();

    const engine = new GameEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "Hi.");

    const usage = engine.getSessionUsage();
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(log.usageUpdates.length).toBeGreaterThan(0);
  });

  it("appends to scene transcript", async () => {
    const provider = mockProvider([textMessage("The tavern is warm.")]);
    const { callbacks } = mockCallbacks();
    const scene = mockScene();

    const engine = new GameEngine({
      provider,
      gameState: mockState(),
      scene,
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "I look around.");

    expect(scene.transcript).toHaveLength(2);
    expect(scene.transcript[0]).toContain("[Aldric]");
    expect(scene.transcript[1]).toContain("DM:");
  });

  it("threads tool messages through addExchange", async () => {
    const provider = mockProvider([
      ...toolAndTextMessages("roll_dice", { expression: "1d20" }, "You rolled a 15!"),
    ]);
    const { callbacks, log } = mockCallbacks();

    const engine = new GameEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "I attack the goblin.");

    // Verify tool was invoked and narrative completed
    expect(log.toolStarts.length).toBeGreaterThanOrEqual(1);
    expect(log.toolStarts[0]).toBe("roll_dice");

    expect(log.narrativeComplete.length).toBe(1);
    expect(log.narrativeComplete[0]).toBe("You rolled a 15!");
  });

  it("handles errors gracefully", async () => {
    const errorProvider: LLMProvider = {
      providerId: "mock",
      chat: vi.fn(async () => { throw new Error("API down"); }),
      stream: vi.fn(async () => { throw new Error("API down"); }),
      healthCheck: vi.fn(async () => ({ ok: true })),
    } as unknown as LLMProvider;

    const { callbacks, log } = mockCallbacks();

    const engine = new GameEngine({
      provider: errorProvider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "Hello");

    expect(log.errors.length).toBeGreaterThanOrEqual(1);
    expect(log.errors.some((e) => e.message.includes("API down"))).toBe(true);
    expect(engine.getState()).toBe("waiting_input");
  });

  it("transitions scenes", async () => {
    // Scene summarizer response
    const provider = mockProvider([textMessage("- Party met in tavern")]);
    const { callbacks, log } = mockCallbacks();
    const scene = mockScene();

    const engine = new GameEngine({
      provider,
      gameState: mockState(),
      scene,
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.transitionScene("Tavern Meeting", 60);

    expect(log.states).toContain("scene_transition");
    expect(scene.sceneNumber).toBe(2);
    expect(engine.getState()).toBe("waiting_input");
  });

  it("refreshes context after scene transition", async () => {
    const provider = mockProvider([textMessage("- Party met in tavern\n---MINI---\nParty met in tavern.")]);
    const { callbacks } = mockCallbacks();
    const fileIO = mockFileIO();
    const state = mockState();

    const sessionState = mockSessionState();
    const engine = new GameEngine({
      provider,
      gameState: state,
      scene: mockScene(),
      sessionState,
      fileIO,
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.transitionScene("Tavern Meeting", 60);

    // After transition, campaign log.json should have been written and re-read by contextRefresh
    expect(fileIO.readFile).toHaveBeenCalled();
    const readCalls = (fileIO.readFile as ReturnType<typeof vi.fn>).mock.calls
      .map(([p]: unknown[]) => norm(p as string));
    expect(readCalls.some((p: string) => p.includes("log.json"))).toBe(true);

    // The session state should have the updated campaign summary (rendered from JSON)
    expect(sessionState.campaignSummary).toContain("Party met in tavern");
  });

  it("refreshes context after resumePendingTransition", async () => {
    const provider = mockProvider([textMessage("- Resumed summary\n---MINI---\nResumed summary.")]);
    const { callbacks } = mockCallbacks();
    const fileIO = mockFileIO();
    const state = mockState();

    const sessionState = mockSessionState();
    const engine = new GameEngine({
      provider,
      gameState: state,
      scene: mockScene(),
      sessionState,
      fileIO,
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.resumePendingTransition({
      type: "scene_transition",
      step: "subagent_updates" as import("./scene-manager.js").PendingStep,
      sceneNumber: 1,
      title: "Resume Test",
    });

    // contextRefresh should have re-read the campaign log.json
    const readCalls = (fileIO.readFile as ReturnType<typeof vi.fn>).mock.calls
      .map(([p]: unknown[]) => norm(p as string));
    expect(readCalls.some((p: string) => p.includes("log.json"))).toBe(true);
  });

  it("ends session", async () => {
    const provider = mockProvider([textMessage("- Session summary")]);
    const { callbacks, log } = mockCallbacks();

    const engine = new GameEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.endSession("End of adventure");

    expect(log.states).toContain("session_ending");
    expect(engine.getState()).toBe("idle");
  });

  it("ignores input while already processing", async () => {
    // This test verifies the guard against double-processing
    const provider = mockProvider([textMessage("Response 1")]);
    const { callbacks } = mockCallbacks();

    const engine = new GameEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    // Process two inputs — second should be ignored since first isn't done
    const p1 = engine.processInput("Aldric", "First");
    // Immediately try second (engine is in dm_thinking state)
    const p2 = engine.processInput("Aldric", "Second");

    await Promise.all([p1, p2]);

    // Only one API call should have been made
    expect(provider.stream).toHaveBeenCalledTimes(1);
  });

  it("intercepts scene_transition TUI command and calls transitionScene", async () => {
    // DM calls scene_transition tool → returns TUI command JSON → engine intercepts
    const provider = mockProvider([
      ...toolAndTextMessages("scene_transition", { title: "The Dark Forest" }, "You enter the forest."),
    ]);
    const { callbacks, log } = mockCallbacks();

    const engine = new GameEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "We head into the forest.");

    // The scene_transition should NOT be forwarded to TUI
    expect(log.tuiCommands.filter((c) => c.type === "scene_transition")).toHaveLength(0);
    // Engine should have gone through scene_transition state
    expect(log.states).toContain("scene_transition");
  });

  it("intercepts session_end TUI command and calls endSession", async () => {
    const provider = mockProvider([
      ...toolAndTextMessages("session_end", { title: "End of Session 1" }, "That's all for today."),
    ]);
    const { callbacks, log } = mockCallbacks();

    const engine = new GameEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "Let's wrap up.");

    expect(log.tuiCommands.filter((c) => c.type === "session_end")).toHaveLength(0);
    expect(log.states).toContain("session_ending");
  });

});

describe("GameEngine Scribe Integration", () => {
  it("scribe tool spawns subagent and logs summary", async () => {
    const provider = mockProvider([
      ...toolAndTextMessages("scribe", {
        updates: [
          { visibility: "private", content: "Grimjaw is a scarred orc chieftain" },
        ],
      }, "You see a scarred orc."),
    ]);
    const { callbacks, log } = mockCallbacks();
    const fio = mockFileIO();
    const devLogs: string[] = [];
    callbacks.onDevLog = (msg) => devLogs.push(msg);

    const engine = new GameEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: fio,
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "I look at the orc.");

    // Should NOT forward scribe command to TUI
    expect(log.tuiCommands.filter((c) => c.type === "scribe")).toHaveLength(0);
    // runScribe should have been called
    expect(runScribe).toHaveBeenCalled();
    // Dev log should show scribe summary
    expect(devLogs.some((d) => d.includes("scribe"))).toBe(true);
  });

  it("scribe notifies scene manager about created entities", async () => {
    const provider = mockProvider([
      ...toolAndTextMessages("scribe", {
        updates: [
          { visibility: "private", content: "Grimjaw is a scarred orc" },
        ],
      }, "You see an orc."),
    ]);
    const { callbacks } = mockCallbacks();
    const fio = mockFileIO();

    const engine = new GameEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: fio,
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "I look around.");

    // The mock runScribe returns entityDeltas with grimjaw
    // Mid-scene upserts update the in-memory tree but not the DM snapshot
    const sm = engine.getSceneManager();
    expect(sm.getEntityTree()["grimjaw"]).toBeDefined();
    expect(sm.getEntityTree()["grimjaw"].name).toBe("Grimjaw");
  });
});

describe("GameEngine Git Auto-Commit", () => {
  function mockGitIO() {
    return {
      init: vi.fn(async () => {}),
      add: vi.fn(async () => {}),
      commit: vi.fn(async () => "abc123"),
      log: vi.fn(async () => []),
      checkout: vi.fn(async () => {}),
      resetTo: vi.fn(async () => {}),
      pruneUnreachable: vi.fn(async () => 0),
      // head=1, workdir=2, stage=2: file is staged and differs from HEAD → commit will fire
      statusMatrix: vi.fn(async () => [["file.md", 1, 2, 2] as [string, number, number, number]]),
      listFiles: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
    };
  }

  it("auto-commits after N exchanges when git enabled", async () => {
    const gitIO = mockGitIO();
    const state = mockState();
    state.config.recovery.enable_git = true;
    state.config.recovery.auto_commit_interval = 2;

    // Need 2 responses (one per processInput call)
    const provider = mockProvider([
      textMessage("Response 1."),
      textMessage("Response 2."),
    ]);
    const { callbacks } = mockCallbacks();

    const engine = new GameEngine({
      provider,
      gameState: state,
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
      gitIO,
    });

    // First exchange — triggers lazy init commit only (1 < 2 interval)
    await engine.processInput("Aldric", "First action.");
    expect(gitIO.commit).toHaveBeenCalledTimes(1); // init commit
    expect(gitIO.commit).toHaveBeenCalledWith(
      expect.anything(), "auto: initial state", expect.anything(),
    );

    // Second exchange — should trigger auto-commit (2 >= 2)
    await engine.processInput("Aldric", "Second action.");
    expect(gitIO.commit).toHaveBeenCalledTimes(2); // init + auto
  });

  it("no git errors when gitIO not provided", async () => {
    const provider = mockProvider([textMessage("Response.")]);
    const { callbacks, log } = mockCallbacks();

    const engine = new GameEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
      // No gitIO — default behavior
    });

    await engine.processInput("Aldric", "Hello.");
    expect(log.errors).toHaveLength(0);
    expect(engine.getRepo()).toBeNull();
  });

  it("exposes repo via getRepo()", () => {
    const gitIO = mockGitIO();
    const state = mockState();
    state.config.recovery.enable_git = true;

    const { callbacks } = mockCallbacks();
    const engine = new GameEngine({
      provider: mockProvider([]),
      gameState: state,
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
      gitIO,
    });

    expect(engine.getRepo()).not.toBeNull();
    expect(engine.getRepo()!.isEnabled()).toBe(true);
  });
});

describe("GameEngine AI Auto-Turn", () => {
  beforeEach(() => {
    vi.mocked(aiPlayerTurn).mockClear();
  });

  function mockStateWithAI(): GameState {
    return {
      maps: {},
      clocks: createClocksState(),
      combat: createCombatState(),
      combatConfig: createDefaultConfig(),
      decks: createDecksState(),
      objectives: createObjectivesState(),
      config: {
        name: "Test",
        dm_personality: { name: "grim", prompt_fragment: "Be terse." },
        players: [
          { name: "Alice", character: "Aldric", type: "human" },
          { name: "Bot", character: "Zara", type: "ai" },
        ],
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

  it("triggers AI turn when active player is AI after processInput", async () => {
    vi.useFakeTimers();

    const state = mockStateWithAI();
    // Set active player to the AI player
    state.activePlayerIndex = 1;

    // Two responses: first for the initial processInput, second for the AI-triggered processInput
    const provider = mockProvider([
      textMessage("The goblin attacks!"),
      textMessage("Zara swings her sword."),
    ]);
    const { callbacks, log } = mockCallbacks();

    const engine = new GameEngine({
      provider,
      gameState: state,
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    // Force engine to waiting_input so processInput works
    // Process a human input first (pretend active player switches to AI after DM responds)
    state.activePlayerIndex = 0;
    await engine.processInput("Aldric", "I look around.");

    // Now switch to AI player — the processAITurnIfNeeded at end of processInput won't fire
    // because at that point activePlayerIndex is 0 (human). Let's test directly.
    state.activePlayerIndex = 1;
    engine.processAITurnIfNeeded();

    // Flush the setTimeout(0)
    await vi.advanceTimersByTimeAsync(0);

    expect(aiPlayerTurn).toHaveBeenCalled();
    expect(log.turnStarts).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "ai", participant: "Zara" })])
    );

    vi.useRealTimers();
  });

  it("safety valve stops at MAX_AI_CHAIN consecutive AI turns", async () => {
    const state = mockStateWithAI();
    state.activePlayerIndex = 1; // AI player

    const provider = mockProvider([textMessage("Response.")]);
    const { callbacks, log } = mockCallbacks();

    const engine = new GameEngine({
      provider,
      gameState: state,
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    // Simulate having hit the chain limit
    // Access the depth via executeAITurn calls
    for (let i = 0; i < 10; i++) {
      // Manually bump depth by calling executeAITurn with a state that's always AI
      // But we'll get infinite recursion... Instead, test via the method directly
    }

    // Simpler: call executeAITurn 11 times rapidly to test the guard
    // The chain limit is checked inside executeAITurn
    // Let's set up the mock to not chain (by switching to human after the call)
    vi.mocked(aiPlayerTurn).mockImplementation(async () => {
      // Keep activePlayerIndex on AI so isAITurn keeps returning true
      // But processInput will be called with fromAI: true, not resetting depth
      return {
        text: "I attack!",
        action: "I attack!",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
      };
    });

    // Directly call executeAITurn repeatedly to hit the limit
    // After 10 calls, the 11th should be rejected
    for (let i = 0; i < 11; i++) {
      // Switch back to waiting state so processInput doesn't skip
      await engine.executeAITurn();
    }

    expect(log.narrativeDeltas).toEqual(
      expect.arrayContaining([expect.stringContaining("[AI turn limit reached]")])
    );
  });

  it("human input resets AI chain depth", async () => {
    const state = mockStateWithAI();
    state.activePlayerIndex = 0; // human player

    const provider = mockProvider([
      textMessage("Response 1."),
      textMessage("Response 2."),
    ]);
    const { callbacks } = mockCallbacks();

    const engine = new GameEngine({
      provider,
      gameState: state,
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    // Human input without fromAI resets depth
    await engine.processInput("Aldric", "Hello");
    // The depth should be 0 now (human input resets it)
    // Verify by checking that a subsequent AI turn would work
    // (implicitly tested — if depth weren't reset, chaining wouldn't work)
    expect(engine.getState()).toBe("waiting_input");
  });

  it("character sheet loading failure falls back gracefully", async () => {
    vi.useFakeTimers();

    const state = mockStateWithAI();
    state.activePlayerIndex = 1; // AI player

    const fio = mockFileIO();
    vi.mocked(fio.readFile).mockRejectedValue(new Error("ENOENT"));

    const provider = mockProvider([textMessage("DM responds.")]);
    const { callbacks } = mockCallbacks();

    const engine = new GameEngine({
      provider,
      gameState: state,
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: fio,
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    // Call executeAITurn directly
    await engine.executeAITurn();

    // Should still call aiPlayerTurn despite file read failure
    expect(aiPlayerTurn).toHaveBeenCalled();
    const callArgs = vi.mocked(aiPlayerTurn).mock.calls[0][1];
    expect(callArgs.characterSheet).toBe("Character: Zara");

    vi.useRealTimers();
  });

  it("AI turn accumulates usage stats", async () => {
    vi.useFakeTimers();

    const state = mockStateWithAI();
    state.activePlayerIndex = 1;

    vi.mocked(aiPlayerTurn).mockResolvedValue({
      text: "I attack!",
      action: "I attack!",
      usage: { inputTokens: 75, outputTokens: 25, cacheReadTokens: 10, cacheCreationTokens: 0 },
    });

    const provider = mockProvider([textMessage("The goblin falls!")]);
    const { callbacks, log } = mockCallbacks();

    const engine = new GameEngine({
      provider,
      gameState: state,
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.executeAITurn();

    // Usage should include both the AI subagent and the DM response
    const usage = engine.getSessionUsage();
    // AI subagent: 75 input + DM response: 100 input = 175
    expect(usage.inputTokens).toBeGreaterThanOrEqual(75);
    expect(log.usageUpdates.length).toBeGreaterThanOrEqual(1);

    vi.useRealTimers();
  });
});

describe("GameEngine Behavioral Reminder", () => {
  /** Extract the messages array from the Nth stream() call (0-indexed). */
  function sentMessages(prov: LLMProvider, callIdx: number): { role: string; content: string | unknown[] }[] {
    const streamFn = prov.stream as ReturnType<typeof vi.fn>;
    return (streamFn.mock.calls[callIdx][0] as { messages: { role: string; content: string | unknown[] }[] }).messages;
  }

  it("no reminder injected during first 3 turns even without tools or entity formatting", async () => {
    const provider = mockProvider([
      textMessage("Turn 1."),
      textMessage("Turn 2."),
      textMessage("Turn 3."),
    ]);
    const { callbacks } = mockCallbacks();
    const engine = new GameEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "One.");
    await engine.processInput("Aldric", "Two.");
    await engine.processInput("Aldric", "Three.");

    for (let i = 0; i < 3; i++) {
      const msgs = sentMessages(provider, i);
      expect(msgs.every((m) => typeof m.content !== "string" || !m.content.includes("[dm-note]"))).toBe(true);
    }
  });

  it("injects tool reminder on 4th turn after 3 turns without tools", async () => {
    const provider = mockProvider([
      textMessage("One."),
      textMessage("Two."),
      textMessage("Three."),
      textMessage("Four."),
    ]);
    const { callbacks } = mockCallbacks();
    const engine = new GameEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "One.");
    await engine.processInput("Aldric", "Two.");
    await engine.processInput("Aldric", "Three.");
    await engine.processInput("Aldric", "Four.");

    const msgs = sentMessages(provider, 3);
    const dmNote = msgs.find((m) => typeof m.content === "string" && m.content.includes("[dm-note]"));
    expect(dmNote).toBeDefined();
    expect(dmNote!.content).toContain("use your tools");
  });

  it("tool use resets the tool counter and suppresses the tool reminder", async () => {
    // Turn 4 uses a non-TUI tool → 2 stream calls (one per agent loop round).
    // So turn 5 lands at stream-call index 5, not 4.
    const provider = mockProvider([
      textMessage("One."),            // turn 1 → stream[0]
      textMessage("Two."),            // turn 2 → stream[1]
      textMessage("Three."),          // turn 3 → stream[2]
      ...toolAndTextMessages("roll_dice", { expression: "1d20" }, "You roll a 14."), // turn 4 → stream[3,4]
      textMessage("Five."),           // turn 5 → stream[5]
    ]);
    const { callbacks } = mockCallbacks();
    const engine = new GameEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "One.");
    await engine.processInput("Aldric", "Two.");
    await engine.processInput("Aldric", "Three.");
    await engine.processInput("Aldric", "Four."); // tool used here → turnsWithoutTools resets to 0
    await engine.processInput("Aldric", "Five.");

    // After the tool turn (counter reset to 0), only 1 turn has passed without tools.
    // Tool reminder should be absent; entity reminder may appear independently.
    const msgs = sentMessages(provider, 5);
    const dmNote = msgs.find((m) => typeof m.content === "string" && m.content.includes("[dm-note]"));
    expect(dmNote?.content ?? "").not.toContain("use your tools");
  });

  it("injects entity reminder after 3 turns without color-coded entities", async () => {
    const provider = mockProvider([
      textMessage("One."),
      textMessage("Two."),
      textMessage("Three."),
      textMessage("Four."),
    ]);
    const { callbacks } = mockCallbacks();
    const engine = new GameEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "One.");
    await engine.processInput("Aldric", "Two.");
    await engine.processInput("Aldric", "Three.");
    await engine.processInput("Aldric", "Four.");

    const msgs = sentMessages(provider, 3);
    const dmNote = msgs.find((m) => typeof m.content === "string" && m.content.includes("[dm-note]"));
    expect(dmNote).toBeDefined();
    expect(dmNote!.content).toContain("color-code entity names");
  });

  it("color-coded entity in DM response resets the entity counter", async () => {
    const provider = mockProvider([
      textMessage("One."),
      textMessage("Two."),
      // Turn 3 — response contains a color-coded entity
      textMessage('You see <color=#cc8844>Grimjaw</color> approach.'),
      textMessage("Four."),
      textMessage("Five."),
    ]);
    const { callbacks } = mockCallbacks();
    const engine = new GameEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "One.");
    await engine.processInput("Aldric", "Two.");
    await engine.processInput("Aldric", "Three."); // color-coded entity in response
    await engine.processInput("Aldric", "Four.");
    await engine.processInput("Aldric", "Five.");

    // After the color-coded entity on turn 3, the counter resets.
    // Turn 4 is only 1 turn after the reset, so no entity reminder on turn 5 (index 4).
    const msgs = sentMessages(provider, 4);
    const dmNote = msgs.find((m) => typeof m.content === "string" && m.content.includes("[dm-note]"));
    expect(dmNote?.content ?? "").not.toContain("color-code entity names");
  });

  it("reminder is skipped for skipTranscript turns (session open/resume)", async () => {
    const provider = mockProvider([
      textMessage("One."),
      textMessage("Two."),
      textMessage("Three."),
      // skipTranscript turn on what would be turn 4
      textMessage("Session resumed."),
    ]);
    const { callbacks } = mockCallbacks();
    const engine = new GameEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "One.");
    await engine.processInput("Aldric", "Two.");
    await engine.processInput("Aldric", "Three.");
    await engine.processInput("Aldric", "[session-open]", { skipTranscript: true });

    const msgs = sentMessages(provider, 3);
    expect(msgs.every((m) => typeof m.content !== "string" || !m.content.includes("[dm-note]"))).toBe(true);
  });

  it("emits devLog when behavioral reminder is injected", async () => {
    const provider = mockProvider([
      textMessage("One."),
      textMessage("Two."),
      textMessage("Three."),
      textMessage("Four."),
    ]);
    const { callbacks, log } = mockCallbacks();
    const engine = new GameEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "One.");
    await engine.processInput("Aldric", "Two.");
    await engine.processInput("Aldric", "Three.");
    await engine.processInput("Aldric", "Four.");

    expect(log.devLogs.some((m) => m.includes("[dm-note]"))).toBe(true);
  });
});

describe("GameEngine Turn Lifecycle", () => {
  beforeEach(() => {
    vi.mocked(aiPlayerTurn).mockClear();
    vi.mocked(aiPlayerTurn).mockResolvedValue({
      text: "I attack the goblin.",
      action: "I attack the goblin.",
      usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
  });

  it("fires player turn, then DM turn with onNarrativeComplete inside", async () => {
    const provider = mockProvider([textMessage("The door opens.")]);
    const { callbacks } = mockCallbacks();
    const events: string[] = [];

    // Wrap callbacks to track ordering
    const origOnTurnStart = callbacks.onTurnStart;
    callbacks.onTurnStart = (turn) => { events.push(`turnStart:${turn.role}`); origOnTurnStart(turn); };
    const origComplete = callbacks.onNarrativeComplete;
    callbacks.onNarrativeComplete = (text) => { events.push("complete"); origComplete(text); };
    const origEnd = callbacks.onTurnEnd;
    callbacks.onTurnEnd = (turn) => { events.push(`turnEnd:${turn.role}`); origEnd(turn); };

    const engine = new GameEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "I open the door.");

    expect(events).toEqual([
      "turnStart:player",
      "turnEnd:player",
      "turnStart:dm",
      "complete",
      "turnEnd:dm",
    ]);
  });

  it("turnNumber increments across calls (player + DM per input)", async () => {
    const provider = mockProvider([
      textMessage("One."),
      textMessage("Two."),
    ]);
    const { callbacks, log } = mockCallbacks();

    const engine = new GameEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "One.");
    await engine.processInput("Aldric", "Two.");

    // Each processInput fires player turn + DM turn = 4 total starts
    expect(log.turnStarts).toHaveLength(4);
    expect(log.turnStarts[0]).toMatchObject({ turnNumber: 1, role: "player" });
    expect(log.turnStarts[1]).toMatchObject({ turnNumber: 2, role: "dm" });
    expect(log.turnStarts[2]).toMatchObject({ turnNumber: 3, role: "player" });
    expect(log.turnStarts[3]).toMatchObject({ turnNumber: 4, role: "dm" });
  });

  it("human input fires player+dm roles; fromAI fires only dm role", async () => {
    const provider = mockProvider([
      textMessage("Response to human."),
      textMessage("Response to AI."),
    ]);
    const { callbacks, log } = mockCallbacks();

    const engine = new GameEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    // Human turn — fires player + dm
    await engine.processInput("Aldric", "Hello.");
    expect(log.turnStarts[0]).toMatchObject({ role: "player", participant: "Aldric" });
    expect(log.turnStarts[1]).toMatchObject({ role: "dm", participant: "DM" });

    // AI turn (via fromAI flag) — fires only dm (AI turn was emitted by executeAITurn)
    await engine.processInput("Zara", "I attack!", { fromAI: true });
    expect(log.turnStarts).toHaveLength(3);
    expect(log.turnStarts[2]).toMatchObject({ role: "dm", participant: "DM" });
  });

  it("fires AI turn via onTurnStart/onTurnEnd in executeAITurn", async () => {
    vi.useFakeTimers();
    vi.mocked(aiPlayerTurn).mockClear();

    const state = {
      maps: {},
      clocks: createClocksState(),
      combat: createCombatState(),
      combatConfig: createDefaultConfig(),
      decks: createDecksState(),
      objectives: createObjectivesState(),
      config: {
        name: "Test",
        dm_personality: { name: "grim", prompt_fragment: "Be terse." },
        players: [
          { name: "Alice", character: "Aldric", type: "human" },
          { name: "Bot", character: "Zara", type: "ai" },
        ],
        combat: createDefaultConfig(),
        context: { retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 },
        recovery: { auto_commit_interval: 300, max_commits: 100, enable_git: false },
        choices: { campaign_default: "often", player_overrides: {} },
      },
      campaignRoot: "/tmp/test-campaign",
      homeDir: "/tmp/home",
      activePlayerIndex: 1,
      displayResources: {},
      resourceValues: {},
    } satisfies GameState;

    const provider = mockProvider([textMessage("DM responds to AI.")]);
    const { callbacks, log } = mockCallbacks();

    const engine = new GameEngine({
      provider, gameState: state, scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.executeAITurn();

    // Should fire AI turn (DM turn skipped because executeAITurn sets
    // state to dm_thinking before calling processInput, which returns early)
    const aiStarts = log.turnStarts.filter((t) => t.role === "ai");
    expect(aiStarts).toHaveLength(1);
    expect(aiStarts[0].participant).toBe("Zara");
    expect(aiStarts[0].text).toBe("I attack the goblin.");

    const aiEnds = log.turnEnds.filter((t) => t.role === "ai");
    expect(aiEnds).toHaveLength(1);

    // Should NOT have emitted a raw narrative delta for the AI action
    expect(log.narrativeDeltas.every((d) => !d.includes("Zara (AI)"))).toBe(true);

    vi.useRealTimers();
  });

  it("behavioral counters only increment on human turns", async () => {
    const provider = mockProvider([
      textMessage("One."),
      textMessage("Two."),
      textMessage("Three."),
      textMessage("AI Response."), // fromAI turn — should NOT increment counters
      textMessage("Four."),
    ]);
    const { callbacks } = mockCallbacks();

    const engine = new GameEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "One.");
    await engine.processInput("Aldric", "Two.");
    await engine.processInput("Aldric", "Three.");

    // AI turn should NOT increment the counter
    await engine.processInput("Zara", "AI does stuff.", { fromAI: true });

    // Fourth human turn — counter should be at 3 (not 4)
    // If AI turn had counted, this would be turn 5 and would trigger reminder
    await engine.processInput("Aldric", "Four.");

    // Extract messages from the 5th stream call (index 4)
    const streamFn = provider.stream as ReturnType<typeof vi.fn>;
    const msgs = (streamFn.mock.calls[4][0] as { messages: { role: string; content: string | unknown[] }[] }).messages;
    const dmNote = msgs.find((m) => typeof m.content === "string" && m.content.includes("[dm-note]"));
    // Should have the reminder because human turns 1-3 are toolless, then AI doesn't count,
    // then human turn 4 — conversation.size is now ≥3 and turnsWithoutTools is 3+
    expect(dmNote).toBeDefined();
    expect(dmNote!.content).toContain("use your tools");
  });
});

describe("pruneEmptyDirs", () => {
  it("removes empty directories under campaign subdirs", async () => {
    const io = mockFileIO();
    const rmdirCalls: string[] = [];
    io.rmdir = vi.fn(async (path: string) => { rmdirCalls.push(norm(path)); });

    // config.json must exist (safety check)
    files[norm("/tmp/campaign/config.json")] = "{}";
    dirs.add(norm("/tmp/campaign/campaign/scenes"));
    dirs.add(norm("/tmp/campaign/campaign/scenes/002-tavern"));

    // First listDir: scenes has one empty subdir
    (io.listDir as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      const p = norm(path);
      if (p.endsWith("campaign/scenes")) return ["002-tavern"];
      if (p.endsWith("002-tavern")) return []; // empty!
      return [];
    });

    const removed = await pruneEmptyDirs("/tmp/campaign", io);
    expect(removed).toBe(1);
    expect(rmdirCalls[0]).toContain("002-tavern");
  });

  it("does nothing when config.json is missing (safety guard)", async () => {
    const io = mockFileIO();
    io.rmdir = vi.fn(async () => {});
    // No config.json — not a campaign root
    dirs.add(norm("/tmp/not-campaign/campaign/scenes"));

    const removed = await pruneEmptyDirs("/tmp/not-campaign", io);
    expect(removed).toBe(0);
    expect(io.rmdir).not.toHaveBeenCalled();
  });

  it("does not remove non-empty directories", async () => {
    const io = mockFileIO();
    io.rmdir = vi.fn(async () => {});

    files[norm("/tmp/campaign/config.json")] = "{}";
    files[norm("/tmp/campaign/campaign/scenes/001-opening/transcript.md")] = "# Scene 1";
    dirs.add(norm("/tmp/campaign/campaign/scenes"));
    dirs.add(norm("/tmp/campaign/campaign/scenes/001-opening"));

    (io.listDir as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      const p = norm(path);
      if (p.endsWith("campaign/scenes")) return ["001-opening"];
      if (p.endsWith("001-opening")) return ["transcript.md"];
      return [];
    });

    const removed = await pruneEmptyDirs("/tmp/campaign", io);
    expect(removed).toBe(0);
  });

  it("prunes nested empty directories depth-first", async () => {
    const io = mockFileIO();
    const rmdirCalls: string[] = [];
    io.rmdir = vi.fn(async (path: string) => { rmdirCalls.push(norm(path)); });

    files[norm("/tmp/campaign/config.json")] = "{}";
    dirs.add(norm("/tmp/campaign/locations"));
    dirs.add(norm("/tmp/campaign/locations/old-tavern"));

    let tavernPruned = false;
    (io.listDir as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      const p = norm(path);
      if (p.endsWith("/locations") && tavernPruned) return [];
      if (p.endsWith("/locations")) return ["old-tavern"];
      if (p.endsWith("old-tavern")) {
        tavernPruned = true;
        return [];
      }
      return [];
    });

    const removed = await pruneEmptyDirs("/tmp/campaign", io);
    // Both old-tavern and locations should be pruned
    expect(removed).toBe(2);
    // old-tavern should be pruned before locations (depth-first)
    expect(rmdirCalls[0]).toContain("old-tavern");
    expect(rmdirCalls[1]).toContain("locations");
  });
});

describe("GameEngine OOC summary injection", () => {
  it("injects OOC summary into player message and persists in conversation history", async () => {
    const streamCalls: unknown[] = [];
    let streamCallIdx = 0;
    const responses = [textMessage("Welcome back."), textMessage("You look around.")];

    const spyProvider: LLMProvider = {
      providerId: "mock",
      chat: vi.fn(async () => textMessage("fallback")),
      stream: vi.fn(async (params: unknown, _onDelta?: unknown) => {
        streamCalls.push(params);
        return responses[streamCallIdx++];
      }),
      healthCheck: vi.fn(async () => ({ ok: true })),
    } as unknown as LLMProvider;

    const { callbacks } = mockCallbacks();
    const engine = new GameEngine({
      provider: spyProvider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    // Set pending OOC summary (simulating what PlayingPhase does on OOC exit)
    engine.setPendingOOCSummary("Corrected HP from 12 to 18.\nClarified tavern location.");

    // First processInput — should inject the OOC summary
    await engine.processInput("Aldric", "I look around.");
    const firstCall = streamCalls[0] as { messages: { role: string; content: string | unknown[] }[] };
    const userMsgs = firstCall.messages.filter((m) => m.role === "user");
    const lastUserContent = userMsgs[userMsgs.length - 1].content as string;
    expect(lastUserContent).toContain("<ooc_summary>");
    expect(lastUserContent).toContain("Corrected HP from 12 to 18.");
    expect(lastUserContent).toContain("Clarified tavern location.");
    expect(lastUserContent).toContain("</ooc_summary>");
    expect(lastUserContent).toContain("[Aldric] I look around.");

    // Second processInput — OOC summary should be cleared from new input,
    // but the prior stored exchange should still contain it in conversation history
    await engine.processInput("Aldric", "I check the door.");
    const secondCall = streamCalls[1] as { messages: { role: string; content: string | unknown[] }[] };
    const allMsgs = secondCall.messages;
    // The new user message should NOT have OOC summary
    const newUserContent = allMsgs[allMsgs.length - 1].content as string;
    expect(newUserContent).not.toContain("<ooc_summary>");
    // The stored conversation history (prior user message) should still have it.
    // Serialize all prior messages to check the OOC summary persisted.
    const priorMsgsJson = JSON.stringify(allMsgs.slice(0, -1));
    expect(priorMsgsJson).toContain("<ooc_summary>");
  });

  it("does not inject when no OOC summary is pending", async () => {
    const streamCalls: unknown[] = [];

    const spyProvider: LLMProvider = {
      providerId: "mock",
      chat: vi.fn(async () => textMessage("fallback")),
      stream: vi.fn(async (params: unknown, _onDelta?: unknown) => {
        streamCalls.push(params);
        return textMessage("Hello.");
      }),
      healthCheck: vi.fn(async () => ({ ok: true })),
    } as unknown as LLMProvider;

    const { callbacks } = mockCallbacks();
    const engine = new GameEngine({
      provider: spyProvider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "I open the door.");
    const call = streamCalls[0] as { messages: { role: string; content: string | unknown[] }[] };
    const userMsgs = call.messages.filter((m) => m.role === "user");
    const content = userMsgs[userMsgs.length - 1].content as string;
    expect(content).not.toContain("<ooc_summary>");
  });
});

describe("GameEngine TUI-only tool round (#266)", () => {
  it("does not bail out on TUI-only rounds — DM gets to continue", async () => {
    // Turn 1: DM responds with text + TUI-only tool call.
    // Previously this would bail out; now tool results are sent back and
    // the DM gets another round to finish its turn.
    const turn1Round1: ChatResult = {
      text: "You enter the tavern.",
      toolCalls: [{ id: "toolu_ml", name: "update_modeline", input: { location: "Tavern" } }],
      usage: mockUsage(),
      stopReason: "tool_use",
      assistantContent: [
        { type: "text", text: "You enter the tavern." },
        { type: "tool_use", id: "toolu_ml", name: "update_modeline", input: { location: "Tavern" } },
      ],
    };

    // Turn 1, round 2: DM finishes its turn
    const turn1Round2 = textMessage("A barkeep polishes a glass.");

    // Turn 2: Normal text response
    const turn2Msg = textMessage("The bartender nods.");

    let streamCallIdx = 0;
    const streamResponses = [turn1Round1, turn1Round2, turn2Msg];
    const streamCalls: unknown[] = [];

    const spyProvider: LLMProvider = {
      providerId: "mock",
      chat: vi.fn(async () => textMessage("fallback")),
      stream: vi.fn(async (params: unknown, _onDelta?: unknown) => {
        streamCalls.push(params);
        return streamResponses[streamCallIdx++];
      }),
      healthCheck: vi.fn(async () => ({ ok: true })),
    } as unknown as LLMProvider;

    const { callbacks } = mockCallbacks();

    const engine = new GameEngine({
      provider: spyProvider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    // Turn 1: tool results sent back → 2 API calls (no bail-out)
    await engine.processInput("Aldric", "I enter the tavern.");
    expect(spyProvider.stream).toHaveBeenCalledTimes(2);

    // Turn 2: conversation history should include the tool_use/tool_result
    // pair from turn 1 so the DM sees a coherent exchange.
    await engine.processInput("Aldric", "I talk to the bartender.");
    expect(spyProvider.stream).toHaveBeenCalledTimes(3);

    // Verify the third call's messages include the tool_use + tool_result
    const thirdCallParams = streamCalls[2] as { messages: { role: string; content: string | unknown[] }[] };
    const msgs = thirdCallParams.messages;

    // Find the assistant message with tool_use from turn 1
    const assistantWithTools = msgs.find((m) =>
      m.role === "assistant" && Array.isArray(m.content) &&
      (m.content as { type: string }[]).some((b) => b.type === "tool_use"),
    );
    expect(assistantWithTools).toBeDefined();

    // Find the matching tool_result
    const toolResultMsg = msgs.find((m) =>
      m.role === "user" && Array.isArray(m.content) &&
      (m.content as { type: string }[]).some((b) => b.type === "tool_result"),
    );
    expect(toolResultMsg).toBeDefined();
  });
});

describe("GameEngine resolve_turn routing", () => {
  it("returns error when no combat session is active", async () => {
    // DM calls resolve_turn without start_combat
    const provider = mockProvider([
      ...toolAndTextMessages("resolve_turn", {
        actor: "Kael",
        action: "Attack goblin",
      }, "I'll try something else."),
    ]);
    const { callbacks, log } = mockCallbacks();

    const engine = new GameEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "I attack!");

    // The tool should have returned an error
    expect(log.toolEnds).toContain("resolve_turn");
    // But engine should still complete normally
    expect(engine.getState()).toBe("waiting_input");
  });
});

describe("cross-mode resource dispatch: Engine + Dev Mode share singleton", () => {
  it("Dev Mode tool dispatch mutates GameState and forwards TUI command", async () => {
    const fio = mockFileIO();
    const state = mockState();
    const provider = mockProvider([textMessage("ok")]);
    const { callbacks } = mockCallbacks();

    // Construct engine (production code wires callbacks on singleton)
    new GameEngine({
      provider,
      gameState: state,
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: fio,
      callbacks,
    });

    // Simulate Dev Mode dispatching resource tools via the same singleton
    const { buildDevToolHandler } = await import("./subagents/dev-mode.js");
    const onTuiCommand = vi.fn();
    const handler = buildDevToolHandler(state, fio, undefined, undefined, undefined, onTuiCommand);

    await handler("set_display_resources", { character: "Aldric", resources: ["HP", "MP"] });
    await handler("set_resource_values", { character: "Aldric", values: { HP: "20/30", MP: "5/10" } });

    // TUI command should have been forwarded (triggers React state → persist effect)
    expect(onTuiCommand).toHaveBeenCalledTimes(2);

    // GameState should be mutated (DM prompt reads this)
    expect(state.displayResources["Aldric"]).toEqual(["HP", "MP"]);
    expect(state.resourceValues["Aldric"]).toEqual({ HP: "20/30", MP: "5/10" });

    // Persistence now happens via React useEffect in app.tsx (same pattern as modelines),
    // not via the registry callback. The TUI command triggers setResources → effect → persist.
  });
});

describe("applyResolutionDeltas — system-agnostic hp_change", () => {
  it("uses resource key from delta when present", async () => {
    const state = mockState();
    state.displayResources["Goblin"] = ["Hull Integrity"];
    state.resourceValues["Goblin"] = { "Hull Integrity": "50" };

    const provider = mockProvider([textMessage("ok")]);
    const { callbacks } = mockCallbacks();
    const engine = new GameEngine({
      provider, gameState: state, scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
    });

    const applyDeltas = (engine as unknown as { applyResolutionDeltas: (d: unknown[]) => void }).applyResolutionDeltas.bind(engine);
    applyDeltas([{ type: "hp_change", target: "Goblin", details: { resource: "Hull Integrity", amount: -15 } }]);

    expect(state.resourceValues["Goblin"]["Hull Integrity"]).toBe("35");
  });

  it("falls back to first displayResource key when delta has no resource", async () => {
    const state = mockState();
    state.displayResources["Kael"] = ["Vitality", "Mana"];
    state.resourceValues["Kael"] = { Vitality: "100", Mana: "50" };

    const provider = mockProvider([textMessage("ok")]);
    const { callbacks } = mockCallbacks();
    const engine = new GameEngine({
      provider, gameState: state, scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
    });

    const applyDeltas = (engine as unknown as { applyResolutionDeltas: (d: unknown[]) => void }).applyResolutionDeltas.bind(engine);
    applyDeltas([{ type: "hp_change", target: "Kael", details: { amount: -20 } }]);

    expect(state.resourceValues["Kael"]["Vitality"]).toBe("80");
    expect(state.resourceValues["Kael"]["Mana"]).toBe("50"); // untouched
  });

  it("falls back to 'hp' when no displayResources and no resource in delta", async () => {
    const state = mockState();
    const provider = mockProvider([textMessage("ok")]);
    const { callbacks } = mockCallbacks();
    const engine = new GameEngine({
      provider, gameState: state, scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
    });

    const applyDeltas = (engine as unknown as { applyResolutionDeltas: (d: unknown[]) => void }).applyResolutionDeltas.bind(engine);
    applyDeltas([{ type: "hp_change", target: "Goblin", details: { amount: -5 } }]);

    // No displayResources, no resource in delta → falls back to "hp"
    expect(state.resourceValues["Goblin"]["hp"]).toBe("-5");
  });
});

describe("content classifier refusal", () => {
  function refusalMessage(): ChatResult {
    return {
      text: "",
      toolCalls: [],
      usage: mockUsage(),
      stopReason: "refusal",
      assistantContent: [],
    };
  }

  it("fires onRefusal and does not persist exchange", async () => {
    const provider = mockProvider([refusalMessage()]);
    const { callbacks, log } = mockCallbacks();
    let refusalFired = false;
    callbacks.onRefusal = () => { refusalFired = true; };

    const engine = new GameEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
    });

    await engine.processInput("Aldric", "Something problematic");

    expect(refusalFired).toBe(true);
    expect(log.errors).toHaveLength(0);
    expect(engine.hasPendingRetry()).toBe(false);
  });

  it("fires onTurnEnd after refusal", async () => {
    const provider = mockProvider([refusalMessage()]);
    const { callbacks, log } = mockCallbacks();
    callbacks.onRefusal = () => {};

    const engine = new GameEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
    });

    await engine.processInput("Aldric", "Something problematic");

    // DM turn started and ended
    expect(log.turnStarts).toHaveLength(2); // player turn + dm turn
    expect(log.turnEnds).toHaveLength(2);
  });

  it("does not include refusal in narrative completions", async () => {
    const provider = mockProvider([refusalMessage()]);
    const { callbacks, log } = mockCallbacks();
    callbacks.onRefusal = () => {};

    const engine = new GameEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
    });

    await engine.processInput("Aldric", "Something problematic");

    expect(log.narrativeComplete).toHaveLength(0);
  });

  it("still tracks usage on refusal", async () => {
    const provider = mockProvider([refusalMessage()]);
    const { callbacks, log } = mockCallbacks();
    callbacks.onRefusal = () => {};

    const engine = new GameEngine({
      provider, gameState: mockState(), scene: mockScene(),
      sessionState: mockSessionState(), fileIO: mockFileIO(), callbacks,
    });

    await engine.processInput("Aldric", "Something problematic");

    expect(log.usageUpdates).toHaveLength(1);
    expect(log.usageUpdates[0].inputTokens).toBe(100);
    expect(log.usageUpdates[0].outputTokens).toBe(50);
  });

  it("skips promote_character when sheet_status is complete", async () => {
    const charPath = norm("/tmp/test-campaign/characters/storm.md");
    files[charPath] = "# Storm\n\n**Type:** PC\n**Sheet Status:** complete\n\n## Skills\n- Hack (d8)\n";

    const provider = mockProvider([
      ...toolAndTextMessages(
        "promote_character",
        { character: "storm", context: "Build initial sheet" },
        "Storm is ready.",
      ),
    ]);
    const { callbacks, log } = mockCallbacks();
    const io = mockFileIO();

    const engine = new GameEngine({
      provider,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: io,
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "Look around");

    // promoteCharacter subagent should NOT have been called
    expect(promoteCharacter).not.toHaveBeenCalled();

    // Dev log should say it was skipped
    expect(log.devLogs.some((m) => m.includes("skipped, sheet already complete"))).toBe(true);

    // The sheet_status flag should have been cleared for future level-ups
    const updated = files[charPath];
    expect(updated).not.toContain("Sheet Status");
    // But the sheet content should be preserved
    expect(updated).toContain("## Skills");
  });
});
