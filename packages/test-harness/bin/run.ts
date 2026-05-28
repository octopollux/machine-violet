#!/usr/bin/env node
/**
 * CLI runner for end-to-end scenarios.
 *
 * Usage:
 *   node --import tsx/esm packages/test-harness/bin/run.ts <scenario-id>
 *   npm run e2e -- <scenario-id>
 *
 * Or from this package:
 *   tsx bin/run.ts golden-path
 *
 * On success, exits 0 and prints "OK <scenario>".
 * On failure, exits 1 and dumps:
 *   - the error and stack
 *   - the last 50 lines of the launcher's combined output
 *   - the most recent /state
 *   - the most recent /screen
 *
 * Pass `--stdio=inherit` to forward the launcher's stdout/stderr live —
 * useful when debugging a flaky scenario or watching tool activity.
 */
import { Harness } from "../src/harness.js";
import type { Scenario, ScenarioContext } from "../src/scenarios/types.js";
import { bootAndQuit } from "../src/scenarios/boot-and-quit.js";
import { goldenPath } from "../src/scenarios/golden-path.js";
import { imageSetup } from "../src/scenarios/image-setup.js";

const ALL_SCENARIOS: Scenario[] = [bootAndQuit, goldenPath, imageSetup];

function usage(): never {
  process.stderr.write(
    "Usage: mv-e2e <scenario-id> [--stdio=inherit|buffer|ignore] [--keep]\n\n" +
    "Available scenarios:\n" +
    ALL_SCENARIOS.map((s) => {
      const live = s.live ? " [live API]" : "";
      return `  ${s.id.padEnd(20)} (~${s.approxMinutes} min)${live}\n    ${s.description}`;
    }).join("\n") + "\n",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): { scenarioId: string; stdio: "inherit" | "buffer" | "ignore"; keep: boolean } {
  let scenarioId: string | undefined;
  let stdio: "inherit" | "buffer" | "ignore" = "buffer";
  let keep = false;
  for (const arg of argv) {
    if (arg === "--keep") keep = true;
    else if (arg.startsWith("--stdio=")) {
      const v = arg.slice("--stdio=".length);
      if (v === "inherit" || v === "buffer" || v === "ignore") stdio = v;
      else usage();
    }
    else if (!arg.startsWith("--")) scenarioId = arg;
    else usage();
  }
  if (!scenarioId) usage();
  return { scenarioId, stdio, keep };
}

async function main(): Promise<void> {
  const { scenarioId, stdio, keep } = parseArgs(process.argv.slice(2));
  const scenario = ALL_SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) {
    process.stderr.write(`Unknown scenario: ${scenarioId}\n`);
    usage();
  }

  process.stderr.write(`▶ ${scenario.title}\n  (${scenario.id}, ~${scenario.approxMinutes} min${scenario.live ? ", live API" : ""})\n`);

  const harness = await Harness.launch({ stdio });
  const log = (msg: string) => process.stderr.write(`  ${msg}\n`);
  const ctx: ScenarioContext = { harness, log };

  const start = Date.now();
  let failed = false;
  try {
    await scenario.run(ctx);
    const sec = ((Date.now() - start) / 1000).toFixed(1);
    process.stderr.write(`✔ OK ${scenario.id} (${sec}s)\n`);
  } catch (err) {
    failed = true;
    const sec = ((Date.now() - start) / 1000).toFixed(1);
    process.stderr.write(`✘ FAIL ${scenario.id} (${sec}s)\n`);
    process.stderr.write(`\n  Error: ${err instanceof Error ? err.message : String(err)}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(`\n  Stack:\n${err.stack.split("\n").map((l) => "    " + l).join("\n")}\n`);
    }
    process.stderr.write(`\n  Launcher tail (last 50 lines):\n`);
    process.stderr.write(harness.childLog.slice(-50).map((l) => "    " + l).join("\n") + "\n");
    try {
      const state = await harness.getState();
      process.stderr.write(`\n  /state:\n    ${JSON.stringify(state)}\n`);
    } catch { /* ignore */ }
    try {
      const screen = await harness.getScreen();
      process.stderr.write(`\n  /screen:\n${screen.split("\n").map((l) => "    " + l).join("\n")}\n`);
    } catch { /* ignore */ }
    // Engine log tail — surfaces structured events (image_gen:*, api:retry,
    // engine:error, ...) that the launcher's stdout/stderr never carries.
    try {
      const tail = harness.engineLogTail(80);
      if (tail) {
        process.stderr.write(`\n  Engine log tail (last 80 events):\n${tail.split("\n").map((l) => "    " + l).join("\n")}\n`);
      }
    } catch { /* ignore */ }
  } finally {
    await harness.shutdown({ cleanup: !keep });
    if (keep && harness.ownsCampaignsDir) {
      process.stderr.write(`  campaigns dir kept at: ${harness.campaignsDir}\n`);
    }
  }

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
