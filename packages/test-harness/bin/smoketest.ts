#!/usr/bin/env node
/**
 * Smoketest probe: walk new-campaign setup once and observe two in-game turns.
 *
 * Proves:
 *   1. New Campaign can be started from the main menu.
 *   2. The setup-agent conversation can be walked to handoff by selecting
 *      the first real choice at every overlay and replying "you decide"
 *      to free-text prompts.
 *   3. The setup → live-campaign handoff lands; the first DM turn arrives.
 *   4. The player can submit an action and the DM produces a response.
 *   5. The player can submit a second action and the DM produces another
 *      response. (Two complete in-game turns total — covers state
 *      transitions that only show up on turn 2: scribe spawn, scene
 *      bookkeeping, transcript flush continuity.)
 *
 * Stops after step 5. The harness's process tree gets hard-killed on
 * shutdown — Save & Exit is deliberately skipped (it would burn a Haiku
 * call on the session-recap subagent every smoke run, and save-on-exit
 * is already covered by unit tests on session-manager).
 *
 * Every wait is anchored to a concrete state transition
 * (`engineState`, `currentTurn.status`, `narrativeLines` growth,
 * `transitionCampaignId`). No naive sleeps. The outer timeout exists
 * only so the probe fails rather than hangs if something genuinely
 * breaks.
 *
 * Requirements:
 *   - A valid configured provider connection (`ANTHROPIC_API_KEY` or
 *     another). Live LLM calls happen — expect real token spend.
 *
 * Approximate budget: 7-12 minutes wall-clock. Dominated by the first
 * DM turn (3-5 min) plus two player turn cycles (~1 min each).
 *
 * For ad-hoc probes that exercise different paths (image generation,
 * specific personalities, save/load, ESC menu, etc.), write a one-shot
 * script following this file's shape — import `runProbe` from
 * `@machine-violet/test-harness` and drop a body inline. The skill
 * (`.claude/skills/smoketest/SKILL.md`) and `docs/e2e-harness.md`
 * have the primitives reference and gotchas list.
 */
import { runProbe } from "../src/run-probe.js";
import type { Harness } from "../src/harness.js";
import type { ActiveChoices } from "../src/client-state.js";
import {
  DEFAULT_LONG_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  DEFAULT_SHORT_TIMEOUT_MS,
} from "../src/wait.js";

const FREE_TEXT_DEFAULT_ANSWER = "you decide";
const PLAYER_TURN_ACTIONS = [
  "I look around to take stock of my surroundings.",
  "I take a careful step forward and listen.",
];

await runProbe({
  name: "smoketest",
  title: "New campaign → handoff → two in-game turns",
  body: async ({ harness, log }) => {
    log("Phase 1: main menu");
    await harness.waitForScreen("Machine Violet", { timeoutMs: DEFAULT_SHORT_TIMEOUT_MS });
    await harness.waitForScreen("New Campaign", { timeoutMs: DEFAULT_SHORT_TIMEOUT_MS });
    log("  Main menu rendered.");

    log("Phase 2: selecting 'New Campaign'");
    // The MainMenuPhase opens with index 0 = "New Campaign", so a bare Enter
    // is enough. (If a future change reorders the menu, this probe will
    // fail loudly at the next state check — that's a good early signal.)
    await harness.sendKey("return");

    // The setup session runs under a synthetic campaignId "__setup__". The
    // engine broadcasts session:mode only for OOC/dev entry/exit, NOT for
    // the initial setup conversation, so `mode` stays "play" throughout
    // setup. Watch for the setup turn opening instead.
    log("  Waiting for setup turn to open...");
    await harness.waitForState(
      (s) => s.currentTurn?.campaignId === "__setup__" && s.currentTurn?.status === "open",
      {
        description: "setup turn opens (campaignId === '__setup__', status === 'open')",
        timeoutMs: DEFAULT_TURN_TIMEOUT_MS,
      },
    );
    log("  Setup turn open.");

    log("Phase 3: walking the setup-agent conversation");
    await walkSetup(harness, log);

    log("Phase 4: waiting for first DM turn (this can take 3-5 minutes)");
    await waitForFirstDmTurn(harness, log);

    log("Phase 5a: submitting first player action");
    await submitOnePlayerTurnAndAwaitResponse(harness, log, PLAYER_TURN_ACTIONS[0]);

    log("Phase 5b: submitting second player action");
    await submitOnePlayerTurnAndAwaitResponse(harness, log, PLAYER_TURN_ACTIONS[1]);

    log("Two in-game turns complete.");
  },
});

async function walkSetup(harness: Harness, log: (m: string) => void): Promise<void> {
  // The setup-agent leads. Each turn it either presents structured choices
  // (activeChoices populated) or asks for free text. We keep replying until
  // the campaign id flips off "__setup__" or transitionCampaignId is set
  // (handoff in progress). 20 turns is far above the canonical 5-10 turn
  // shape — exceeding it means something is wrong.
  //
  // narrativeLines.length is the "agent acted" signal — it grows
  // monotonically as the DM streams. activeChoices is unreliable as an
  // acknowledgment signal because the setup agent sometimes leaves the
  // last choice overlay visible while asking a free-text follow-up.
  const MAX_SETUP_TURNS = 20;
  let baselineNarrative = -1;
  // Track which choice fingerprints we've already submitted. If the agent
  // re-presents the same overlay (because it moved to free-text without
  // clearing), we treat it as stale and submit text instead — otherwise
  // we'd loop forever picking the same first choice.
  const submittedChoiceFingerprints = new Set<string>();

  for (let turn = 1; turn <= MAX_SETUP_TURNS; turn++) {
    // Wait for the agent to settle: narrative has grown AND engine is
    // back at waiting_input (or handoff fired, or a real turn opened).
    // Note: when activeChoices is set, currentTurn is null — the choice
    // overlay supersedes the turn UI. Don't require currentTurn != null.
    const snapshot = await harness.waitForState(
      (s) =>
        s.transitionCampaignId !== null ||
        (s.currentTurn !== null && s.currentTurn.campaignId !== "__setup__") ||
        (s.engineState === "waiting_input" &&
         s.narrativeLines.length > baselineNarrative &&
         (s.activeChoices !== null ||
          (s.currentTurn !== null && s.currentTurn.status === "open"))),
      {
        description: "agent settled at waiting_input with new narrative, OR handoff fires",
        timeoutMs: DEFAULT_LONG_TIMEOUT_MS,
      },
    );

    if (snapshot.transitionCampaignId !== null ||
        (snapshot.currentTurn !== null && snapshot.currentTurn.campaignId !== "__setup__")) {
      log(`  Setup complete after ${turn - 1} player turn(s); handoff in progress.`);
      return;
    }

    // Snapshot the new narrative-length baseline so the NEXT iteration
    // waits for further growth, not the same growth we just observed.
    baselineNarrative = snapshot.narrativeLines.length;

    const fp = snapshot.activeChoices ? choiceFingerprint(snapshot.activeChoices) : null;
    const choiceIsStale = fp !== null && submittedChoiceFingerprints.has(fp);

    if (snapshot.activeChoices && fp !== null && !choiceIsStale) {
      const labels = snapshot.activeChoices.choices.map((c) =>
        typeof c === "string" ? c : (c.label ?? c.text ?? ""),
      );
      const pickIndex = pickFirstRealChoice(labels);
      log(`  Turn ${turn}: choice — picking #${pickIndex + 1} of ${labels.length}: ${JSON.stringify(labels[pickIndex])}`);
      submittedChoiceFingerprints.add(fp);
      await navigateToRealChoice(harness, pickIndex);
    } else {
      if (choiceIsStale) {
        log(`  Turn ${turn}: stale choice overlay still visible — falling through to free-text`);
      }
      log(`  Turn ${turn}: free-text — submitting ${JSON.stringify(FREE_TEXT_DEFAULT_ANSWER)}`);
      // When a stale overlay is visible, the InlineTextInput at index 0
      // ("Enter your own...") is the input target. Navigate UP to it
      // before typing.
      if (choiceIsStale) await harness.sendKey("up");
      await harness.submitText(FREE_TEXT_DEFAULT_ANSWER);
    }
  }

  throw new Error(
    `Setup did not complete within ${MAX_SETUP_TURNS} turns. ` +
    `Either the agent is in a loop, or the harness's choice strategy is wrong.`,
  );
}

async function waitForFirstDmTurn(harness: Harness, log: (m: string) => void): Promise<void> {
  // After session:transition, the engine restarts on the new campaign id.
  // The first DM turn typically streams in within a few minutes; we watch
  // for a turn whose campaignId is NOT "__setup__" and is open.
  const state = await harness.waitForState(
    (s) =>
      s.currentTurn !== null &&
      s.currentTurn.campaignId !== "__setup__" &&
      s.currentTurn.status === "open",
    {
      description: "first live player turn opens (campaignId != '__setup__')",
      timeoutMs: DEFAULT_LONG_TIMEOUT_MS,
    },
  );
  log(`  First live player turn open (campaignId=${state.currentTurn?.campaignId}, ` +
      `seq=${state.currentTurn?.seq}). Narrative lines: ${state.narrativeLines.length}.`);
}

async function submitOnePlayerTurnAndAwaitResponse(
  harness: Harness,
  log: (m: string) => void,
  action: string,
): Promise<void> {
  const before = await harness.getState();
  const baselineLines = before.narrativeLines.length;
  const baselineSeq = before.currentTurn?.seq ?? 0;

  log(`  Submitting: ${JSON.stringify(action)}`);
  await harness.submitText(action);

  // The contribute call should flip the turn to "processing" or "resolved"
  // and engineState to "dm_thinking" within a few seconds.
  log("  Waiting for DM to start thinking...");
  await harness.waitForState(
    (s) => s.engineState === "dm_thinking" || (s.currentTurn?.seq ?? 0) > baselineSeq,
    {
      description: "DM begins processing after player turn submit",
      timeoutMs: DEFAULT_TURN_TIMEOUT_MS,
    },
  );

  log("  Waiting for DM response to complete...");
  // After the DM responds in single-player auto-commit mode, the engine
  // ends up at engineState="waiting_input" with currentTurn=null — a new
  // turn isn't opened until the next player input arrives. Don't require
  // currentTurn != null here; narrativeLines growth + waiting_input is
  // the right "DM is done" signal.
  const after = await harness.waitForState(
    (s) =>
      s.engineState === "waiting_input" &&
      s.narrativeLines.length > baselineLines,
    {
      description: "DM response complete (narrative grew + engine waiting_input)",
      timeoutMs: DEFAULT_LONG_TIMEOUT_MS,
    },
  );

  log(`  DM response received. seq ${baselineSeq} → ${after.currentTurn?.seq ?? "(null)"}, ` +
      `narrative lines ${baselineLines} → ${after.narrativeLines.length}.`);
}

/** Stable string fingerprint of a choice overlay; used to detect stale overlays. */
function choiceFingerprint(choices: ActiveChoices): string {
  const labels = choices.choices.map((c) =>
    typeof c === "string" ? c : (c.label ?? c.text ?? ""),
  );
  return (choices.prompt ?? "") + "::" + labels.join("|");
}

/**
 * Pick the first non-meta choice. The setup-agent rarely offers a "Cancel"
 * option, so "first real choice" is a reasonable default. Skip text-input
 * placeholders and "Customize..." entries.
 */
function pickFirstRealChoice(labels: string[]): number {
  for (let i = 0; i < labels.length; i++) {
    const lower = labels[i].toLowerCase();
    if (lower.includes("enter your own") || lower.includes("customize")) continue;
    return i;
  }
  return 0;
}

/**
 * Navigate the ChoiceOverlay to a specific real-choice index and submit it.
 *
 * The overlay opens with "Enter your own" at the UI's index 0,
 * customInputActive for short lists (<5 options) and false for longer
 * ones. We normalize first:
 *   - Press UP to force selectedIndex=0 + customInputActive=true regardless of length
 *   - Press DOWN once to move to the first real choice (UI index 1, server index 0)
 *   - Press DOWN (pickIndex) more times to reach our target real choice
 *   - Press Enter to submit
 */
async function navigateToRealChoice(harness: Harness, pickIndex: number): Promise<void> {
  await harness.sendKey("up");
  await harness.sendKey("down");
  if (pickIndex > 0) await harness.sendKeys("down", pickIndex);
  await harness.sendKey("return");
}
