#!/usr/bin/env node
/**
 * replay-golden — replay full-stack golden tape(s) against a running
 * MachineViolet and assert the DM narration matches. The deterministic
 * packaged-artifact gate.
 *
 *   # from source (dev):
 *   node --import tsx/esm packages/test-harness/bin/replay-golden.ts \
 *     packages/test-harness/goldens/*.golden.json
 *
 *   # against the packaged binary (CI, after build):
 *   node --import tsx/esm packages/test-harness/bin/replay-golden.ts \
 *     packages/test-harness/goldens/*.golden.json --binary /path/to/MachineViolet
 *
 * Exits 0 if every golden replays identically, 1 on any mismatch/error.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { replayGolden, normalizeNarrative, type ReplayOptions } from "../src/replay-runner.js";
import type { FullStackGolden } from "../src/golden.js";

/** Default corpus: every *.golden.json under packages/test-harness/goldens/. */
const GOLDENS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "goldens");

function parseArgs(argv: string[]): { paths: string[]; binary?: string } {
  const paths: string[] = [];
  let binary: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--binary") { binary = argv[++i]; continue; }
    paths.push(argv[i]);
  }
  return { paths, binary };
}

async function main(): Promise<void> {
  const { paths: argPaths, binary } = parseArgs(process.argv.slice(2));
  // No explicit paths → replay the whole goldens corpus (the CI gate form).
  const paths = argPaths.length > 0
    ? argPaths
    : readdirSync(GOLDENS_DIR).filter((f) => f.endsWith(".golden.json")).map((f) => join(GOLDENS_DIR, f));
  if (paths.length === 0) {
    process.stderr.write("no goldens found (usage: replay-golden [golden.json...] [--binary <path>])\n");
    process.exit(2);
  }

  const opts: ReplayOptions = binary ? { executable: { command: binary } } : {};
  let failures = 0;

  for (const path of paths) {
    const golden = JSON.parse(readFileSync(path, "utf8")) as FullStackGolden;
    process.stdout.write(
      `▶ ${golden.scenario}: ${golden.inputs.length} inputs, ${golden.expectedNarrative.length} dm lines ` +
      `${binary ? `against ${binary}` : "from source"}\n`,
    );
    const res = await replayGolden(golden, opts);
    if (res.ok) {
      process.stdout.write(`  ✔ PASS — narrative matched (${res.actual.length} dm lines)\n`);
    } else {
      failures++;
      if (res.error) process.stdout.write(`  ✘ FAIL — ${res.error}\n`);
      else process.stdout.write(`  ✘ FAIL — narrative diverged (normalized char ${res.divergeAt}; ${res.expected.length} vs ${res.actual.length} dm lines)\n`);
      if (res.divergeAt >= 0) {
        const exp = normalizeNarrative(res.expected);
        const act = normalizeNarrative(res.actual);
        const at = res.divergeAt;
        process.stdout.write(`    expected …${JSON.stringify(exp.slice(Math.max(0, at - 40), at + 40))}\n`);
        process.stdout.write(`    actual   …${JSON.stringify(act.slice(Math.max(0, at - 40), at + 40))}\n`);
      }
      if (res.childLogTail) {
        process.stdout.write("    child log tail:\n" + res.childLogTail.split("\n").map((l) => "      " + l).join("\n") + "\n");
      }
    }
  }

  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`✘ ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
