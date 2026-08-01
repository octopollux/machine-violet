#!/usr/bin/env node
/**
 * campaign-identity-probe — does per-campaign UI state survive "exit to menu"?
 *
 * The walk (all offline: tape replay, no API key, no network):
 *   1. replay the quickstart golden → a real campaign on disk ("Heirloom",
 *      played by "Kestrel")
 *   2. exit to menu
 *   3. Continue Campaign → resume it FROM DISK  → the frame must name it
 *   4. exit to menu
 *   5. New Campaign → the setup conversation must NOT be labelled with the
 *      campaign we just left
 *
 * Step 5 is the regression: setup runs inside `PlayingPhase` and never
 * receives a `state:snapshot`, so whatever the previous session left behind in
 * `app.tsx` is what the frame labels itself with. Before the fix, the top
 * frame and the modeline both read "Heirloom" (or its slug, on a cold start)
 * through the whole of the next campaign's setup conversation.
 *
 *   node --import tsx/esm packages/test-harness/bin/campaign-identity-probe.ts
 *
 * ~4 minutes, dominated by the golden replay. `--keep` leaves the temp
 * campaigns dir behind; `--stdio=inherit` shows the launcher's output.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { runProbe } from "../src/run-probe.js";
import { replayInputs } from "../src/replay-runner.js";
import type { FullStackGolden } from "../src/golden.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The campaign the quickstart golden builds, and the character who plays it.
 * Re-recording that golden changes them — the probe fails loudly with the
 * screen attached, so update these three constants to match the new tape.
 */
const CAMPAIGN_NAME = "Heirloom";
const CAMPAIGN_SLUG = "heirloom";
const CHARACTER_NAME = "Kestrel";

const golden = JSON.parse(
  readFileSync(join(HERE, "..", "goldens", "fullstack-quickstart.golden.json"), "utf-8"),
) as FullStackGolden;

// Tape + throwaway config dir, so the whole walk runs offline.
const work = await mkdtemp(join(tmpdir(), "mv-campaign-identity-"));
const tapePath = join(work, "tape.json");
const configDir = join(work, "config");
await writeFile(tapePath, JSON.stringify(golden.tape) + "\n");
await mkdir(configDir, { recursive: true });

function assertScreen(
  screen: string,
  expect: { contains?: string[]; absent?: string[] },
  where: string,
): void {
  for (const needle of expect.contains ?? []) {
    if (!screen.includes(needle)) {
      throw new Error(
        `${where}: expected the screen to contain ${JSON.stringify(needle)}.\n--- screen ---\n${screen}`,
      );
    }
  }
  for (const needle of expect.absent ?? []) {
    if (screen.includes(needle)) {
      throw new Error(
        `${where}: ${JSON.stringify(needle)} leaked in from the previous campaign.\n--- screen ---\n${screen}`,
      );
    }
  }
}

await runProbe({
  name: "campaign-identity",
  title: "Campaign identity does not survive exit-to-menu",
  launch: {
    env: {
      MV_E2E: "1",
      MV_TAPE_MODE: "replay",
      MV_TAPE_PATH: tapePath,
      MV_CONFIG_DIR: configDir,
    },
    player: "TestPlayer",
  },
  body: async ({ harness, log }) => {
    // The synthetic E2E connection unlocks "New Campaign" in the menu.
    await harness.waitForScreen("New Campaign", { timeoutMs: 30_000, description: "main menu" });

    log("replaying the quickstart golden to build a campaign...");
    await replayInputs(harness, golden.inputs);

    const exitToMenu = async () => {
      // Same client path as Esc → Return to Menu, without the keystroke nav.
      await harness.endSession();
      await harness.waitForScreen("New Campaign", { timeoutMs: 60_000, description: "main menu" });
      await delay(1_000);
    };

    log("exit to menu, then resume the campaign from disk...");
    await exitToMenu();
    await harness.sendKey("down");     // New Campaign → Continue Campaign
    await delay(150);
    await harness.sendKey("return");   // expand the campaign sub-list
    await delay(300);
    await harness.sendKey("return");   // resume the first campaign
    await harness.waitForEngineState("waiting_input", { timeoutMs: 120_000 });
    await delay(1_500);
    assertScreen(await harness.getScreen(), { contains: [CAMPAIGN_NAME] }, "resumed campaign");

    log("exit to menu, then start a NEW campaign...");
    await exitToMenu();
    await harness.sendKeys("up", 3);   // back to "New Campaign"
    await delay(150);
    await harness.sendKey("return");
    // The setup conversation opens with the MC asking for the player's name.
    await harness.waitForScreen("what should I call you", {
      timeoutMs: 120_000,
      description: "setup conversation",
    });
    await delay(1_500);

    assertScreen(
      await harness.getScreen(),
      { absent: [CAMPAIGN_NAME, CAMPAIGN_SLUG, CHARACTER_NAME] },
      "new-campaign setup",
    );
  },
});
