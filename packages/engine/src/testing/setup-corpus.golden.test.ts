/**
 * The setup golden corpus — real setup-agent conversations recorded once
 * against the live API, then replayed deterministically offline.
 *
 * This is the setup-side complement to corpus.golden.test.ts (which covers the
 * DM loop). Each scenario drives the REAL {@link createSetupConversation}
 * through a scripted sequence of player turns until it calls `finalize_setup`,
 * then runs the REAL {@link buildCampaignWorld} handoff against an in-memory
 * FileIO. For every entry the suite generates two `it`s sharing one golden
 * (`goldens/<name>.golden.json`):
 *
 *  - RECORD (gated by RECORD_GOLDENS=1 + a live key): a taping provider
 *    captures the LLM I/O while a real provider drives the conversation; we
 *    persist `{ scenario, tape, expectedNarrative, expectedSetup }`. Only this
 *    half spends API. Run `npm run golden:record` to (re)generate, then commit.
 *  - REPLAY (always, offline; skipped until the golden exists): a pure
 *    tape-backed provider reproduces the SAME per-turn narrative AND the same
 *    finalized SetupResult with ZERO live calls, and the handoff scaffolds a
 *    campaign whose config matches. Runs in the normal `npm test`.
 *
 * Why this is the in-process setup→game replay backbone (vs. replaying an
 * mvplay full-stack capture): the setup agent had no offline coverage at all,
 * and the full-stack capture format records neither the player inputs nor a
 * replayable narrative segmentation. Driving createSetupConversation directly
 * — exactly as the game corpus drives GameEngine directly — is symmetric,
 * deterministic, and free, and it exercises the real finalize + scaffold path.
 *
 * Bucketing: setup calls carry no `conversationId`, so they all land in the
 * "default" bucket and match ordinally. A single-conversation setup flow makes
 * its calls in order, so the replay provider's "default" cursor stays aligned.
 *
 * No subagents to mock: createSetupConversation only calls the provider and
 * dispatches its tools locally (load_world reads bundled worlds;
 * present_choices / finalize_setup are in-process). Image/portrait tools are
 * left unregistered (no fileIO/setupRoot passed to the conversation), so every
 * tape stays text-only and diffable.
 *
 * Regenerating a stale golden = `npm run golden:record` + review the git diff.
 * Adding a scenario = one entry in SETUP_SCENARIOS + a record run.
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createSetupConversation } from "../agents/subagents/setup-conversation.js";
import { buildCampaignWorld } from "../agents/world-builder.js";
import type { SetupResult } from "../agents/setup-agent.js";
import type { CampaignConfig } from "@machine-violet/shared/types/config.js";
import type { FileIO } from "../agents/scene-manager.js";
import type { LLMProvider } from "../providers/types.js";
import { campaignPaths } from "../tools/filesystem/index.js";
import { norm } from "../utils/paths.js";
import { TapeReader, TapeWriter, deserializeTape, serializeTape, type Tape } from "../providers/tape.js";
import { createReplayProvider, createTapingProvider } from "../providers/tape-provider.js";
import { createAnthropicProvider } from "../providers/index.js";
import { loadEnv } from "../config/first-launch.js";

// Setup runs on the large tier in production; record on Sonnet so the recorded
// conversation finalizes coherently. The replay is model-agnostic (it returns
// recorded results regardless of model), so verification stays free.
const SCENARIO_MODEL = "claude-sonnet-4-6";

interface SetupGolden {
  scenario: string;
  tape: Tape;
  /** Per-turn narrative text, in order (start() then each consumed input). */
  expectedNarrative: string[];
  /** The finalized SetupResult — deterministic given the tape. */
  expectedSetup: SetupResult;
}

interface SetupScenario {
  /** Golden file slug. */
  name: string;
  /**
   * The player's content answers, consumed in order. Front-load everything the
   * agent gates on — crucially the player's *real name*, which it refuses to
   * proceed without — so these turns establish the campaign and the bounded
   * finalize loop below only has to confirm. The driver branches
   * send/resolveChoice on the pending-choice state, so an utterance answers a
   * choice modal when one is open and is a free-form message otherwise.
   */
  inputs: string[];
}

/**
 * After the scripted answers, the agent typically lays out a proposal "for
 * review" and only calls finalize_setup once the player confirms. We send this
 * imperative nudge until it does (or until the cap). Deterministic across
 * record/replay: the finalize flip point is driven by the recorded results, so
 * the same number of nudges runs either way.
 */
const FINALIZE_NUDGE =
  "Yes, that all sounds perfect — please call finalize_setup now with sensible defaults for anything unspecified, and let's begin.";
const MAX_FINALIZE_NUDGES = 6;

const goldenPath = (name: string) =>
  fileURLToPath(new URL(`./goldens/${name}.golden.json`, import.meta.url));

// ---------------------------------------------------------------------------
// The scenarios. Each is a distinct setup path to a finalized campaign.
// ---------------------------------------------------------------------------
const SETUP_SCENARIOS: SetupScenario[] = [
  {
    name: "setup-quickstart-fantasy",
    inputs: [
      "I'm Sam, an adult. Quick start, please — pick a fantasy world for me, something with intrigue.",
      "That world sounds great, let's use it.",
      "My character is Aldric, a weathered sellsword chasing a blood debt. Keep it simple — no extra mechanics. I'm an adult, surprise me with the rest.",
    ],
  },
  {
    name: "setup-custom-noir",
    inputs: [
      "I'm Sam, an adult. I want a fully custom game: 1970s occult noir in a rain-soaked city. Pure narrative, no rules system.",
      "Mood tense and melancholy, difficulty unforgiving. Call the campaign 'Neon Requiem'.",
      "I'm playing Marlowe Cray, a burned-out PI who can see the dead.",
    ],
  },
  {
    name: "setup-dnd-character",
    inputs: [
      "I'm Sam, an adult. Let's play D&D 5e — classic heroic fantasy.",
      "My character is Vesper Quill, a sly, charming half-elf rogue who's light on her feet. Standard array is fine and you can pick sensible skills.",
    ],
  },
];

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------
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

/**
 * Drive a setup conversation to completion. Returns the per-turn narrative and
 * the finalized SetupResult (undefined if the scripted inputs ran out before
 * the agent finalized — a record-time authoring error). Deterministic across
 * record and replay: the send/resolveChoice branch keys off the conversation's
 * pending-choice state, which is itself driven by the (recorded) provider
 * results, so the same sequence of calls is made either way.
 */
async function runSetupScenario(
  scenario: SetupScenario,
  provider: LLMProvider,
): Promise<{ narrative: string[]; finalized: SetupResult | undefined }> {
  // No fileIO/setupRoot → portrait/image tools are not registered; the flow
  // stays text-only (and a non-image model reports no image capability, so the
  // consent question is skipped too).
  const conv = createSetupConversation(provider, SCENARIO_MODEL);
  const narrative: string[] = [];
  const sink = (): void => {};
  const trace = process.env.MV_SETUP_TRACE === "1";
  const choicesOf = (r: { pendingChoices?: { choices: string[] } }) =>
    r.pendingChoices ? JSON.stringify(r.pendingChoices.choices) : "none";
  const preview = (s: string) => s.slice(0, 200).replace(/\s+/g, " ").trim();

  let result = await conv.start(sink);
  narrative.push(result.text);
  let finalized = result.finalized;
  if (trace) process.stdout.write(`\n[${scenario.name}]\n[start] finalized=${!!finalized} choices=${choicesOf(result)} text="${preview(result.text)}"\n`);

  // 1. Scripted content answers — establish the campaign.
  for (let i = 0; i < scenario.inputs.length; i++) {
    if (finalized) break;
    const input = scenario.inputs[i] ?? "";
    const mode = conv.hasPendingChoice ? "resolveChoice" : "send";
    if (trace) process.stdout.write(`[in ${i}] ${mode} <- "${input.slice(0, 70)}"\n`);
    result = mode === "resolveChoice"
      ? await conv.resolveChoice(input, sink)
      : await conv.send(input, sink);
    narrative.push(result.text);
    finalized = result.finalized ?? finalized;
    if (trace) process.stdout.write(`[out ${i}] finalized=${!!finalized} choices=${choicesOf(result)} text="${preview(result.text)}"\n`);
  }

  // 2. Bounded finalize loop — confirm until the agent calls finalize_setup.
  for (let n = 0; n < MAX_FINALIZE_NUDGES && !finalized; n++) {
    const mode = conv.hasPendingChoice ? "resolveChoice" : "send";
    if (trace) process.stdout.write(`[nudge ${n}] ${mode}\n`);
    result = mode === "resolveChoice"
      ? await conv.resolveChoice(FINALIZE_NUDGE, sink)
      : await conv.send(FINALIZE_NUDGE, sink);
    narrative.push(result.text);
    finalized = result.finalized ?? finalized;
    if (trace) process.stdout.write(`[nudge ${n} out] finalized=${!!finalized} choices=${choicesOf(result)} text="${preview(result.text)}"\n`);
  }

  return { narrative, finalized };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe("setup golden corpus", () => {
  for (const scenario of SETUP_SCENARIOS) {
    const GOLDEN = goldenPath(scenario.name);

    describe(scenario.name, () => {
      it.skipIf(process.env.RECORD_GOLDENS !== "1")("records the golden (live API)", async () => {
        loadEnv();
        const writer = new TapeWriter(scenario.name);
        const { narrative, finalized } = await runSetupScenario(
          scenario,
          createTapingProvider(createAnthropicProvider(), writer),
        );

        expect(finalized, "scenario must reach finalize_setup — extend its inputs").toBeDefined();
        expect(narrative.length).toBeGreaterThan(0);

        const golden: SetupGolden = {
          scenario: scenario.name,
          tape: writer.build(),
          expectedNarrative: narrative,
          expectedSetup: finalized as SetupResult,
        };
        mkdirSync(dirname(GOLDEN), { recursive: true });
        writeFileSync(GOLDEN, JSON.stringify(golden, null, 2) + "\n");
      }, 180_000);

      it.skipIf(!existsSync(GOLDEN))("replays deterministically with no network", async () => {
        const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as SetupGolden;
        const replay = createReplayProvider(new TapeReader(deserializeTape(serializeTape(golden.tape))));
        const { narrative, finalized } = await runSetupScenario(scenario, replay);

        // 1. The conversation reproduces verbatim, offline.
        expect(narrative).toEqual(golden.expectedNarrative);
        // 2. finalize_setup derives the same campaign blueprint.
        expect(finalized).toEqual(golden.expectedSetup);

        // 3. The handoff scaffolds a campaign matching that blueprint. Runs the
        //    real buildCampaignWorld against in-memory FileIO (config.json's
        //    createdAt is wall-clock, so assert fields, not a deep-equal).
        const fileIO = mockFileIO();
        const root = await buildCampaignWorld("/tmp/campaigns", finalized as SetupResult, fileIO, "/tmp/home");

        const configRaw = await fileIO.readFile(norm(campaignPaths(root).config));
        expect(configRaw, "config.json should be written").not.toBe("");
        const config = JSON.parse(configRaw) as CampaignConfig;
        expect(config.name).toBe(golden.expectedSetup.campaignName);
        expect(config.system).toBe(golden.expectedSetup.system ?? undefined);
        expect(config.dm_personality.name).toBe(golden.expectedSetup.personality.name);
        expect(config.players[0]?.character).toBe(golden.expectedSetup.characterName);
        // The setup agent's opening-scene directive survives into config so the
        // session manager can inject it into the DM's first-turn priming.
        expect(config.opening_scene).toBe(golden.expectedSetup.openingScene ?? undefined);

        const charRaw = await fileIO.readFile(norm(campaignPaths(root).character(golden.expectedSetup.characterName)));
        expect(charRaw, "character sheet should be scaffolded").not.toBe("");
      });
    });
  }
});
