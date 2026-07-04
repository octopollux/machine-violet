---
name: play
description: Play Machine Violet interactively, turn-for-turn, as the main agent — boot a persistent game session and drive it one tool call per turn (read the screen, submit an action, wait for the DM, repeat). USE THIS whenever you want to actually *play* or *exercise* the game live rather than run the scripted smoketest probe — e.g. the user says "play the game", "/play", "drive MV yourself", "walk a campaign", "try the setup agent live", "let's play a turn", or you need to manually reproduce / feel out in-game behavior that a one-shot probe can't capture. NOT for the fixed pass/fail end-to-end check (that's /smoketest).
allowed-tools: Bash(npm run play:*), Bash(node --import tsx/esm packages/test-harness/bin/mvplay.ts:*), Read
---

# Play (interactive)

`mvplay` keeps a **persistent** launcher + sidecar running in the background so
you — the main agent — can play Machine Violet turn-for-turn: read the rendered
screen, submit one action, wait for the DM, react, repeat, across as many tool
calls as the game lasts. This is the opposite of the `smoketest` probe, which
spawns the game, runs a *scripted* body, and kills it. Use this when the value
is in **you being in the loop**, deciding each turn.

**Drive it yourself. Do NOT delegate to a subagent and do NOT write a one-shot
`runProbe` script** — both throw away the whole point, which is your turn-by-turn
judgement against live game state.

## The command

```bash
node --import tsx/esm packages/test-harness/bin/mvplay.ts <cmd> [args]
# or: npm run play -- <cmd> [args]
```

| Command | What it does |
|---|---|
| `start [--player NAME] [--fresh] [--live] [--data-dir PATH]` | Boot the game in the background; print the main menu. |
| `record <scenario> [--player NAME] [--fresh] [--live] [--data-dir PATH]` | Like `start`, but tape every LLM call (records a golden — see /record-tape). |
| `save-tape <path>` | Pull the recorded tape and write a golden to `<path>` (record sessions only). |
| `status` | Is a session alive? Show engine/turn/choices vitals. |
| `screen [--ansi]` | Print the rendered terminal screen (use for menu phase). |
| `state` | Compact summary: engineState, mode, current turn, choices, narrative count. |
| `narrative [--all]` | Print narrative since you last looked (`--all` = everything). |
| `say "<text>"` | Submit a player action / free-text answer + Enter. Confirms it registered; retries once. |
| `key <name>` | Send a key: `return up down left right escape tab space pageup pagedown ...` |
| `pick <N\|text>` | Select a choice by 1-based number or by label substring. |
| `wait [--for beat\|handoff\|choices] [--timeout SEC]` | Block until a new beat lands, print it, exit. **Run in background.** |
| `log [--tail N]` | Tail the launcher log (crash diagnostics). |
| `stop` | Kill the session. |

One session at a time (state lives under the system temp dir). Read-back is over
the sidecar's HTTP `/screen` + `/state` — nothing blocks on stdio.

## Temp dir vs. the user's live campaigns (`--live`)

By **default** you play in a throwaway temp campaigns dir (`tmpdir()/mvplay/
campaigns`) — isolated from the user's real saves, so the menu is empty until
*you* start a New Campaign, and nothing you do can hurt real data. That's the
right mode for exercising fresh flows.

To **continue or inspect a campaign the user actually plays**, boot with
`--live` (their machine-scope data dir, `~/Documents/.machine-violet` on
Windows/macOS) or `--data-dir PATH` (a custom `.machine-violet` root):

```bash
mvplay start --live          # menu now lists the user's real campaigns
```

> ⚠️ **`--live`/`--data-dir` play the user's REAL campaigns, and every turn
> MUTATES them** — narration is appended, saves and rollback points are written,
> generated images land on disk. This is exactly the data a lost/corrupted copy
> would run a player off the product. So:
> - **Never** delete, overwrite, archive, roll back, or "reset" a live campaign
>   unless the user explicitly asked for that specific campaign.
> - To *inspect* a campaign safely, copy it out (`cp -r`) and read the copy, or
>   read files directly — don't drive turns you don't intend to keep.
> - When in doubt, play in the default temp dir, or ask.

The startup banner prints the resolved dir and this warning whenever real data
is in play — read it and confirm it's the dir you meant.

## The turn loop

```bash
mvplay start                 # boots to the main menu, prints it
mvplay key return            # select "New Campaign"
# → then: wait (background), read, respond, repeat
```

For each beat: **submit, then `wait` in the background, then react to what it
prints.** `wait` settles on the next thing you need to act on — a free-text
prompt, a choice overlay, a setup→live handoff, or a completed DM turn — and
prints only the new narrative plus any choices.

- Free-text prompt → `mvplay say "..."`
- Choice overlay → `mvplay pick 2` (or `mvplay pick "Adult"`)
- Setup confirmation that still shows a stale choice list → it's asking for
  free text; just `mvplay say "looks good"` (the driver navigates to the
  custom-input row for you).

When you're done: `mvplay stop`.

## Critical: run `wait` in the background

A DM turn is **1-5 minutes** (the first one after handoff is the longest). Launch
`wait` with `run_in_background: true` and **keep working** — plan your next move,
re-read a doc, jot notes. The harness re-invokes you with a `<task-notification>`
when `wait` exits; read its output then. Don't foreground-block a tool call for
five minutes, and don't poll `state` in a loop while you wait — that's what
`wait` is for.

```
Bash(run_in_background: true):
  node --import tsx/esm packages/test-harness/bin/mvplay.ts wait --timeout 420
```

`wait` exits 0 when it settles (prints the new narrative + choices), or exits 1
on timeout (prints the current state so you can diagnose). If it times out but
`state` shows `dm_thinking`, the turn is just slow — `wait` again.

## Gotchas (these cost real runs to learn)

- **`waiting_input` doesn't mean input was accepted.** Right after a DM turn the
  scribe subagent is still finalizing, and a stray re-render can drop your Enter —
  the text sits buffered and silently concatenates onto your *next* submission.
  `say`/`pick` defend against this by confirming an optimistic line appeared and
  retrying once (clearing the buffer first). If you ever drive raw `key`/`say`
  sequences by hand, watch for it.
- **Between turns, no turn is "open."** In single-player auto-commit, after a DM
  reply `currentTurn` is `null` until you contribute again. That's normal — just
  `say` your next action; it opens the turn.
- **Setup leaves stale choice overlays up.** The setup agent often asks a
  free-text follow-up while the previous choice list is still on screen. Don't
  `pick` from a list you've already answered — `say` instead.

The deeper engine-state surprises (why `mode` stays `"play"` during setup, the
`__setup__` campaign id, the choice-overlay normalization dance) are documented
in [docs/e2e-harness.md](../../../docs/e2e-harness.md) under "Engine-state
surprises" and "Interactive play". The `mvplay` driver already handles the input
normalization for you; read the doc only if you're driving raw keys.

## Recording a golden while you play

The same turn-for-turn loop, in record mode, is how you capture a full-stack /
setup golden tape: `mvplay record <scenario>` instead of `start`, play through,
then `mvplay save-tape <path>` before `mvplay stop`. Your turn-by-turn judgement
*is* the recording. See the **/record-tape** skill for the full discipline (and
the caveat that full-stack auto-replay is still an open edge).

## When to reach for something else

- **"Did I break it?" / regression check** → `/replay-goldens` (offline, ~4s).
  That's the gate, not this.
- **Record/refresh a golden** → `/record-tape` (uses `mvplay record` under the hood).
- **A live behavioral smoke against the real API** → `/smoketest` (Tier-3, rare).

Interactive play is for when *you* are the player and the value is your
turn-by-turn judgement against live game state.
