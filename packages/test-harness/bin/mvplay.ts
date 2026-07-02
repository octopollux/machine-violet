#!/usr/bin/env node
/**
 * mvplay — drive Machine Violet interactively, turn-for-turn.
 *
 * Unlike the one-shot probes (smoketest / boot-and-quit, which spawn the game,
 * run a scripted body, and kill it), mvplay keeps a *persistent* launcher +
 * sidecar running in the background so an agent — or a human — can read the
 * screen and submit one turn per command, across as many commands as the game
 * lasts.
 *
 * Typical loop:
 *   mvplay start                       # boot to the main menu
 *   mvplay key return                  # pick "New Campaign"
 *   mvplay wait                        # (run in background) settle on setup
 *   mvplay pick 1                      # answer a setup choice
 *   mvplay say "you decide"            # answer a free-text prompt
 *   ...                                # walk setup to handoff
 *   mvplay say "I shoulder the door open and step through"
 *   mvplay wait                        # (run in background) → prints the DM's reply
 *   mvplay stop                        # tear it down
 *
 * All read-back is over the sidecar's HTTP `/screen` + `/state`; there is no
 * stdin/stdout pipe to block on. `wait` polls until the game produces a new
 * beat, prints what's new, and exits — so run it with `run_in_background` and
 * let the harness re-invoke you when the DM is done.
 *
 * Run directly:  node --import tsx/esm packages/test-harness/bin/mvplay.ts <cmd> [args]
 * Or via npm:    npm run play -- <cmd> [args]
 */
import {
  start,
  screen,
  state,
  narrative,
  say,
  key,
  pick,
  wait,
  log,
  status,
  stop,
  saveTape,
} from "../src/session-driver.js";

const USAGE = `mvplay — interactive Machine Violet driver

Commands:
  start [--player NAME] [--fresh] [--live] [--data-dir PATH]
                                    Boot the game in the background, print the menu.
  record <scenario> [--player NAME] [--fresh] [--live] [--data-dir PATH]
                                    Like start, but tape every LLM call (MV_TAPE_MODE=record).
                                    Play the scenario, then \`save-tape\`.
  save-tape <path>                  Pull the recorded tape and write a golden to <path>.
  status                            Is a session alive? Show its vitals.
  screen [--ansi]                   Print the rendered terminal screen.
  state                             Print a compact state summary (engine/turn/choices).
  narrative [--all]                 Print new narrative since you last looked (--all = everything).
  say "<text>"                      Submit a player action / free-text answer + Enter.
  key <name>                        Send a key: return up down left right escape tab space ...
  pick <N|text>                     Select a choice by 1-based number or label substring.
  wait [--for beat|handoff|choices] [--timeout SEC]
                                    Block until a new beat lands, print it, exit. Run in background.
  log [--tail N]                    Tail the launcher log (crash diagnostics).
  stop                              Kill the session.

Notes:
  - One session at a time (under the system temp dir).
  - 'wait' is the slow one (a DM turn is 1-5 min). Launch it with run_in_background
    so you're re-invoked on exit instead of blocking a tool call.
  - By default you play in a throwaway temp campaigns dir (isolated, safe).
  - --live plays the user's REAL machine-scope campaigns; --data-dir PATH points
    at a custom data root (<PATH>/campaigns). ⚠️ Turns MUTATE real campaigns —
    never delete/overwrite/roll back one unless the user explicitly asked.
`;

function flag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Positional args = everything that isn't a --flag or a flag's value. */
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      // Skip a value for known value-taking flags.
      if (a === "--player" || a === "--for" || a === "--timeout" || a === "--tail" || a === "--data-dir") i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const pos = positionals(rest);

  switch (cmd) {
    case "start":
      await start({
        player: opt(rest, "player"),
        fresh: flag(rest, "fresh"),
        live: flag(rest, "live"),
        dataDir: opt(rest, "data-dir"),
      });
      break;
    case "record": {
      const scenario = pos[0];
      if (!scenario) throw new Error(`record needs a scenario name: mvplay record open-door`);
      await start({
        record: scenario,
        player: opt(rest, "player"),
        fresh: flag(rest, "fresh"),
        live: flag(rest, "live"),
        dataDir: opt(rest, "data-dir"),
      });
      break;
    }
    case "save-tape": {
      const out = pos[0];
      if (!out) throw new Error(`save-tape needs an output path: mvplay save-tape path/to/scene.golden.json`);
      await saveTape(out);
      break;
    }
    case "status":
      await status();
      break;
    case "screen":
      await screen(flag(rest, "ansi"));
      break;
    case "state":
      await state();
      break;
    case "narrative":
      await narrative({ all: flag(rest, "all") });
      break;
    case "say": {
      const text = pos.join(" ");
      if (!text) throw new Error(`say needs text: mvplay say "I open the door"`);
      await say(text);
      break;
    }
    case "key": {
      const name = pos[0];
      if (!name) throw new Error(`key needs a name: mvplay key return`);
      await key(name);
      break;
    }
    case "pick": {
      const query = pos.join(" ");
      if (!query) throw new Error(`pick needs a number or label: mvplay pick 1`);
      await pick(query);
      break;
    }
    case "wait": {
      const forRaw = opt(rest, "for");
      const forWhat = forRaw === "handoff" || forRaw === "choices" ? forRaw : "beat";
      const timeoutSec = opt(rest, "timeout") ? Number(opt(rest, "timeout")) : undefined;
      await wait({ for: forWhat, timeoutSec });
      break;
    }
    case "log":
      await log(opt(rest, "tail") ? Number(opt(rest, "tail")) : undefined);
      break;
    case "stop":
      await stop();
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      break;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  process.stderr.write(`✘ ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
