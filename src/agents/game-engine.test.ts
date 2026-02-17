import { describe, it, expect, vi, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { GameEngine } from "./game-engine.js";
import type { EngineCallbacks, EngineState } from "./game-engine.js";
import type { GameState } from "./game-state.js";
import type { SceneState, FileIO } from "./scene-manager.js";
import type { DMSessionState } from "./dm-prompt.js";
import type { TuiCommand, UsageStats } from "./agent-loop.js";
import { createClocksState } from "../tools/clocks/index.js";
import { createCombatState, createDefaultConfig } from "../tools/combat/index.js";
import { createDecksState } from "../tools/cards/index.js";

function mockUsage(): Anthropic.Usage {
  return { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

function textMessage(text: string): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-6",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: mockUsage(),
  } as Anthropic.Message;
}

function toolAndTextMessages(
  toolName: string,
  toolInput: Record<string, unknown>,
  text: string,
): Anthropic.Message[] {
  return [
    {
      id: "msg_tool",
      type: "message",
      role: "assistant",
      model: "claude-opus-4-6",
      content: [{ type: "tool_use", id: "toolu_1", name: toolName, input: toolInput }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: mockUsage(),
    } as Anthropic.Message,
    textMessage(text),
  ];
}

let clientCallIdx: number;

function mockClient(responses: Anthropic.Message[]): Anthropic {
  clientCallIdx = 0;
  return {
    messages: {
      create: vi.fn(async () => responses[clientCallIdx++]),
      stream: vi.fn(() => {
        const response = responses[clientCallIdx++];
        return {
          on: vi.fn(),
          finalMessage: vi.fn(async () => response),
        };
      }),
    },
  } as unknown as Anthropic;
}

function mockState(): GameState {
  return {
    maps: {},
    clocks: createClocksState(),
    combat: createCombatState(),
    combatConfig: createDefaultConfig(),
    decks: createDecksState(),
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
    activePlayerIndex: 0,
  };
}

function mockScene(): SceneState {
  return {
    sceneNumber: 1,
    slug: "test-scene",
    transcript: [],
    precis: "",
    sessionNumber: 1,
  };
}

function mockSessionState(): DMSessionState {
  return {};
}

const norm = (p: string) => p.replace(/\\/g, "/");
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
      onUsageUpdate: (usage) => log.usageUpdates.push({ ...usage }),
      onError: (error) => log.errors.push(error),
    },
  };
}

beforeEach(() => {
  files = {};
  dirs = new Set();
});

describe("GameEngine", () => {
  it("processes player input and returns DM response", async () => {
    const client = mockClient([textMessage("The door creaks open.")]);
    const { callbacks, log } = mockCallbacks();

    const engine = new GameEngine({
      client,
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
    const client = mockClient([
      ...toolAndTextMessages("set_ui_style", { variant: "combat" }, "Combat begins!"),
    ]);
    const { callbacks, log } = mockCallbacks();

    const engine = new GameEngine({
      client,
      gameState: mockState(),
      scene: mockScene(),
      sessionState: mockSessionState(),
      fileIO: mockFileIO(),
      callbacks,
      model: "claude-haiku-4-5-20251001",
    });

    await engine.processInput("Aldric", "I attack!");

    expect(log.tuiCommands).toHaveLength(1);
    expect(log.tuiCommands[0].type).toBe("set_ui_style");
    expect(log.toolStarts).toContain("set_ui_style");
    expect(log.toolEnds).toContain("set_ui_style");
  });

  it("tracks session usage", async () => {
    const client = mockClient([textMessage("Hello.")]);
    const { callbacks, log } = mockCallbacks();

    const engine = new GameEngine({
      client,
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
    const client = mockClient([textMessage("The tavern is warm.")]);
    const { callbacks } = mockCallbacks();
    const scene = mockScene();

    const engine = new GameEngine({
      client,
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

  it("handles errors gracefully", async () => {
    const client = {
      messages: {
        stream: vi.fn(() => {
          throw new Error("API down");
        }),
      },
    } as unknown as Anthropic;

    const { callbacks, log } = mockCallbacks();

    const engine = new GameEngine({
      client,
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
    const client = mockClient([textMessage("- Party met in tavern")]);
    const { callbacks, log } = mockCallbacks();
    const scene = mockScene();

    const engine = new GameEngine({
      client,
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

  it("ends session", async () => {
    const client = mockClient([textMessage("- Session summary")]);
    const { callbacks, log } = mockCallbacks();

    const engine = new GameEngine({
      client,
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
    const client = mockClient([textMessage("Response 1")]);
    const { callbacks } = mockCallbacks();

    const engine = new GameEngine({
      client,
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
    expect(client.messages.stream).toHaveBeenCalledTimes(1);
  });
});
