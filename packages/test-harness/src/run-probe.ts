/**
 * Shared launch + error-dump + shutdown wrapper for end-to-end probes.
 *
 * A "probe" is just an async function that drives a running Harness and
 * throws on failure. Each probe file is a standalone executable script
 * (no registry, no contract object) — typically a few lines that call
 * runProbe() with an inline body. The parent agent writing an ad-hoc
 * walk under any path can do the same.
 *
 * runProbe handles:
 *   - argv parsing (`--stdio=inherit|buffer|ignore`, `--keep`)
 *   - banner line ("▶ <title>")
 *   - Harness.launch
 *   - body invocation
 *   - on success: "✔ OK <name> (<n>s)"
 *   - on failure: "✘ FAIL <name> (<n>s)" + structured dump (error,
 *     stack, launcher tail, /state, /screen, engine-log tail)
 *   - harness.shutdown({ cleanup: !keep })
 *   - process.exit(0|1)
 *
 * Use it as:
 *
 *   await runProbe({
 *     name: "my-probe",
 *     title: "Short human-readable title",
 *     body: async ({ harness, log }) => { ... },
 *   });
 *
 * The body receives a launched Harness and a log() function that writes
 * indented progress lines to stderr.
 */
import { Harness } from "./harness.js";

export interface ProbeContext {
  harness: Harness;
  /** Write a progress line. Goes to stderr so it doesn't pollute stdout pipes. */
  log: (msg: string) => void;
}

export interface RunProbeOptions {
  /** Short stable id used in OK/FAIL lines. */
  name: string;
  /** Human-readable title printed in the banner. */
  title: string;
  /** The actual probe body. Throw to fail; return to pass. */
  body: (ctx: ProbeContext) => Promise<void>;
}

interface ParsedArgs {
  stdio: "inherit" | "buffer" | "ignore";
  keep: boolean;
  binary?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let stdio: "inherit" | "buffer" | "ignore" = "buffer";
  let keep = false;
  let binary: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--keep") keep = true;
    else if (arg === "--binary") {
      binary = argv[++i];
      if (!binary) fail("--binary requires a path");
    } else if (arg.startsWith("--stdio=")) {
      const v = arg.slice("--stdio=".length);
      if (v === "inherit" || v === "buffer" || v === "ignore") stdio = v;
      else fail(`Unknown --stdio value: ${v}`);
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      fail(`Unknown arg: ${arg}`);
    }
  }
  return { stdio, keep, binary };
}

function printUsage(): void {
  process.stderr.write(
    "Usage: <probe-script> [--stdio=inherit|buffer|ignore] [--keep] [--binary <path>]\n\n" +
    "  --stdio=inherit  forward launcher stdout/stderr live (debugging)\n" +
    "  --stdio=buffer   capture to memory (default; dump on failure)\n" +
    "  --stdio=ignore   drop launcher output entirely\n" +
    "  --keep           don't clean up the tmp campaigns dir on exit\n" +
    "  --binary <path>  drive the PACKAGED binary (the installed/portable exe)\n" +
    "                   instead of the from-source launcher. The exe is compiled,\n" +
    "                   so it resolves its config dir the real way (%APPDATA%\\\n" +
    "                   MachineViolet) and uses your actual saved connections —\n" +
    "                   which is the point: it proves the shipped artifact works,\n" +
    "                   not just the source tree. Campaigns still go to a temp dir.\n",
  );
}

function fail(message: string): never {
  process.stderr.write(`${message}\n\n`);
  printUsage();
  process.exit(2);
}

/**
 * Launch a Harness, run the probe body, dump diagnostics on failure,
 * shut down cleanly, and exit with 0 (pass) or 1 (fail). Intended to be
 * the entire body of a standalone probe script:
 *
 *   await runProbe({ name, title, body: async ({ harness, log }) => { ... } });
 */
export async function runProbe(opts: RunProbeOptions): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  process.stderr.write(`▶ ${opts.title}\n  (${opts.name})\n`);

  const harness = await Harness.launch({
    stdio: args.stdio,
    ...(args.binary ? { executable: { command: args.binary } } : {}),
  });
  const log = (msg: string) => process.stderr.write(`  ${msg}\n`);
  const ctx: ProbeContext = { harness, log };

  const start = Date.now();
  let failed = false;
  try {
    await opts.body(ctx);
    const sec = ((Date.now() - start) / 1000).toFixed(1);
    process.stderr.write(`✔ OK ${opts.name} (${sec}s)\n`);
  } catch (err) {
    failed = true;
    const sec = ((Date.now() - start) / 1000).toFixed(1);
    process.stderr.write(`✘ FAIL ${opts.name} (${sec}s)\n`);
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
    await harness.shutdown({ cleanup: !args.keep });
    if (args.keep && harness.ownsCampaignsDir) {
      process.stderr.write(`  campaigns dir kept at: ${harness.campaignsDir}\n`);
    }
  }

  process.exit(failed ? 1 : 0);
}
