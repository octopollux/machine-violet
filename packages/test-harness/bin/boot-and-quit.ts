#!/usr/bin/env node
/**
 * Boot-and-quit probe: the cheapest end-to-end smoke probe.
 *
 * Proves:
 *   - Launcher spins up server + client without crashing
 *   - Agent sidecar HTTP serves /state and /screen
 *   - Main menu renders and is visible in /screen
 *   - Process tears down cleanly on shutdown
 *
 * No LLM API calls. Runs in ~10 seconds. The precondition for every
 * other probe — if this fails, nothing else can pass.
 *
 * Run with:
 *   npm run e2e:boot
 *   or: node --import tsx/esm packages/test-harness/bin/boot-and-quit.ts
 */
import { runProbe } from "../src/run-probe.js";

await runProbe({
  name: "boot-and-quit",
  title: "Boot to main menu and exit (~10s, no API key)",
  body: async ({ harness, log }) => {
    log("Waiting for main menu to render...");
    await harness.waitForScreen("Machine Violet", { timeoutMs: 15_000 });
    log("Title bar rendered.");

    // The menu items are local React state, not in ClientState — confirm via screen.
    await harness.waitForScreen("New Campaign", { timeoutMs: 15_000 });
    log("Menu visible: 'New Campaign' present.");
  },
});
