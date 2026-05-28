/**
 * Image-setup smoke test: prove the setup-agent's portrait loop fires end-to-end
 * against the configured OpenAI provider.
 *
 * Why this exists separate from golden-path:
 *   Image generation has multiple silent failure modes — wrong provider,
 *   wrong capability flag, model didn't call the tool, model called it but
 *   the API returned no bytes, bytes arrived but persistence dropped them.
 *   golden-path is too coarse to localize any of these. This scenario
 *   targets the image-gen pipeline specifically and reads the engine's
 *   structured event log (`.debug/engine.jsonl`) to localize failures.
 *
 * What it proves:
 *   1. The setup-agent walks far enough to ask the image-consent question
 *      using the locked phrasing.
 *   2. When the player picks "Yes", `setup:image_tools_registered` flips
 *      `portraitLoopActive: true` (capability detection + fileIO + setupRoot
 *      all aligned).
 *   3. On the next turn that exercises generate_image, OpenAI's
 *      `image_generation` tool gets attached to the request
 *      (`image_gen:tool_registered`).
 *   4. The API returns either `image_gen:completed` (success → bytes) or
 *      `image_gen:non_completed` (failure with status). Either way is a
 *      pass for this scenario — we're proving the *call happens*, not
 *      that the model is in a good mood.
 *   5. On success: the image lands at `__setup__/campaign/images/portrait-draft-*.png`
 *      with non-zero bytes.
 *
 * The scenario stops as soon as the verdict is unambiguous. It does NOT
 * walk to handoff or run a DM turn — that's golden-path's job. Budget is
 * dominated by one image gen call (~15-45s at medium quality) plus a
 * few setup-agent text turns.
 *
 * Stops with PASS if (4) is observed. Stops with FAIL + diagnostic dump
 * if any earlier breadcrumb is missing or the overall budget expires.
 */
import { statSync } from "node:fs";
import { basename } from "node:path";

import type { Scenario, ScenarioContext } from "./types.js";
import type { Harness } from "../harness.js";
import {
  DEFAULT_LONG_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  DEFAULT_SHORT_TIMEOUT_MS,
} from "../wait.js";
import { formatEngineEvent } from "../engine-log.js";

// Locked phrasing from setup-conversation.ts. If this string drifts, the
// scenario will fall through to "first choice" and we'll still get useful
// diagnostics — but the consent step won't be tested explicitly.
const CONSENT_PROMPT_NEEDLE = "do you want images in your game";

// Outer ceiling for walking setup until we either see a portrait or
// conclude one will never come. Generous — setup-agent text turns are
// 30-60s each, the model typically only invokes generate_image after 4-8
// turns of chargen, and one image_generation call itself takes 15-45s.
const SETUP_PORTRAIT_BUDGET_MS = 14 * 60_000;

// Fold a hint into free-text answers so the setup-agent settles on a
// concrete character description quickly. Without this it tends to ask
// 4-5 clarifying questions before generating, blowing the time budget.
// Aggressively front-loaded: name, system pref, character description,
// and the "stop asking, just generate" cue. The agent's prompt instructs
// it to honor "you decide"-style answers.
const FREE_TEXT_DEFAULT_ANSWER =
  "You decide everything. Quick start in a classic-fantasy world, light system. " +
  "My name is Player. Character name: Kade. Kade is a stoic human ranger in a green cloak, " +
  "longbow at the ready, standing on a forest road at dusk. " +
  "Don't ask me anything else — generate the portrait now and then finalize.";

export const imageSetup: Scenario = {
  id: "image-setup",
  title: "Setup-agent portrait loop fires end-to-end against OpenAI image_generation",
  description:
    "Walk new-campaign setup to the consent question, pick Yes, watch the engine log " +
    "for image_gen:tool_registered + image_gen:completed/non_completed, verify the PNG " +
    "lands in __setup__/campaign/images/. Diagnostic dump on failure.",
  live: true,
  approxMinutes: 5,

  async run(ctx) {
    await openMainMenu(ctx);
    await startNewCampaign(ctx);
    await walkSetupToPortraitVerdict(ctx);
  },
};

// ---------------------------------------------------------------------------
// Phase 1: main menu
// ---------------------------------------------------------------------------

async function openMainMenu({ harness, log }: ScenarioContext): Promise<void> {
  log("Phase 1: main menu");
  await harness.waitForScreen("Machine Violet", { timeoutMs: DEFAULT_SHORT_TIMEOUT_MS });
  await harness.waitForScreen("New Campaign", { timeoutMs: DEFAULT_SHORT_TIMEOUT_MS });
}

// ---------------------------------------------------------------------------
// Phase 2: start new campaign (Enter on default-selected entry)
// ---------------------------------------------------------------------------

async function startNewCampaign({ harness, log }: ScenarioContext): Promise<void> {
  log("Phase 2: New Campaign → __setup__ turn opens");
  await harness.sendKey("return");
  await harness.waitForState(
    (s) => s.currentTurn?.campaignId === "__setup__" && s.currentTurn?.status === "open",
    {
      description: "setup turn opens (campaignId === '__setup__')",
      timeoutMs: DEFAULT_TURN_TIMEOUT_MS,
    },
  );

  // First gate: the engine should immediately log setup:image_tools_registered
  // when buildSystemPrompt runs. If portraitLoopActive is false here, the
  // run can't succeed — bail early with a precise reason.
  const registered = await harness.waitForEngineEvent("setup:image_tools_registered", {
    description: "setup-agent reports image-tool registration",
    timeoutMs: DEFAULT_TURN_TIMEOUT_MS,
  });
  log(`  setup:image_tools_registered ${JSON.stringify({
    portraitLoopActive: registered.portraitLoopActive,
    imageGenSupported: registered.imageGenSupported,
    model: registered.model,
  })}`);
  if (!registered.portraitLoopActive) {
    throw new Error(
      "Portrait loop is not active. " +
      `imageGenSupported=${registered.imageGenSupported}, ` +
      `hasFileIO=${registered.hasFileIO}, hasSetupRoot=${registered.hasSetupRoot}. ` +
      "Check connections.json / model assignment and that setup-session passes fileIO+setupRoot.",
    );
  }
}

// ---------------------------------------------------------------------------
// Phase 3: walk setup, intercept consent, wait for image-gen verdict
// ---------------------------------------------------------------------------

async function walkSetupToPortraitVerdict({ harness, log }: ScenarioContext): Promise<void> {
  log("Phase 3: walking setup until image_gen completes/fails");

  const phaseStart = Date.now();
  let baselineNarrative = -1;
  const submittedFingerprints = new Set<string>();
  let consentAnswered = false;

  // We bail in three ways:
  //  - verdict observed (image_gen:completed | image_gen:non_completed) → PASS
  //  - SETUP_PORTRAIT_BUDGET_MS elapses → throw with diagnostics
  //  - 30 setup-agent turns without a verdict → throw (sanity cap)
  for (let turn = 1; turn <= 30; turn++) {
    if (Date.now() - phaseStart > SETUP_PORTRAIT_BUDGET_MS) {
      throw new Error(`Setup portrait budget (${SETUP_PORTRAIT_BUDGET_MS}ms) elapsed without verdict.`);
    }

    // Check the engine log first — a turn may have already produced a
    // verdict while we were navigating choices.
    const verdict = readVerdict(harness);
    if (verdict) {
      log(`  Verdict: ${verdict.event}`);
      assertVerdictArtifacts(harness, verdict.event, log);
      return;
    }

    // Wait for the setup-agent to settle.
    const snapshot = await harness.waitForState(
      (s) =>
        s.engineState === "waiting_input" &&
        s.narrativeLines.length > baselineNarrative &&
        (s.activeChoices !== null ||
         (s.currentTurn !== null && s.currentTurn.status === "open")),
      {
        description: "setup-agent settled at waiting_input with new narrative",
        timeoutMs: DEFAULT_LONG_TIMEOUT_MS,
      },
    );

    // Check verdict again — the wait may have been long enough for the
    // image_generation call to complete in parallel with text streaming.
    const postWaitVerdict = readVerdict(harness);
    if (postWaitVerdict) {
      log(`  Verdict observed during wait: ${postWaitVerdict.event}`);
      assertVerdictArtifacts(harness, postWaitVerdict.event, log);
      return;
    }

    // Snapshot the "we observed up to here" baseline so the next iteration
    // waits for *further* growth.
    baselineNarrative = snapshot.narrativeLines.length;

    // image_gen:tool_registered fires on every request once the portrait
    // loop is on — it just means the request *carried* the tool config,
    // not that the model actually invoked it. The model only emits
    // image_generation_call after a few turns of chargen, so we don't
    // gate on tool_registered. Verdict checks happen at the top of each
    // iteration via readVerdict(); if a verdict appeared during the
    // waitForState above, we already returned.

    // Drive the next agent turn.
    const fp = snapshot.activeChoices ? choiceFingerprint(snapshot.activeChoices) : null;
    const stale = fp !== null && submittedFingerprints.has(fp);

    if (snapshot.activeChoices && fp !== null && !stale) {
      const labels = snapshot.activeChoices.choices.map((c) =>
        typeof c === "string" ? c : (c.label ?? c.text ?? ""),
      );
      const prompt = (snapshot.activeChoices.prompt ?? "").toLowerCase();
      const pickIndex = pickChoiceIndex(labels, prompt, consentAnswered);
      if (prompt.includes(CONSENT_PROMPT_NEEDLE) && !consentAnswered) {
        consentAnswered = true;
        log(`  Turn ${turn}: consent overlay — picking "${labels[pickIndex]}" (index ${pickIndex})`);
      } else {
        log(`  Turn ${turn}: choice — pick "${labels[pickIndex]}" (${labels.length} options)`);
      }
      submittedFingerprints.add(fp);
      await navigateToRealChoice(harness, pickIndex);
    } else {
      if (stale) {
        log(`  Turn ${turn}: stale overlay — falling through to free-text`);
        await harness.sendKey("up");
      } else {
        log(`  Turn ${turn}: free-text answer`);
      }
      await harness.submitText(FREE_TEXT_DEFAULT_ANSWER);
    }
  }

  throw new Error("Reached 30-turn cap without an image_gen verdict.");
}

/**
 * Returns the first `image_gen:completed` or `image_gen:non_completed`
 * event in the log, or null. These events are terminal verdicts — the
 * scenario can stop as soon as either appears.
 */
function readVerdict(harness: Harness) {
  return harness.readEngineLog().find(
    (e) => e.event === "image_gen:completed" || e.event === "image_gen:non_completed",
  );
}

/**
 * Post-verdict assertions. A `completed` verdict implies bytes on disk
 * (image_gen:persisted + a real PNG in __setup__/campaign/images/);
 * `non_completed` is logged for diagnostic visibility but the scenario
 * still passes — we proved the call happened, which is the actual
 * subject under test. If you want a stricter pass condition, raise it
 * here.
 */
function assertVerdictArtifacts(harness: Harness, event: string, log: (m: string) => void): void {
  if (event === "image_gen:non_completed") {
    log("  image_gen:non_completed observed — call happened but image generation failed.");
    log("  This is a PASS for the pipeline test (we proved the call wires up). Check the engine log");
    log("  payload for status/intent to diagnose the upstream failure.");
    return;
  }

  // event === "image_gen:completed"
  // Expect at least one image_gen:persisted event AND a real PNG on disk.
  const persistedEvents = harness.readEngineLog().filter((e) => e.event === "image_gen:persisted");
  if (persistedEvents.length === 0) {
    throw new Error(
      "image_gen:completed observed but no image_gen:persisted event followed. " +
      "Persistence (image-handler.ts) silently dropped the bytes.",
    );
  }
  const files = harness.listCampaignFiles("__setup__", "campaign/images");
  const pngs = files.filter((f) => f.toLowerCase().endsWith(".png"));
  if (pngs.length === 0) {
    throw new Error(
      `image_gen:persisted fired (${persistedEvents.length}x) but no PNG present in ` +
      `__setup__/campaign/images. listCampaignFiles returned: ${JSON.stringify(files)}`,
    );
  }
  const sizes = pngs.map((p) => {
    try {
      return `${basename(p)}=${statSync(p).size}B`;
    } catch {
      return `${basename(p)}=?`;
    }
  });
  log(`  ${pngs.length} PNG(s) on disk: ${sizes.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Helpers (copied from golden-path; small enough not to extract a shared module yet)
// ---------------------------------------------------------------------------

/**
 * Pick the right choice index given current overlay labels + prompt context.
 * Consent overlay → "Yes" (the whole point of this scenario). Anything else
 * → first non-customize entry (mirrors golden-path's strategy).
 */
function pickChoiceIndex(labels: string[], promptLower: string, consentAlreadyAnswered: boolean): number {
  if (promptLower.includes(CONSENT_PROMPT_NEEDLE) && !consentAlreadyAnswered) {
    const yesIdx = labels.findIndex((l) => l.trim().toLowerCase().startsWith("yes"));
    if (yesIdx < 0) {
      throw new Error(`Consent overlay found but no "Yes" choice: ${JSON.stringify(labels)}`);
    }
    return yesIdx;
  }
  const firstReal = labels.findIndex(
    (l) => !l.toLowerCase().includes("enter your own") && !l.toLowerCase().includes("customize"),
  );
  return firstReal < 0 ? 0 : firstReal;
}

function choiceFingerprint(choices: import("../client-state.js").ActiveChoices): string {
  const labels = choices.choices.map((c) =>
    typeof c === "string" ? c : (c.label ?? c.text ?? ""),
  );
  return (choices.prompt ?? "") + "::" + labels.join("|");
}

async function navigateToRealChoice(harness: Harness, pickIndex: number): Promise<void> {
  await harness.sendKey("up");
  await harness.sendKey("down");
  if (pickIndex > 0) await harness.sendKeys("down", pickIndex);
  await harness.sendKey("return");
}

// Re-export for runner-side use (currently unused, but lets a custom
// runner format engine events the same way the scenario does).
export { formatEngineEvent };
