/**
 * The golden corpus — real DM turns recorded once against the live API, then
 * replayed deterministically forever after with no network.
 *
 * Each scenario is one entry in {@link SCENARIOS}. For every entry the suite
 * generates two `it`s sharing one golden file (`goldens/<name>.golden.json`):
 *
 *  - RECORD (gated by RECORD_GOLDENS=1 + a live key): a real Anthropic provider
 *    drives the scenario; the taping decorator captures the LLM I/O and we
 *    persist `{ scenario, tape, expectedNarrative }`. This is the only half that
 *    spends API. Run `npm run golden:record` to (re)generate, then commit.
 *  - REPLAY (always, offline; skipped until the golden exists): a pure
 *    tape-backed provider drives the SAME scenario and must reproduce the
 *    recorded narrative with ZERO live calls. Runs in the normal `npm test`.
 *
 * Subagents (scribe / scene-tracker / ai-player / character-promotion) are
 * mocked to no-ops so a turn makes exactly the DM provider calls — keeping
 * every golden a single deterministic bucket. Subagent behavior has its own
 * tests; the golden's job is the DM turn + its tool loop.
 *
 * Regenerating a stale golden = `npm run golden:record` + review the git diff.
 * Adding a scenario = one entry in SCENARIOS + a record run. Full-stack /
 * setup goldens (which need the live TUI) are captured via `mvplay record`
 * instead — see docs/golden-tapes.md.
 */
import { describe, it, expect, vi } from "vitest";
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
import { TapeReader, TapeWriter, deserializeTape, serializeTape, type Tape } from "../providers/tape.js";
import { createReplayProvider, createTapingProvider } from "../providers/tape-provider.js";
import { createAnthropicProvider } from "../providers/index.js";
import { loadEnv } from "../config/first-launch.js";

// Mock subagents so a turn makes exactly its DM provider calls — one bucket,
// fully deterministic. (vi.mock is hoisted; it must live in the test file.)
vi.mock("../agents/subagents/scribe.js", () => ({
  runScribe: vi.fn(async () => ({
    summary: "", created: [], updated: [], entityDeltas: [], removedSlugs: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  })),
}));
vi.mock("../agents/subagents/scene-tracker.js", () => ({
  SCENE_TRACKER_CADENCE: 4,
  trackScene: vi.fn(async () => ({
    text: "", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, openThreads: "",
  })),
}));
vi.mock("../agents/subagents/ai-player.js", () => ({ aiPlayerTurn: vi.fn() }));
vi.mock("../agents/subagents/character-promotion.js", () => ({ promoteCharacter: vi.fn() }));

// haiku is cheap; the golden replays regardless of model.
const SCENARIO_MODEL = "claude-haiku-4-5-20251001";

interface Golden {
  scenario: string;
  tape: Tape;
  expectedNarrative: string[];
}

interface Scenario {
  /** Golden file slug. */
  name: string;
  /** Drive the engine; narrative is captured via callbacks. */
  play: (engine: GameEngine) => Promise<void>;
}

const goldenPath = (name: string) =>
  fileURLToPath(new URL(`./goldens/${name}.golden.json`, import.meta.url));

// ---------------------------------------------------------------------------
// The scenarios. Each is a distinct player intent through the real DM loop.
// ---------------------------------------------------------------------------
const SCENARIOS: Scenario[] = [
  { name: "dm-open-door", play: (e) => e.processInput("Aldric", "I cross to the iron-banded cellar door and try the handle.") },
  { name: "dm-look-around", play: (e) => e.processInput("Aldric", "I take a slow, careful look around the common room.") },
  { name: "dm-talk-npc", play: (e) => e.processInput("Aldric", "I cross to the hooded figure by the hearth and ask their name.") },
  { name: "dm-attack", play: (e) => e.processInput("Aldric", "I draw my blade and kick the cellar door open, ready for whatever's below.") },
  { name: "dm-skill-check", play: (e) => e.processInput("Aldric", "I kneel by the cellar door and try to pick the lock.") },
  { name: "dm-examine", play: (e) => e.processInput("Aldric", "I examine the iron bands on the cellar door for any weakness.") },
  { name: "dm-use-item", play: (e) => e.processInput("Aldric", "I slide a silver coin across the bar and ask Mella for the cellar key.") },
  { name: "dm-move", play: (e) => e.processInput("Aldric", "I edge toward the cellar door, keeping out of Mella's line of sight.") },
  { name: "dm-social", play: (e) => e.processInput("Aldric", "I offer to buy the hooded figure a drink and try to coax them into talking.") },
  {
    name: "dm-multi-turn",
    play: async (e) => {
      await e.processInput("Aldric", "I scan the common room, taking stock of who's here.");
      await e.processInput("Aldric", "I make my way toward the hooded figure by the hearth.");
    },
  },
];

// ---------------------------------------------------------------------------
// Scaffolding (mirrors game-engine.test.ts; intentionally minimal).
// ---------------------------------------------------------------------------
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

// An established scene so the DM narrates in character instead of punting with
// "I need more context." Scenario inputs below are coherent with it.
function mockScene(): SceneState {
  return {
    sceneNumber: 1,
    slug: "gilded-stag-common-room",
    transcript: [],
    precis:
      "Aldric stands in the common room of the Gilded Stag, a cramped tavern on the edge of the " +
      "Mournwood. Rain hammers the shutters and tallow smoke hazes the rafters. A hooded figure sits " +
      "alone by the hearth, nursing a tankard. The barkeep, a heavyset woman named Mella, eyes Aldric " +
      "warily as she wipes a mug. Across the room an iron-banded oak door leads down to the cellar — " +
      "locked, old, and conspicuously avoided.",
    openThreads:
      "The hooded figure may know what's behind the cellar door. Mella is hiding something about it.",
    npcIntents:
      "Mella: deflect questions about the cellar. Hooded figure: stay unnoticed, leave before midnight.",
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

async function runScenario(
  scenario: Scenario,
  provider: LLMProvider,
): Promise<{ narrative: string[]; errors: Error[] }> {
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
  await scenario.play(engine);
  return { narrative: cap.narrative, errors: cap.errors };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe("golden corpus", () => {
  for (const scenario of SCENARIOS) {
    const GOLDEN = goldenPath(scenario.name);

    describe(scenario.name, () => {
      it.skipIf(process.env.RECORD_GOLDENS !== "1")("records the golden (live API)", async () => {
        loadEnv();
        const writer = new TapeWriter(scenario.name);
        const { narrative, errors } = await runScenario(
          scenario,
          createTapingProvider(createAnthropicProvider(), writer),
        );

        expect(errors).toEqual([]);
        expect(narrative.length).toBeGreaterThan(0);

        const golden: Golden = { scenario: scenario.name, tape: writer.build(), expectedNarrative: narrative };
        mkdirSync(dirname(GOLDEN), { recursive: true });
        writeFileSync(GOLDEN, JSON.stringify(golden, null, 2) + "\n");
      }, 120_000);

      it.skipIf(!existsSync(GOLDEN))("replays deterministically with no network", async () => {
        const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Golden;
        const replay = createReplayProvider(new TapeReader(deserializeTape(serializeTape(golden.tape))));
        const { narrative, errors } = await runScenario(scenario, replay);

        expect(errors).toEqual([]);
        expect(narrative).toEqual(golden.expectedNarrative);
      });
    });
  }
});
