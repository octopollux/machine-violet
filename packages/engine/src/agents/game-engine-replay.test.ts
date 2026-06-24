/**
 * Tier-2 deterministic backbone — proof of life.
 *
 * Drives a real {@link GameEngine} turn end-to-end through the record/replay
 * provider shims with NO network and NO API key:
 *   1. RECORD — a mock LLM stands in for the real provider; the taping decorator
 *      captures whatever the engine actually sends (correct `conversationId`
 *      buckets, no guessing).
 *   2. REPLAY — a pure tape-backed provider drives a FRESH engine over the same
 *      logical input and must produce identical narrative while making ZERO
 *      live provider calls.
 *
 * This is the seam the full replay-runner generalizes (load a recorded scenario,
 * inject the replay provider, drive logical inputs, assert). The scaffolding
 * mirrors game-engine.test.ts; the replay-runner will factor it into a shared
 * fixture so this duplication is temporary.
 */
import { describe, it, expect, vi } from "vitest";
import { GameEngine } from "./game-engine.js";
import type { EngineCallbacks } from "./game-engine.js";
import type { GameState } from "./game-state.js";
import type { SceneState, FileIO } from "./scene-manager.js";
import type { DMSessionState } from "./dm-prompt.js";
import type { ChatResult, LLMProvider, TierProvider } from "../providers/types.js";
import type { ModelTier } from "@machine-violet/shared/types/engine.js";
import { createClocksState } from "../tools/clocks/index.js";
import { createCombatState, createDefaultConfig } from "../tools/combat/index.js";
import { createDecksState } from "../tools/cards/index.js";
import { createObjectivesState } from "../tools/objectives/index.js";
import { norm } from "../utils/paths.js";
import { TapeReader, TapeWriter, deserializeTape, serializeTape } from "../providers/tape.js";
import { createReplayProvider, createTapingProvider } from "../providers/tape-provider.js";

// Mirror game-engine.test.ts's subagent mocks so a plain turn makes exactly one
// (DM) provider call — keeps the deterministic surface we're proving minimal.
vi.mock("./subagents/scribe.js", () => ({
  runScribe: vi.fn(async () => ({
    summary: "",
    created: [],
    updated: [],
    entityDeltas: [],
    removedSlugs: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  })),
}));
vi.mock("./subagents/scene-tracker.js", () => ({
  SCENE_TRACKER_CADENCE: 4,
  trackScene: vi.fn(async () => ({
    text: "",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    openThreads: "",
  })),
}));
vi.mock("./subagents/ai-player.js", () => ({ aiPlayerTurn: vi.fn() }));
vi.mock("./subagents/character-promotion.js", () => ({ promoteCharacter: vi.fn() }));

function textMessage(text: string): ChatResult {
  return {
    text,
    toolCalls: [],
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 },
    stopReason: "end",
    assistantContent: [{ type: "text", text }],
  };
}

/** A mock LLM that plays back canned responses; stands in for a real provider during RECORD. */
function recordingMock(responses: ChatResult[]): LLMProvider {
  let idx = 0;
  return {
    providerId: "mock",
    getCapabilities: () => ({ imageGeneration: false }),
    chat: vi.fn(async () => responses[idx++]),
    stream: vi.fn(async () => responses[idx++]),
    healthCheck: vi.fn(async () => ({ status: "valid", message: "ok" })),
  };
}

function providerCallCount(p: LLMProvider): number {
  return (
    (p.chat as ReturnType<typeof vi.fn>).mock.calls.length +
    (p.stream as ReturnType<typeof vi.fn>).mock.calls.length
  );
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
    slug: "test-scene",
    transcript: [],
    precis: "",
    openThreads: "",
    npcIntents: "",
    playerReads: [],
    sessionNumber: 1,
    sessionRecapPending: false,
  };
}

/** Each engine gets its own in-memory FileIO so record and replay don't share state. */
function mockFileIO(): FileIO {
  const files: Record<string, string> = {};
  const dirs = new Set<string>();
  return {
    readFile: async (p) => files[norm(p)] ?? "",
    writeFile: async (p, c) => { files[norm(p)] = c; },
    appendFile: async (p, c) => { files[norm(p)] = (files[norm(p)] ?? "") + c; },
    mkdir: async (p) => { dirs.add(norm(p)); },
    exists: async (p) => norm(p) in files || dirs.has(norm(p)),
    listDir: async () => [],
  };
}

function tiers(provider: LLMProvider): Record<ModelTier, TierProvider> {
  return {
    large: { provider, model: "claude-opus-4-6" },
    medium: { provider, model: "claude-sonnet-4-6" },
    small: { provider, model: "claude-haiku-4-5-20251001" },
  };
}

function captureCallbacks() {
  const narrative: string[] = [];
  const errors: Error[] = [];
  const callbacks: EngineCallbacks = {
    onNarrativeDelta: () => {},
    onNarrativeComplete: (t) => narrative.push(t),
    onStateChange: () => {},
    onTuiCommand: () => {},
    onToolStart: () => {},
    onToolEnd: () => {},
    onExchangeDropped: () => {},
    onUsageUpdate: () => {},
    onError: (e) => errors.push(e),
    onDevLog: () => {},
    onRetry: () => {},
    onTurnStart: () => {},
    onTurnEnd: () => {},
  };
  return { callbacks, narrative, errors };
}

function makeEngine(provider: LLMProvider, callbacks: EngineCallbacks): GameEngine {
  return new GameEngine({
    provider,
    tierProviders: tiers(provider),
    gameState: mockState(),
    scene: mockScene(),
    sessionState: {} as DMSessionState,
    fileIO: mockFileIO(),
    callbacks,
  });
}

describe("GameEngine record/replay (Tier-2 deterministic backbone)", () => {
  it("replays a DM turn through the real engine with no live provider calls", async () => {
    const dmText = "The door creaks open, hinges groaning in the dark.";

    // --- RECORD: mock LLM stands in; taping captures the engine's real traffic.
    const mock = recordingMock([textMessage(dmText)]);
    const writer = new TapeWriter("dm-open-door");
    const taping = createTapingProvider(mock, writer);
    const rec = captureCallbacks();
    await makeEngine(taping, rec.callbacks).processInput("Aldric", "I open the door.");

    expect(rec.errors).toEqual([]);
    expect(rec.narrative).toContain(dmText);

    const callsAfterRecord = providerCallCount(mock);
    expect(callsAfterRecord).toBeGreaterThanOrEqual(1);

    // --- REPLAY: serialize, then a pure tape-backed provider drives a fresh engine.
    const tape = deserializeTape(serializeTape(writer.build()));
    const replay = createReplayProvider(new TapeReader(tape));
    const rep = captureCallbacks();
    await makeEngine(replay, rep.callbacks).processInput("Aldric", "I open the door.");

    expect(rep.errors).toEqual([]);
    expect(rep.narrative).toEqual(rec.narrative); // identical behavior...
    expect(providerCallCount(mock)).toBe(callsAfterRecord); // ...with ZERO live calls during replay
  });
});
