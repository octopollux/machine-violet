# End-to-End Testing

Machine Violet's e2e strategy is **three tiers, deterministic-first**. The old
keystroke-injection + HTTP-polling harness driven through the live model is no
longer the regression gate — it raced real async LLM/subagent activity and was
flaky by construction. The fix was architectural: stop driving non-deterministic
LLM flows through keystroke injection as the verification layer.

| Tier | What | Where | Speed / API |
|---|---|---|---|
| **1 — component/render** | Ink render + interaction (modals, overlays, layout) | `ink-testing-library`, co-located in `packages/client-ink` | fast, offline |
| **2 — full-stack deterministic** | Real `GameEngine` + `createSetupConversation` replaying recorded **golden tapes** | `packages/engine/src/testing/{corpus,setup-corpus}.golden.test.ts` | ~4s, **offline** |
| **3 — live smoke** | The real launcher stack against the real API | `packages/test-harness` (this doc) | 7-12 min, **live** |

**Tier 2 is the regression backbone** — the honest "did I break it?" signal.
See [golden-tapes.md](golden-tapes.md) (operating model) and
[tape-format.md](tape-format.md) (schema). Run it with `/replay-goldens`.

**This doc is Tier 3 (+ the interactive/record substrate):** the live harness in
[`packages/test-harness`](../packages/test-harness/). Reach for it only when you
specifically need the *live* stack — the setup→game handoff through the real
`SessionManager` loader, server+client+WebSocket boot, the TUI render — against
the real model. (The setup *agent conversation* itself now has deterministic
offline coverage via the Tier-2 setup corpus.) It is **not** the everyday gate;
that's Tier 2.

### Formatting invariant harness (Tier 1, property-based)

The DM narrative formatting/render pipeline has its own deterministic, LLM-free
harness at
[`packages/client-ink/src/tui/narrative/harness/`](../packages/client-ink/src/tui/narrative/harness/).
It runs the **real** pipeline (`processNarrativeLines`) and asserts the formatting
contract — no markup leaks, every physical row fits the terminal's *display* width,
content is preserved, the AST is well-formed, aligned rows pad correctly, and
output is deterministic + cache-transparent — over three input sources at every
width: hand-authored fixtures (one per construct + every known-hard combo), a
**seeded generator** of legal documents (`generator.ts`, reproducible by seed),
and the **committed campaign corpus** under `harness/corpus/`. A curated subset is
re-checked through the real Ink renderer (`harness.render.test.tsx`) to confirm
Ink's layout agrees with the width oracle.

```bash
npx vitest run packages/client-ink/src/tui/narrative/      # default: fast gate
MV_FORMAT_SOAK=1 npx vitest run .../harness/harness.test.ts # 6000 seeds × all widths
MV_LIVE_CORPUS=<campaigns-dir> npx vitest run .../harness/   # replay real on-disk campaigns
```

Touching the formatting pipeline or its vocabulary → see
[maintenance.md](maintenance.md) and keep this harness green.

## Packaged-artifact replay gate (release / nightly CI)

Tier 2 replays goldens against the engine constructed **in-process**. The
packaged-artifact gate replays the *same kind* of golden against the **built,
packaged binary** — the Node SEA `MachineViolet` executable with its vendored
assets — on each OS, **before a release or nightly publishes**. A broken package
(SEA injection, asset vendoring, boot path, config-dir resolution) fails the
replay and **blocks publish**. The goal: don't ship a binary that can't run a
campaign. It is offline and deterministic (no API key) — the replay provider
serves every model call from the tape.

**Run it locally:**

```bash
npm run dist                                   # build the SEA binary into dist/
npm run e2e:replay                             # replay goldens from source
npm run e2e:replay -- --binary dist/MachineViolet.exe   # ...against the binary
```

[`bin/replay-golden.ts`](../packages/test-harness/bin/replay-golden.ts) +
[`src/replay-runner.ts`](../packages/test-harness/src/replay-runner.ts) boot the
app (from source, or a packaged binary via `--binary`), replay the golden's
captured `key`/`say`/`pick` inputs, and assert the DM narration matches. With no
path args it replays the whole [`goldens/`](../packages/test-harness/goldens/)
corpus (the CI form).

**The runtime knobs it sets** (all env-gated, never set in production):

| Knob | Effect |
|---|---|
| `MV_TAPE_MODE=replay` + `MV_TAPE_PATH=<tape>` | Every tier served from the tape — no connection, no network, no API key (`buildReplayTierProviders` in [`tape-mode.ts`](../packages/engine/src/providers/tape-mode.ts)). |
| `MV_E2E=1` | Surfaces one synthetic, always-valid connection ([`config/e2e.ts`](../packages/engine/src/config/e2e.ts)) so the menu unlocks (it gates "New Campaign" on `connections.length > 0` + a passing health check). Server-side, so the client renders a genuinely-valid state. |
| `MV_CONFIG_DIR=<temp>` | Forces a throwaway config root, overriding the compiled `%APPDATA%` default — hermetic, no dependence on machine state. |

**Self-driving goldens.** Full-stack goldens
([`goldens/*.golden.json`](../packages/test-harness/goldens/)) carry an `inputs`
array (`key`/`say`/`pick` ops captured during `mvplay record`) plus the
`expectedNarrative` DM lines — so a replay re-drives the whole session (menu →
setup → handoff → DM turns) with no human in the loop. See
[tape-format.md](tape-format.md) and [golden-tapes.md](golden-tapes.md).

**Two non-obvious things make codex-recorded tapes replay correctly:**

- *In-band tool dispatch.* openai-chatgpt (codex) dispatches the model's tool
  calls in-band via `params.dispatchTool` and leaves `ChatResult.toolCalls`
  empty — the calls survive only as `tool_use` blocks in `assistantContent`. The
  replay provider re-issues them (`createReplayProvider`), or `present_choices` /
  `finalize_setup` never fire and setup stalls. Anthropic-shape tapes surface
  `toolCalls` (the outer loop dispatches them) and are left untouched.
- *Whitespace-normalized assertion.* Replay reproduces the verbatim streamed
  text, but line **segmentation** around mid-stream tool-call flush boundaries is
  a streaming artifact we don't reproduce byte-for-byte — so the assertion
  compares content with whitespace collapsed, not line breaks. The assertion
  targets `dm` lines only (`dev` breadcrumbs carry environment-specific paths and
  are dev-only).

**CI wiring.** A `verify-package` matrix job (win/mac/linux) in
[`release.yml`](../.github/workflows/release.yml) and
[`nightly.yml`](../.github/workflows/nightly.yml) downloads each OS's built
artifact, runs [`scripts/ci/replay-packaged-binary.sh`](../scripts/ci/replay-packaged-binary.sh)
(extract Portable.zip / tar.gz → `replay-golden --binary`), and is in each
`release` job's `needs:` so a red replay blocks publish. **Not** in PR `ci.yml` —
this gate is for the release/nightly pipelines only.
[`test-build.yml`](../.github/workflows/test-build.yml) runs the same gate so it
can be validated without cutting a release. Dispatch with `sign=false` to run the
pack → replay → install-smoke gate on a feature/Dependabot branch (the package is
unsigned), since Azure Trusted Signing only authenticates from protected refs;
omit it (default `sign=true`) from `release`/`main` to also exercise signing.

**Velopack install smoke** ([`scripts/ci/velopack-install-smoke.ps1`](../scripts/ci/velopack-install-smoke.ps1)):
installs `Setup.exe` → replays against the *installed* binary → uninstalls,
catching install-layout/manifest bugs the portable replay can't. `Setup.exe
--silent` returns *before* its background install (post-install hook + a
"kill every running app instance" sweep) finishes, so the script waits for the
`Installation completed successfully!` marker in `velopack.log` before launching
the replay — never a fixed sleep, which races a slow runner and lets Velopack's
completion sweep kill the replay's own app instance. It is
**impractical to run locally** (it performs a real machine install → uninstall
and is Windows-only — signing is optional via the `sign` input, so a signed
`Setup.exe` is no longer the blocker), so it was validated end-to-end on a clean
runner via a `test-build.yml` dispatch
(install → replay installed binary → uninstall, all green) and is now
**blocking in release/nightly and test-build.yml** — a broken Windows installer
blocks publish like any other packaging failure.

**Known gap (by design):** replay returns taped image bytes, so it exercises
`sharp` rendering but **not** codex generation — replay bypasses codex entirely.
codex vendoring is covered instead by the build's vendoring step (which fails
loudly if codex is missing) and the Tier-3 live smoketest.

## Two ways to use the live harness: scripted probes vs. interactive play

Built on the same launcher + sidecar:

- **Scripted probes** (`runProbe`) — spawn the game, run a fixed body, assert,
  hard-kill. For a live **pass/fail** check (`smoketest`, `boot-and-quit`, any
  ad-hoc one-shot). Covered in the rest of this doc.
- **Interactive play** (`mvplay`) — a **persistent** session you drive
  turn-for-turn, *you* in the loop each move. Use it to *play* the game, feel out
  behavior, reproduce a bug by hand — or, in **record mode**, to capture a
  full-stack golden tape (`mvplay record` / `save-tape`; see
  [golden-tapes.md](golden-tapes.md)). See [Interactive play](#interactive-play-mvplay).

For "did I break it?", reach for **Tier 2** (`/replay-goldens`), not a live probe.

## Interactive play (mvplay)

`mvplay` ([`packages/test-harness/bin/mvplay.ts`](../packages/test-harness/bin/mvplay.ts))
keeps the launcher + sidecar alive in a **detached background process** that
outlives each command, so you submit one turn per invocation across as many
invocations as the game lasts. State (ports, pid, and a read cursor) lives in a
session file under `<tmpdir>/mvplay/<session-id>/`. Sessions are isolated per id,
so multiple run concurrently (parallel playtests / recordings, #696): pass
`--session <id>` (or set `MVPLAY_SESSION`) on every command, default `"default"`;
`mvplay list` shows all live sessions. Each session also gets its own ephemeral
ports and `CODEX_HOME`, so concurrent codex sessions don't contend. Ports are
random-picked (no free-port probe), which is fine for one session; for **bulk
concurrent dispatch** hand each session a disjoint `--port-base <N>` (engine `N`,
sidecar `N+1`) so starts can't collide. One more isolation axis: **campaigns.**
The default temp dir is already per-session, but a shared `--data-dir` is *not* —
and setup writes to a shared `__setup__` scratch dir inside it, so concurrent
fresh setups in one `--data-dir` corrupt each other. Give each session its own
(`--data-dir <root>/<id>`) unless they only resume distinct existing campaigns.
The `playtest-sweep` skill is the dispatcher playbook for fanning out N live
playtests across subagents this way.

This exists because `runProbe` kills the process the moment its scripted body
returns; nothing survives between an agent's tool calls, so there's no session
to *play*. `mvplay` is the persistent counterpart.

The canonical handle is the **`/play` skill** (`.claude/skills/play/`). Under the
hood it's just:

```bash
node --import tsx/esm packages/test-harness/bin/mvplay.ts <cmd> [args]
# or: npm run play -- <cmd> [args]
```

| Command | What it does |
|---|---|
| `start [--player NAME] [--fresh] [--live] [--data-dir PATH]` | Boot the game in the background; print the main menu. |
| `record <scenario> [--player NAME] [--fresh] [--live] [--data-dir PATH]` | Like `start`, but tape every LLM call (`MV_TAPE_MODE=record`) for a golden. |
| `save-tape <path>` | Pull the recorded tape (via `GET /tape`) and write a golden to `<path>` (record sessions only). |
| `status` | Is a session alive? Show engine/turn/choices vitals. |
| `screen [--ansi]` | Print the rendered terminal screen. |
| `state` | Compact summary: engineState, mode, current turn, choices, narrative count. |
| `narrative [--all]` | Print narrative since you last looked (`--all` = everything). |
| `say "<text>"` | Submit a player action / free-text answer + Enter (confirms + retries once). |
| `key <name>` | Send a key (`return up down left right escape tab space pageup ...`). |
| `pick <N\|text>` | Select a choice by 1-based number or label substring. |
| `wait [--for beat\|handoff\|choices] [--timeout SEC]` | Block until a new beat lands, print it, exit. |
| `log [--tail N]` | Tail the launcher log (crash diagnostics). |
| `stop` | Kill the session. |

**Temp dir vs. live data.** By default `mvplay` plays in a throwaway campaigns
dir under the system temp dir — isolated, so the menu is empty until you start a
New Campaign and nothing can touch real saves. `--live` points the session at the
user's machine-scope data root (`~/Documents/.machine-violet` on Win/macOS, XDG
on Linux; mirrors the engine's `defaultCampaignRoot`); `--data-dir PATH` points at
a custom `.machine-violet` root (`<PATH>/campaigns`). Use these to continue or
inspect a campaign the user actually plays. ⚠️ **Turns MUTATE real campaigns** —
`start` prints a LIVE DATA banner with the resolved dir, and you must never
delete/overwrite/archive/roll back a live campaign unless the user explicitly
asked (copy it out to inspect). The real data dir is never auto-created: a bad
`--live` path just yields an empty menu.

`record`/`save-tape` capture a full-stack golden tape: boot in record mode, play
the scenario turn-for-turn, then `save-tape` before `stop` (teardown force-kills
the engine and its in-memory tape). The tape comes out over the engine's
dev-only `GET /tape` route (`packages/engine/src/server/routes/dev.ts`), which
returns the process-global tape or 404 when not recording. See
[golden-tapes.md](golden-tapes.md).

**The loop:** submit (`say`/`pick`/`key`), then `wait`, then react to what it
prints. `wait` settles on the next beat you must act on — a free-text prompt, a
choice overlay, a setup→live handoff, or a completed DM turn — and prints only
the new narrative plus any choices, advancing an internal read cursor so you
never re-read what you've seen.

**Run `wait` in the background.** A DM turn is 1-5 minutes. Launch `wait` with
`run_in_background: true` and keep working; the harness re-invokes you when it
exits. Don't foreground-block a tool call for minutes, and don't poll `state` in
a loop — that's what `wait` is for. (This is the same background pattern the
smoketest uses for the live probe.)

`wait` distinguishes a genuinely-new beat from a stale overlay the engine left
on screen by comparing against the session file's read cursor + last-acted choice
fingerprint — the same signal-picking logic the scripted probes use, packaged so
you don't have to re-derive it each turn.

Read-back is over the sidecar's HTTP `/screen` + `/state` (non-blocking — there
is no stdin/stdout pipe to block on). The detached launcher's own stdout/stderr
is tee'd to a log file for crash diagnostics (`mvplay log`).

## The two long-lived probes

| ID | Live API? | ~Time | What it proves |
|---|---|---|---|
| `boot-and-quit` | no | ~10 s | Launcher boots, sidecar reachable, main menu renders, process tears down cleanly. The precondition for everything else. |
| `smoketest` | **yes** | 7-12 min | New campaign → setup-agent walk → handoff → two in-game player/DM turn cycles. The rare *live* confirmation — the everyday regression gate is Tier-2 golden replay, not this. Hard-killed on exit; Save & Exit is deliberately skipped. |

Each probe is a standalone TypeScript file under
[`packages/test-harness/bin/`](../packages/test-harness/bin/). No registry.
For anything else, write your own one-shot — see "Writing a probe" below.

### What `smoketest` actually does

1. Boot to the main menu.
2. Select "New Campaign" and enter the setup-agent conversation.
3. Walk the setup conversation by picking the first real choice at every
   `present_choices` overlay and submitting `"you decide"` for any free-text
   prompts.
4. Wait for the setup → live campaign handoff. The first DM turn arrives
   3-5 minutes later. The probe watches `engineState`,
   `currentTurn.campaignId`, `currentTurn.status`, and
   `transitionCampaignId` — it never relies on a wall-clock sleep.
5. Submit one player action, wait for the DM's response turn to complete
   (`narrativeLines` grew + `engineState === "waiting_input"`).
6. Submit a second player action, wait for that response too. (Two full
   turns covers state transitions that only show up on turn 2: scribe
   spawn, scene bookkeeping, transcript flush continuity.)

Then the harness hard-kills its launcher subprocess. **Save & Exit
is intentionally not part of the smoketest** — it would burn a Haiku
call on the session-recap subagent every smoke run, and save-on-exit is
already covered by unit tests on `session-manager`. If you need to
validate that flow specifically, write a dedicated probe.

## Running

The canonical handle is the **`/smoketest` skill** (`.claude/skills/smoketest/`).
Agents invoke the same skill via the Skill tool when validating cross-cutting
work. Under the hood, it just calls the npm script:

```bash
# Cheap precondition — no API key needed:
npm run e2e:boot

# The smoke probe:
npm run smoketest
```

Each script invokes the probe file directly:

```bash
node --import tsx/esm packages/test-harness/bin/boot-and-quit.ts
node --import tsx/esm packages/test-harness/bin/smoketest.ts
```

Both accept the same flags:
- `--stdio=inherit` pipes the launcher's stdout/stderr to your terminal
  live. Useful when debugging a stuck or flaky probe.
- `--keep` skips cleanup of the temporary campaigns directory. The path
  is logged at shutdown so you can poke around the resulting campaign
  files.

On success: exit 0, single-line `✔ OK <probe> (<n>s)` summary.

### Worktree-friendly credentials

The launcher's `configDir()` is `process.cwd()` in dev mode — and the engine
reads `connections.json` and `.env` from there. The harness walks up from
the worktree until it finds the first ancestor that contains a
`connections.json`, then uses that as cwd. A worktree without any
credentials can therefore still run the live smoketest without copying
secrets in. If no `connections.json` exists anywhere in the ancestry, the
launcher will boot to a "No AI connections configured" menu and the
smoketest will fail in Phase 2 with a clear timeout — fix by running
the normal client once on this machine and configuring an API key.

Embedded shells (Claude Code, some CI runners) pre-set `ANTHROPIC_API_KEY=""`
to sandbox subprocesses. The engine uses `dotenv` without
`override: true`, so an empty pre-existing value blocks `.env` from
populating the real key. To unbreak the live probe in those shells,
the harness explicitly parses the configDir's `.env` and injects any
`*_API_KEY` / `*_BASE_URL` values into the spawn env (only when the
target var is missing or empty — explicitly-set values are respected).
Outside such shells this is a no-op.

On failure: exit 1, plus a dump containing:
- the error and stack trace,
- the last 50 lines of the launcher's combined output,
- the most recent `/state` JSON,
- the most recent `/screen` text frame,
- the engine log tail (last 80 structured events).

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
| `waitForEngineEvent(name)` | Wait for a structured event in `.debug/engine.jsonl` (e.g. `image_gen:persisted`, `subagent:end`) |

Each helper accepts a `timeoutMs` (default 10 s; long DM turns get 600 s).
The timeout exists only to guarantee the probe fails rather than hangs;
the wait returns as soon as the state transition is observed. Pollers
sample at 200 ms by default.

When a wait times out, the harness throws a `TimeoutError` containing the
description, elapsed milliseconds, and the last sample observed.
`runProbe` dumps that plus the screen, child log, and engine-log tail.

## Engine-log breadcrumbs

The engine writes structured events to `<campaignsDir>/../.debug/engine.jsonl`.
Read them via `harness.readEngineLog()` / `waitForEngineEvent()`. Useful when
the UI doesn't reflect what you need to assert (image-gen pipeline, subagent
spawns, API retries, persistence failures).

Categories worth knowing about:

| Prefix | Examples | What they mark |
|---|---|---|
| `server:*` | `start`, `listen` | Boot lifecycle. |
| `session:*` | `start`, `end`, `mode` | Campaign session lifecycle (incl. setup → live handoff). |
| `turn:*` | `player_input`, `dm_complete` | Turn boundaries with token counts + duration. |
| `api:*` | `call`, `retry` | Provider HTTP calls — model, tokens, duration, tool_use count. |
| `cache:*` | `miss` | Anthropic cache-prefix divergence (cache-diagnosis beta). Fields: `messageId`, `model`, `reasonType` (`system_changed` / `tools_changed` / `messages_changed` / `model_changed`), optional `missedInputTokens`. Only the `*_changed` types are emitted; `previous_message_not_found` / `unavailable` are suppressed. Anthropic-provider calls with a `conversationId` only. |
| `subagent:*` | `start`, `end` | Scribe, theme-styler, promote_character, etc. |
| `image_gen:*` | `request`, `response`, `no_data`, `error`, `persisted`, `dispatch_failed`, `legacy_hosted_item_ignored` | Image-generation pipeline. |
| `setup:*` | `image_tools_registered` | Setup-agent capability snapshots. |

The harness scopes engine-log reads to events with `t >= launchedAt`, so
stale entries from prior runs don't leak into a fresh probe — the cutoff
is captured before `spawn`.

## Engine-state surprises (read before writing a probe)

These are non-obvious facts about how `ClientState` actually moves during gameplay. Each one cost a failed live run to discover — assume the next one will too if you don't read this.

**`mode` does NOT flip to `"setup"` during campaign creation.** The engine broadcasts `session:mode` events only when entering/exiting OOC and Dev modes. During the setup-agent conversation, `mode` stays `"play"`. The signal that you're in setup is `currentTurn.campaignId === "__setup__"` (a synthetic campaign id used for the setup session). When the live campaign starts, `currentTurn.campaignId` becomes the real id.

**`activeChoices` supersedes `currentTurn` in the UI state.** When the setup agent calls `present_choices`, the server delivers a `choices:presented` event and sets `activeChoices`. At the same time, `currentTurn` goes to `null` — the choice overlay replaces the turn-input UI. Predicates that wait on "turn is open" miss every choice-only beat of the setup conversation. Always include `activeChoices !== null` as a disjunct when checking "agent is waiting on the player."

**The setup agent sometimes leaves the previous choice overlay visible while asking a free-text follow-up.** After you submit a choice, the server does not necessarily emit `choices:cleared` — the agent may produce a narrative response and a free-text prompt while `activeChoices` still holds the just-answered list. Do NOT use `activeChoices === null` or a fingerprint diff as the "agent acknowledged my input" signal. Use `narrativeLines.length` growth from a captured baseline — it's monotonic and changes on every agent response.

**A probe must not re-submit the same choice on a stale overlay.** The flip side of the above: when the agent leaves `activeChoices` populated but is actually asking for free text, a naive "if activeChoices, pick a choice" loop will pick the same first item every iteration and the test runs in circles. Track the fingerprints of choices you've already submitted (`prompt + "::" + labels.join("|")` is fine). When a non-null `activeChoices` matches a previously-submitted fingerprint, treat the overlay as stale and submit free text instead — navigating up to the "Enter your own" custom-input row first. The `smoketest` probe implements this; mirror it in any new conversational probe.

**After a DM response in single-player auto-commit, `currentTurn` is null.** When the DM finishes a turn and the engine returns to `engineState === "waiting_input"`, the next turn doesn't open until the player contributes again. Predicates that wait for "DM done" must NOT require `currentTurn !== null` + `seq > baseline` — they'll time out indefinitely. Use `engineState === "waiting_input" && narrativeLines.length > baseline` instead. (The very first turn after handoff is different: waiting on `currentTurn != null` correctly catches the opening DM turn because it DOES open the player's first turn before pausing.)

**`engineState === "waiting_input"` does NOT guarantee the input box will
accept a keystroke.** Right after a DM turn, the scribe subagent keeps running
(renaming entities, patching records) and emits more narrative while the engine
already reports `waiting_input`. A re-render in that window can drop the Enter of
a submission — the typed *text* lands in the input buffer but never submits, then
silently concatenates onto your next `say`, producing a merged double-action.
Input is not gated on engine state (the client deliberately never blocks on it,
to avoid wedging — see `PlayingPhase.tsx` `textInputDisabled`), so `/state`
gives no warning. The reliable confirmation that a submit registered is that
`narrativeLines.length` grew: the client appends an optimistic player line the
instant it accepts the keystrokes. `mvplay`'s `say`/`pick` use exactly this —
confirm the optimistic line appeared within a few seconds, and on miss, clear the
buffer (`ctrl+u`) and resend once. Any probe that submits a turn immediately
after a previous DM turn settles should do the same rather than trusting
`waiting_input` alone.

**Choice-overlay submission needs a normalization dance.** The overlay opens with "Enter your own" at UI index 0, with `customInputActive` true for short lists (<5 options) and false for longer ones. The reliable normalization is: press UP (force selectedIndex=0 + customInputActive=true regardless of length), press DOWN once (move to first real choice), then DOWN `pickIndex` more times, then Return. Bare DOWN sequences from an unknown starting state are fragile.

**The in-game ESC menu is flaky to drive immediately after a DM response.** Observed: send ESC right after the DM's first response finishes, the GameMenu modal visibly opens (frames captured in the launcher's stdout tail show "Menu" / "◆ Resume" / "Save & Exit"), and then closes within a single 200ms polling window — possibly because of narrative-stream re-renders interfering with the modal, or an Ink input quirk that re-emits ESC when raw-mode ref-counting flips. The post-menu `/screen` capture shows the bare playing UI. Don't drive Save & Exit through the menu from a probe; use `harness.endSession()` which calls `POST /session/end` — the same REST endpoint the menu's "Save & Exit" handler invokes. You get identical save semantics (scene flush, git checkpoint, session recap) without the flaky keystroke choreography.

**Ink in headless mode silently swallows non-`<Static>` writes.** Ink's `resolveInteractiveOption()` defaults `interactive` to `Boolean(stdout.isTTY)`, and when `interactive` is false the renderer takes a fast-path that writes nothing to stdout (you'll see `lastOutput` set internally, but `stdout.write` is never called). The sidecar's vterm captures nothing, `/screen` returns blanks, and there's no error. The launcher passes `interactive: true` whenever a mock stdin is in use; if you ever see `/screen` return only whitespace, check that flag first.

**The stdout tee must be installed before the first `render()`.** Ink only redraws on state change. If the sidecar's tee installs after Ink's initial frame, `term.write` never sees the menu and the vterm stays blank until something triggers a state update. [start-client.ts](../packages/client-ink/src/start-client.ts) awaits the sidecar startup before calling `render`.

**The mock stdin must stay in paused mode.** Ink's `App.js` reads input via `stdin.addListener('readable', ...)` and pulls with `stdin.read()`. Calling `stream.resume()` on the mock TTY switches it to flowing mode — push'd bytes fire `'data'` events that Ink never listens to. Leave the Readable in its default paused state; pushed bytes will buffer and fire `'readable'` as soon as Ink attaches its listener.

**Empty pre-set env vars block dotenv.** Embedded shells (Claude Code, some CI runners) pre-set `ANTHROPIC_API_KEY=""` to sandbox subprocesses. The engine calls `dotenv.config()` without `override: true`, so the pre-existing empty string blocks `.env` from populating the real key. The harness works around this by parsing `*_API_KEY` / `*_BASE_URL` out of the configDir's `.env` and injecting them into the spawn env when missing-or-empty.

**`configDir()` in dev mode is `process.cwd()`.** The engine reads `connections.json` and `.env` from `process.cwd()` whenever it's not running as a compiled SEA binary. Worktrees rarely have their own `connections.json`; the harness walks up the directory tree to find an ancestor that does, and sets the spawn cwd accordingly. If you write a tool that runs the engine, do the same — don't assume the worktree has credentials.

## Writing a probe

A probe is just an async function passed to `runProbe`. Put it in a file
anywhere — `packages/test-harness/bin/`, a `tmp/` dir, wherever — and
execute it with `node --import tsx/esm <path>`.

```ts
import { runProbe, DEFAULT_TURN_TIMEOUT_MS } from "@machine-violet/test-harness";

await runProbe({
  name: "my-probe",
  title: "Short human-readable title",
  body: async ({ harness, log }) => {
    log("Phase 1: ...");
    await harness.waitForScreen("Machine Violet");
    await harness.sendKey("return");
    await harness.waitForState(
      (s) => s.currentTurn?.campaignId === "__setup__" && s.currentTurn?.status === "open",
      { description: "setup turn opens", timeoutMs: DEFAULT_TURN_TIMEOUT_MS },
    );
    // ...
  },
});
```

`runProbe` handles argv parsing (`--stdio`, `--keep`), the launch, the
error dump on failure, and clean shutdown.

Conventions:
- **No naive sleeps.** Reach for `waitForState` family helpers. If you find
  yourself writing `setTimeout`, ask whether there's an observable state
  change that would do the job.
- **Idempotent.** A probe must run from a clean tmp campaigns dir every
  time. Don't rely on prior runs.
- **Fail loudly.** A timed-out wait throws with a clear description.
  Don't catch errors to "make the probe more resilient" — that hides
  regressions.

### Signal-picking cheatsheet

| You want to wait for... | Use this signal |
|---|---|
| Agent finished a turn (live or setup) | `narrativeLines.length` grew past a baseline snapshot AND `engineState === "waiting_input"`. Do NOT require `currentTurn != null` — it's null between turns in single-player auto-commit. |
| Player's turn is ready | `activeChoices !== null` OR (`currentTurn !== null && currentTurn.status === "open"`) |
| Setup → live campaign handoff | `transitionCampaignId !== null` OR `currentTurn?.campaignId !== "__setup__"` |
| DM is processing | `engineState === "dm_thinking"` |
| Image generation completed | `waitForEngineEvent("image_gen:persisted")` (success) or `image_gen:dispatch_failed` (host-side fail) or `image_gen:error` (provider fail) |
| Specific narrative content arrived | Compare baseline `narrativeLines.length` then read the new entries — don't grep `/screen` for substrings unless you're driving the menu phase, which doesn't expose its state |
| Menu navigation (no state-level signal) | `waitForScreen("Menu Item Label")` — falls back to grepping the rendered screen, accept the brittleness |

## When to update this doc

- **Changing what `smoketest` does:** the "What `smoketest` actually does"
  section above is the contract. Update it if you change the baseline.
- **Changing harness primitives** (new wait helper, new input method,
  new engine-log breadcrumb category): extend "State-driven waiting" or
  "Engine-log breadcrumbs" accordingly.
- **Discovering a new gotcha** that cost you a failed run: add it to
  "Engine-state surprises" with a one-paragraph explanation. Future you
  (or future agents) will thank you.
- **Changing the packaged-artifact gate** (the replay knobs, the runner, the CI
  job, or the Velopack smoke): update "Packaged-artifact replay gate" above and
  keep the workflow comments in sync. The Velopack install smoke is now blocking
  in release/nightly (validated via a `test-build.yml` dispatch); if it ever
  proves flaky, re-add `continue-on-error` and note it here.
