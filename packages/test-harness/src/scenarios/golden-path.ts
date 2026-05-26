/**
 * Golden path: the baseline every smoke test must do at minimum.
 *
 * Proves:
 *   1. New Campaign can be started from the main menu.
 *   2. The setup-agent conversation can be walked to completion by selecting
 *      sensible defaults at each choice point.
 *   3. The setup → live-campaign handoff lands successfully (the DM's first
 *      turn arrives — observed to take 3-5 minutes in normal conditions).
 *   4. A player turn can be submitted and the DM produces a response turn.
 *
 * Stops after step 4. The harness's process tree gets hard-killed on
 * shutdown — we deliberately skip Save & Exit because (a) it burns a
 * Haiku call on the session-recap subagent every smoke run, and (b)
 * save-on-exit is already covered by unit tests of session-manager. If
 * you need to test that flow, write a dedicated `save-on-exit` scenario.
 *
 * We never use naive sleeps to wait for the DM. Every wait is anchored to
 * a concrete state transition (`engineState`, `mode`, `activeChoices`,
 * `currentTurn.status`, narrative growth). The outer timeout exists only to
 * guarantee the scenario doesn't hang forever if something genuinely breaks.
 *
 * Requirements:
 *   - `ANTHROPIC_API_KEY` (or another configured connection) must be valid.
 *   - Live LLM calls happen. Expect real token spend.
 *
 * Approximate budget: 5-7 minutes wall-clock. Dominated by the first DM
 * turn (3-5 min) plus one player turn (30-60s).
 */
import type { Scenario, ScenarioContext } from "./types.js";
import type { Harness } from "../harness.js";
import { DEFAULT_LONG_TIMEOUT_MS, DEFAULT_TURN_TIMEOUT_MS, DEFAULT_SHORT_TIMEOUT_MS } from "../wait.js";

// Optional tweak: force a specific DM personality. When set, the scenario
// prefers this personality if it appears in the offered choices, and folds
// the name into the free-text default so the setup agent has a hint even
// when its personality list doesn't include this entry.
const FORCED_PERSONALITY = process.env.SMOKETEST_PERSONALITY?.trim() || null;

// Optional tweak: force a specific campaign world. Same shape as
// SMOKETEST_PERSONALITY — name match in pickSetupChoice + a hint folded
// into the free-text default so Quick Start lands on this world even if
// the agent's offered list doesn't include it.
const FORCED_WORLD = process.env.SMOKETEST_WORLD?.trim() || null;

const FREE_TEXT_HINTS: string[] = [];
if (FORCED_WORLD) FREE_TEXT_HINTS.push(`Use ${FORCED_WORLD} as the world.`);
if (FORCED_PERSONALITY) FREE_TEXT_HINTS.push(`Use ${FORCED_PERSONALITY} as the DM personality.`);
const FREE_TEXT_DEFAULT_ANSWER = FREE_TEXT_HINTS.length > 0
  ? `you decide. ${FREE_TEXT_HINTS.join(" ")}`
  : "you decide";
const PLAYER_FIRST_ACTION = "I look around to take stock of my surroundings.";

export const goldenPath: Scenario = {
  id: "golden-path",
  title: "New campaign → handoff → one full turn cycle",
  description:
    "Boot, create a campaign through the setup agent, wait for the first DM turn, " +
    "submit one player action, receive the DM's response. Hard-killed by the harness on exit.",
  live: true,
  approxMinutes: 6,

  async run(ctx) {
    await openMainMenu(ctx);
    await startNewCampaign(ctx);
    await walkSetupConversation(ctx);
    await waitForFirstDmTurn(ctx);
    await submitOnePlayerTurnAndAwaitResponse(ctx);
  },
};

// ---------------------------------------------------------------------------
// Phase 1: main menu
// ---------------------------------------------------------------------------

async function openMainMenu({ harness, log }: ScenarioContext): Promise<void> {
  log("Phase 1: main menu");
  await harness.waitForScreen("Machine Violet", { timeoutMs: DEFAULT_SHORT_TIMEOUT_MS });
  await harness.waitForScreen("New Campaign", { timeoutMs: DEFAULT_SHORT_TIMEOUT_MS });
  log("  Main menu rendered.");
}

// ---------------------------------------------------------------------------
// Phase 2: start the campaign (Enter on default-selected "New Campaign")
// ---------------------------------------------------------------------------

async function startNewCampaign({ harness, log }: ScenarioContext): Promise<void> {
  log("Phase 2: selecting 'New Campaign'");
  // The MainMenuPhase opens with index 0 = "New Campaign", so a bare Enter
  // is enough. (If a future change reorders the menu, this scenario will
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
}

// ---------------------------------------------------------------------------
// Phase 3: walk the setup conversation to handoff
// ---------------------------------------------------------------------------

async function walkSetupConversation({ harness, log }: ScenarioContext): Promise<void> {
  log("Phase 3: walking the setup-agent conversation");

  // The setup-agent leads. Each turn it either presents structured choices
  // (activeChoices populated) or asks for free text. We keep replying until
  // the campaign id flips off "__setup__" or transitionCampaignId is set
  // (handoff in progress). 20 turns is far above the canonical 5-10 turn
  // shape — exceeding it means something is wrong.
  // We use narrativeLines.length as the "agent acted" signal — it grows
  // monotonically as the DM streams. activeChoices is unreliable as an
  // acknowledgment signal because the setup agent sometimes leaves the
  // last choice overlay visible while asking a free-text follow-up.
  //
  // Initialize baseline at -1 so turn 1 fires immediately on whatever the
  // setup agent has already streamed by the time the setup turn opened.
  // Turn 2+ waits for further growth past the previous baseline.
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
        timeoutMs: DEFAULT_LONG_TIMEOUT_MS, // setup-agent turns can be slow on long context
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
      const pickIndex = pickSetupChoice(labels);
      log(`  Turn ${turn}: choice — picking #${pickIndex + 1} of ${labels.length}: ${JSON.stringify(labels[pickIndex])}`);
      submittedChoiceFingerprints.add(fp);
      await navigateToRealChoice(harness, pickIndex);
    } else {
      if (choiceIsStale) {
        log(`  Turn ${turn}: stale choice overlay still visible — falling through to free-text`);
      }
      log(`  Turn ${turn}: free-text — submitting ${JSON.stringify(FREE_TEXT_DEFAULT_ANSWER)}`);
      // When a stale overlay is visible, the InlineTextInput at index 0
      // ("Enter your own...") is the input target. The user navigates UP
      // to it then types. We send up to land on it, then submit text.
      if (choiceIsStale) await harness.sendKey("up");
      await harness.submitText(FREE_TEXT_DEFAULT_ANSWER);
    }
  }

  throw new Error(
    `Setup did not complete within ${MAX_SETUP_TURNS} turns. ` +
    `Either the agent is in a loop, or the harness's choice strategy is wrong.`,
  );
}

/**
 * Stable string fingerprint of a choice overlay. Used to detect when the
 * agent has re-presented an overlay we already acted on (a known
 * setup-agent quirk where it leaves the previous overlay visible while
 * asking a free-text follow-up).
 */
function choiceFingerprint(choices: import("../client-state.js").ActiveChoices): string {
  const labels = choices.choices.map((c) =>
    typeof c === "string" ? c : (c.label ?? c.text ?? ""),
  );
  return (choices.prompt ?? "") + "::" + labels.join("|");
}

/**
 * Pick a sensible default from the setup agent's choices. The agent rarely
 * offers a "Cancel" option, so the simplest reasonable strategy is "first
 * real choice." If that choice text looks dangerous (free-text input,
 * "Customize..."), skip it.
 *
 * When SMOKETEST_PERSONALITY is set and matches one of the offered labels,
 * prefer that label. (If it isn't offered, the hint embedded in
 * FREE_TEXT_DEFAULT_ANSWER still steers the setup agent toward it.)
 */
function pickSetupChoice(labels: string[]): number {
  for (const forced of [FORCED_WORLD, FORCED_PERSONALITY]) {
    if (!forced) continue;
    const desired = forced.toLowerCase();
    for (let i = 0; i < labels.length; i++) {
      if (labels[i].toLowerCase() === desired) return i;
    }
  }
  for (let i = 0; i < labels.length; i++) {
    const lower = labels[i].toLowerCase();
    // "Enter your own" is added by the UI at index 0; the server never sends
    // it, but be defensive in case future agents include similar.
    if (lower.includes("enter your own") || lower.includes("customize")) continue;
    return i;
  }
  return 0;
}

/**
 * Navigate the ChoiceOverlay to a specific real-choice index and submit it.
 *
 * The overlay opens with "Enter your own" at the UI's index 0, customInputActive
 * for short lists (<5 options) and false for longer ones. We normalize first:
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

// ---------------------------------------------------------------------------
// Phase 4: wait for the first DM turn (3-5 minutes, but watch state)
// ---------------------------------------------------------------------------

async function waitForFirstDmTurn({ harness, log }: ScenarioContext): Promise<void> {
  log("Phase 4: waiting for first DM turn (this can take 3-5 minutes)");

  // After session:transition, the engine restarts on the new campaign id.
  // The first DM turn typically streams in within a few minutes; we watch
  // for a turn whose campaignId is NOT "__setup__" and is open. (We may
  // arrive here already past handoff if walkSetupConversation observed the
  // transition itself.)
  const state = await harness.waitForState(
    (s) =>
      s.currentTurn !== null &&
      s.currentTurn.campaignId !== "__setup__" &&
      s.currentTurn.status === "open",
    {
      description: "first live player turn opens (campaignId != '__setup__')",
      timeoutMs: DEFAULT_LONG_TIMEOUT_MS, // 10-min ceiling
    },
  );
  log(`  First live player turn open (campaignId=${state.currentTurn?.campaignId}, ` +
      `seq=${state.currentTurn?.seq}). Narrative lines: ${state.narrativeLines.length}.`);
}

// ---------------------------------------------------------------------------
// Phase 5: submit one player turn, receive the DM's response
// ---------------------------------------------------------------------------

async function submitOnePlayerTurnAndAwaitResponse({ harness, log }: ScenarioContext): Promise<void> {
  log("Phase 5: submitting one player action");
  const before = await harness.getState();
  const baselineLines = before.narrativeLines.length;
  const baselineSeq = before.currentTurn?.seq ?? 0;

  log(`  Submitting: ${JSON.stringify(PLAYER_FIRST_ACTION)}`);
  await harness.submitText(PLAYER_FIRST_ACTION);

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

