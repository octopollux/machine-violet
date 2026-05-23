/**
 * Boot-and-quit: the cheapest smoke test.
 *
 * Proves:
 *   - Launcher spins up server + client without crashing
 *   - Agent sidecar HTTP serves /state and /screen
 *   - Main menu renders and is visible in /screen
 *   - Process tears down cleanly on shutdown
 *
 * No LLM API calls. Runs in ~10 seconds. Use this as the precondition for
 * everything else — if it fails, no other scenario can pass.
 */
import type { Scenario } from "./types.js";

export const bootAndQuit: Scenario = {
  id: "boot-and-quit",
  title: "Boot to main menu and exit",
  description: "Launches the full stack, confirms the main menu renders, and shuts down. No LLM calls.",
  live: false,
  approxMinutes: 0.5,

  async run({ harness, log }) {
    log("Waiting for main menu to render...");
    await harness.waitForScreen("Machine Violet", { timeoutMs: 15_000 });
    log("Title bar rendered.");

    // The menu items are local React state, not in ClientState — confirm via screen.
    await harness.waitForScreen("New Campaign", { timeoutMs: 15_000 });
    log("Menu visible: 'New Campaign' present.");
  },
};
