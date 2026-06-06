/**
 * First golden: a real DM turn, recorded once against the live API, replayed
 * deterministically forever after.
 *
 * Two halves, one scenario:
 *  - RECORD (gated by RECORD_GOLDENS=1 + a live key): a real Anthropic provider
 *    drives the scenario; the taping decorator captures the LLM I/O and we
 *    persist {tape, expectedNarrative} as the golden. This is the only half
 *    that spends API — run it to (re)generate the golden, then commit it.
 *  - REPLAY (always, offline; skipped until the golden exists): a pure
 *    tape-backed provider drives the SAME scenario and must reproduce the
 *    recorded narrative with no network.
 *
 * Regenerating a stale golden = re-run with RECORD_GOLDENS=1 and review the
 * git diff. This is the engine-level golden path; setup/full-stack goldens
 * (which need the child-process stack) come later via a GET /tape recorder.
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { GameEngine } from "../agents/game-engine.js";
import type { EngineCallbacks } from "../agents/game-engine.js";
import type { GameState } from "../agents/game-state.js";
import type { SceneState, FileIO } from "../agents/scene-manager.js";
import type { DMSessionState } from "../agents/dm-prompt.js";
import type { LLMProvider, TierProvider } from "../providers/types.js";
import type { ModelTier } from "@machine-violet/shared/types/engine.js";
import { createClocksState } from "../tools/clocks/index.js";
import { createCombatState, createDefaultConfig } from "../tools/combat/index.js";
import { createDecksState } from "../tools/cards/index.js";
import { createObjectivesState } from "../tools/objectives/index.js";
import { norm } from "../utils/paths.js";
import { TapeReader, deserializeTape, serializeTape, type Tape } from "../providers/tape.js";
import { createReplayProvider, createTapingProvider } from "../providers/tape-provider.js";
import { TapeWriter } from "../providers/tape.js";
import { createAnthropicProvider } from "../providers/index.js";
import { loadEnv } from "../config/first-launch.js";

const GOLDEN_PATH = fileURLToPath(new URL("./goldens/dm-open-door.golden.json", import.meta.url));

// The single source of truth for the scenario — record and replay MUST use it
// identically, or the replay won't line up with the taped responses.
const SCENARIO_MODEL = "claude-haiku-4-5-20251001"; // cheap; the golden replays regardless of model
const SCENARIO_INPUT = { character: "Aldric", text: "I open the door." } as const;

interface Golden {
  tape: Tape;
  expectedNarrative: string[];
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
    large: { provider, model: SCENARIO_MODEL },
    medium: { provider, model: SCENARIO_MODEL },
    small: { provider, model: SCENARIO_MODEL },
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

async function runScenario(provider: LLMProvider): Promise<{ narrative: string[]; errors: Error[] }> {
  const cap = captureCallbacks();
  const engine = new GameEngine({
    provider,
    tierProviders: tiers(provider),
    gameState: mockState(),
    scene: mockScene(),
    sessionState: {} as DMSessionState,
    fileIO: mockFileIO(),
    callbacks: cap.callbacks,
  });
  await engine.processInput(SCENARIO_INPUT.character, SCENARIO_INPUT.text);
  return { narrative: cap.narrative, errors: cap.errors };
}

describe("golden: dm-open-door", () => {
  it.skipIf(!process.env.RECORD_GOLDENS)("records the golden (live API)", async () => {
    loadEnv();
    const writer = new TapeWriter("dm-open-door");
    const { narrative, errors } = await runScenario(createTapingProvider(createAnthropicProvider(), writer));

    expect(errors).toEqual([]);
    expect(narrative.length).toBeGreaterThan(0);

    const golden: Golden = { tape: writer.build(), expectedNarrative: narrative };
    mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
    writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2) + "\n");
  }, 120_000);

  it.skipIf(!existsSync(GOLDEN_PATH))("replays the golden deterministically with no network", async () => {
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Golden;
    const replay = createReplayProvider(new TapeReader(deserializeTape(serializeTape(golden.tape))));
    const { narrative, errors } = await runScenario(replay);

    expect(errors).toEqual([]);
    expect(narrative).toEqual(golden.expectedNarrative);
  });
});
