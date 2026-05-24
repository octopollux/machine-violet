# End-to-End Test Harness

The end-to-end (e2e) test harness drives the full Machine Violet stack like a
human player: launches the engine server, mounts the Ink TUI client, drives
it via the agent sidecar's HTTP endpoints, and asserts on observed state
transitions. It exists so coding agents can prove a long-running task
*actually works* without asking the developer to smoke-test.

The harness lives in [`packages/test-harness`](../packages/test-harness/).

## Why use it

You're a coding agent that just finished a change that touches UI flow,
session lifecycle, the setup agent, the DM loop, or any code path that
spans server + client + WebSocket. Type checks and unit tests can't prove
the flow works end-to-end. **Run a scenario before reporting the task
complete.**

The harness is the only honest "did I break it?" signal for cross-cutting
changes.

## The golden path

Every smoke run does this at minimum. See [`golden-path.ts`](../packages/test-harness/src/scenarios/golden-path.ts).

1. Boot to the main menu.
2. Select "New Campaign" and enter the setup-agent conversation.
3. Walk the setup conversation by picking the first real choice at every
   `present_choices` overlay and submitting "you decide" for any free-text
   prompts.
4. Wait for the setup → live campaign handoff. The first DM turn arrives
   3-5 minutes later. The harness watches `engineState`,
   `currentTurn.campaignId`, `currentTurn.status`, and
   `transitionCampaignId` — it never relies on a wall-clock sleep.
5. Submit one player action.
6. Wait for the DM's response turn to complete (`narrativeLines` grew +
   `engineState === "waiting_input"`).

Then the harness hard-kills its launcher subprocess. **Save & Exit
is intentionally not part of the golden path** — it would burn a Haiku
call on the session-recap subagent every smoke run, and save-on-exit is
already covered by unit tests on `session-manager`. If you need to
validate that flow specifically, write a dedicated scenario.

Approximate wall-clock: 5-7 minutes. Uses real LLM API calls.

## Available scenarios

| ID | Live API? | ~Time | What it proves |
|---|---|---|---|
| `boot-and-quit` | no | ~10 s | Launcher boots, sidecar reachable, main menu renders, process tears down cleanly. The precondition for every other scenario. |
| `golden-path` | **yes** | 5-7 min | The full new-campaign → first DM turn → player turn cycle described above. Hard-killed on exit; Save & Exit is deliberately skipped. |

Add more scenarios in `packages/test-harness/src/scenarios/`. See "Writing a
scenario" below.

## Running

The canonical handle is the **`/smoketest` skill** (`.claude/skills/smoketest/`):

```
/smoketest                  # golden-path (default)
/smoketest boot-and-quit    # the cheap precondition
/smoketest <scenario-id>    # any scenario from packages/test-harness/src/scenarios/
```

Agents invoke the same skill via the Skill tool when validating cross-cutting work. Under the hood, it calls these npm scripts — which you can also run directly:

```bash
# Quick precondition — no API key needed:
npm run e2e:boot

# The full smoke baseline:
npm run e2e:golden-path

# Or, generally:
npm run e2e -- <scenario-id> [--stdio=inherit|buffer|ignore] [--keep]
```

Flags:
- `--stdio=inherit` pipes the launcher's stdout/stderr to your terminal
  live. Useful when debugging a stuck or flaky scenario.
- `--keep` skips cleanup of the temporary campaigns directory. The path
  is logged at shutdown so you can poke around in the resulting campaign
  files.

On success: exit 0, single-line `✔ OK <scenario>` summary.

### Worktree-friendly credentials

The launcher's `configDir()` is `process.cwd()` in dev mode — and the engine
reads `connections.json` and `.env` from there. The harness walks up from
the worktree until it finds the first ancestor that contains a
`connections.json`, then uses that as cwd. A worktree without any
credentials can therefore still run the live golden path without copying
secrets in. If no `connections.json` exists anywhere in the ancestry, the
launcher will boot to a "No AI connections configured" menu and the
golden path will fail in Phase 2 with a clear timeout — fix by running
the normal client once on this machine and configuring an API key.

Embedded shells (Claude Code, some CI runners) pre-set `ANTHROPIC_API_KEY=""`
to sandbox subprocesses. The engine uses `dotenv` without
`override: true`, so an empty pre-existing value blocks `.env` from
populating the real key. To unbreak the live scenario in those shells,
the harness explicitly parses the configDir's `.env` and injects any
`*_API_KEY` / `*_BASE_URL` values into the spawn env (only when the
target var is missing or empty — explicitly-set values are respected).
Outside such shells this is a no-op.

On failure: exit 1, plus a dump containing:
- the error and stack trace,
- the last 50 lines of the launcher's combined output,
- the most recent `/state` JSON,
- the most recent `/screen` text frame.

That dump is designed to be pasted into a bug report or read by another
agent without any further investigation.

## Architecture

```
┌──────────────────┐
│ Harness          │ ──spawn──▶ node scripts/launcher.ts
│ (Node test       │              ├── engine server (Fastify, REST + WS)
│  process)        │              └── Ink TUI client + agent sidecar
│                  │                    └── HTTP server on MV_AGENT_PORT
│ ──HTTP──────────────────────────────▶  GET /screen, /state, POST /input(/key)
│ ◀──JSON / text───────────────────────────────────────
└──────────────────┘
```

The harness launches the same `scripts/launcher.ts` that real users invoke
via `npm run dev`. The launcher sees `MV_AGENT_PORT` and starts the
sidecar inside the client process. The sidecar:

1. Wraps `process.stdout.write` to mirror every byte into an `@xterm/headless`
   virtual terminal (so `/screen` returns a faithful 2D buffer).
2. Exposes the live `ClientState` (the same object the UI reads) at `/state`.
3. Routes posted keystrokes into the client's stdin so Ink's `useInput`
   receives them exactly as if a human had typed.

The sidecar tee MUST be installed before Ink first renders, and Ink MUST
be told `interactive: true` in headless mode, or the vterm captures nothing.
Both gotchas are now wired into [`packages/client-ink/src/start-client.ts`](../packages/client-ink/src/start-client.ts).

## State-driven waiting (no naive sleeps)

The harness never sleeps for a fixed duration to wait for an LLM response.
Every wait is anchored to an observable state change in `ClientState`:

| Helper | What it waits for |
|---|---|
| `waitForEngineState(name)` | `engineState` enters one of the named values |
| `waitForMode(mode)` | `mode` flips to `"setup"`, `"play"`, etc. |
| `waitForChoices()` | `activeChoices` becomes non-null |
| `waitForChoicesCleared()` | `activeChoices` goes back to null after a selection |
| `waitForNarrativeAtLeast(n)` | `narrativeLines.length >= n` |
| `waitForState(predicate)` | Generic — any condition on the snapshot |
| `waitForScreen(needle)` | Fallback when state doesn't reflect what we need (mostly main-menu navigation) |

Each helper accepts a `timeoutMs` (default 10 s; long DM turns get 600 s).
The timeout exists only to guarantee the scenario fails rather than hangs;
the wait returns as soon as the state transition is observed. Pollers
sample at 200 ms by default.

When a wait times out, the harness throws a `TimeoutError` containing the
description, elapsed milliseconds, and the last sample observed. The CLI
runner dumps that plus the screen and child log.

## Engine-state surprises (read before writing a scenario)

These are non-obvious facts about how `ClientState` actually moves during gameplay. Each one cost a failed live run to discover — assume the next one will too if you don't read this.

**`mode` does NOT flip to `"setup"` during campaign creation.** The engine broadcasts `session:mode` events only when entering/exiting OOC and Dev modes. During the setup-agent conversation, `mode` stays `"play"`. The signal that you're in setup is `currentTurn.campaignId === "__setup__"` (a synthetic campaign id used for the setup session). When the live campaign starts, `currentTurn.campaignId` becomes the real id.

**`activeChoices` supersedes `currentTurn` in the UI state.** When the setup agent calls `present_choices`, the server delivers a `choices:presented` event and sets `activeChoices`. At the same time, `currentTurn` goes to `null` — the choice overlay replaces the turn-input UI. Predicates that wait on "turn is open" miss every choice-only beat of the setup conversation. Always include `activeChoices !== null` as a disjunct when checking "agent is waiting on the player."

**The setup agent sometimes leaves the previous choice overlay visible while asking a free-text follow-up.** After you submit a choice, the server does not necessarily emit `choices:cleared` — the agent may produce a narrative response and a free-text prompt while `activeChoices` still holds the just-answered list. Do NOT use `activeChoices === null` or a fingerprint diff as the "agent acknowledged my input" signal. Use `narrativeLines.length` growth from a captured baseline — it's monotonic and changes on every agent response.

**A scenario must not re-submit the same choice on a stale overlay.** The flip side of the above: when the agent leaves `activeChoices` populated but is actually asking for free text, a naive "if activeChoices, pick a choice" loop will pick the same first item every iteration and the test runs in circles. Track the fingerprints of choices you've already submitted (`prompt + "::" + labels.join("|")` is fine). When a non-null `activeChoices` matches a previously-submitted fingerprint, treat the overlay as stale and submit free text instead — navigating up to the "Enter your own" custom-input row first. The golden-path scenario implements this; mirror it in any new conversational scenario.

**After a DM response in single-player auto-commit, `currentTurn` is null.** When the DM finishes a turn and the engine returns to `engineState === "waiting_input"`, the next turn doesn't open until the player contributes again. Predicates that wait for "DM done" must NOT require `currentTurn !== null` + `seq > baseline` — they'll time out indefinitely. Use `engineState === "waiting_input" && narrativeLines.length > baseline` instead. (The very first turn after handoff is different: `waitForFirstDmTurn` correctly waits for `currentTurn != null` because the opening DM turn DOES open the player's first turn before pausing.)

**The in-game ESC menu is flaky to drive immediately after a DM response.** Observed: send ESC right after the DM's first response finishes, the GameMenu modal visibly opens (frames captured in the launcher's stdout tail show "Menu" / "◆ Resume" / "Save & Exit"), and then closes within a single 200ms polling window — possibly because of narrative-stream re-renders interfering with the modal, or an Ink input quirk that re-emits ESC when raw-mode ref-counting flips. The post-menu `/screen` capture shows the bare playing UI. Don't drive Save & Exit through the menu from a scenario; use `harness.endSession()` which calls `POST /session/end` — the same REST endpoint the menu's "Save & Exit" handler invokes. You get identical save semantics (scene flush, git checkpoint, session recap) without the flaky keystroke choreography. A dedicated "menu-navigation" scenario that runs OUTSIDE the post-DM window is a sensible follow-up.

**Ink in headless mode silently swallows non-`<Static>` writes.** Ink's `resolveInteractiveOption()` defaults `interactive` to `Boolean(stdout.isTTY)`, and when `interactive` is false the renderer takes a fast-path that writes nothing to stdout (you'll see `lastOutput` set internally, but `stdout.write` is never called). The sidecar's vterm captures nothing, `/screen` returns blanks, and there's no error. The launcher passes `interactive: true` whenever a mock stdin is in use; if you ever see `/screen` return only whitespace, check that flag first.

**The stdout tee must be installed before the first `render()`.** Ink only redraws on state change. If the sidecar's tee installs after Ink's initial frame, `term.write` never sees the menu and the vterm stays blank until something triggers a state update. [start-client.ts](../packages/client-ink/src/start-client.ts) awaits the sidecar startup before calling `render`.

**The mock stdin must stay in paused mode.** Ink's `App.js` reads input via `stdin.addListener('readable', ...)` and pulls with `stdin.read()`. Calling `stream.resume()` on the mock TTY switches it to flowing mode — push'd bytes fire `'data'` events that Ink never listens to. Leave the Readable in its default paused state; pushed bytes will buffer and fire `'readable'` as soon as Ink attaches its listener.

**Empty pre-set env vars block dotenv.** Embedded shells (Claude Code, some CI runners) pre-set `ANTHROPIC_API_KEY=""` to sandbox subprocesses. The engine calls `dotenv.config()` without `override: true`, so the pre-existing empty string blocks `.env` from populating the real key. The harness works around this by parsing `*_API_KEY` / `*_BASE_URL` out of the configDir's `.env` and injecting them into the spawn env when missing-or-empty.

**`configDir()` in dev mode is `process.cwd()`.** The engine reads `connections.json` and `.env` from `process.cwd()` whenever it's not running as a compiled SEA binary. Worktrees rarely have their own `connections.json`; the harness walks up the directory tree to find an ancestor that does, and sets the spawn cwd accordingly. If you write a tool that runs the engine, do the same — don't assume the worktree has credentials.

## Writing a scenario

A scenario is a TypeScript module that exports a `Scenario` object:

```ts
import type { Scenario } from "./types.js";

export const myScenario: Scenario = {
  id: "my-scenario",
  title: "Short human-readable title",
  description: "One-line explanation of what this proves.",
  live: false,           // true if it makes real LLM API calls
  approxMinutes: 1,

  async run({ harness, log }) {
    log("step 1...");
    await harness.waitForScreen("...");
    await harness.sendKey("return");
    // ...
  },
};
```

Register it in `packages/test-harness/bin/run.ts` (`ALL_SCENARIOS` array).

Conventions:
- **No naive sleeps.** Reach for `waitForState` family helpers. If you find
  yourself writing `setTimeout`, ask whether there's an observable state
  change that would do the job.
- **Idempotent.** A scenario must run from a clean tmp campaigns dir every
  time. Don't rely on prior runs.
- **Fail loudly.** A timed-out wait throws with a clear description.
  Don't catch errors to "make the scenario more resilient" — that hides
  regressions.
- **Cheap by default.** Mark `live: true` only if the scenario is supposed
  to make real LLM calls. Hooks that run many scenarios in bulk should
  default to filtering out live scenarios.

### Signal-picking cheatsheet

| You want to wait for... | Use this signal |
|---|---|
| Agent finished a turn (live or setup) | `narrativeLines.length` grew past a baseline snapshot AND `engineState === "waiting_input"`. Do NOT require `currentTurn != null` — it's null between turns in single-player auto-commit. |
| Player's turn is ready | `activeChoices !== null` OR (`currentTurn !== null && currentTurn.status === "open"`) |
| Setup → live campaign handoff | `transitionCampaignId !== null` OR `currentTurn?.campaignId !== "__setup__"` |
| DM is processing | `engineState === "dm_thinking"` |
| Specific narrative content arrived | Compare baseline `narrativeLines.length` then read the new entries — don't grep `/screen` for substrings unless you're driving the menu phase, which doesn't expose its state |
| Menu navigation (no state-level signal) | `waitForScreen("Menu Item Label")` — falls back to grepping the rendered screen, accept the brittleness |

## When to update this doc

- **Adding a new scenario:** append to the "Available scenarios" table and
  add a short paragraph if the scenario tests something non-obvious.
- **Changing the golden path:** the "The golden path" section above is the
  contract. Update it if you change what the baseline does.
- **Changing harness primitives** (new wait helper, new input method):
  add to "State-driven waiting" or extend the section accordingly.
