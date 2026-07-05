---
name: playtest-sweep
description: Bulk-dispatch LIVE Machine Violet playtests in parallel — you are the dispatcher, fanning out N subagents that each drive their own isolated mvplay session, then aggregating their reports. USE THIS when the user wants breadth fast: "sweep the seeds", "playtest N campaigns at once", "bulk playtest", "run playtests in parallel", "dispatch playtests", curate voices across many seeds, or regression-check a batch of campaigns live. For a single hands-on playthrough use /play instead; for the deterministic pass/fail check use /smoketest.
---

# Playtest Sweep (bulk live playtests)

Fan out many **live** playtests at once. Each playtest runs in its own subagent
driving its own **isolated mvplay session** (the parallel-sessions feature, #696).
You are the **dispatcher**: you assign each subagent a unique session id + a
disjoint port-base, spawn them in quota-safe batches, and aggregate what they
report. This is for **breadth** (cover many seeds/campaigns quickly). For one
hands-on playthrough, use `/play`.

The subagents are as capable as you and already know how to use `mvplay` — do
**not** paste them a tutorial. Your job is the orchestration and the one thing
that isn't automatic: **handing out ports**.

## The isolation contract (what keeps N sessions from colliding)

Every subagent MUST receive three things, and must pass the first two on *every*
`mvplay` command:

1. **A unique `--session <id>`** — its own state dir, launcher log, temp
   campaigns. Slug the target (e.g. `pt-ghosts-proxima`).
2. **A disjoint `--port-base <N>`** — assign `30000 + 2*i` to the i-th subagent
   (engine `N`, sidecar `N+1`; step by **2** so pairs never overlap). **This is
   the part you can't skip:** the default port pick is random with *no* free-port
   probe, so at fan-out two sessions can grab the same port and the loser just
   fails to launch. A handed-out base is collision-free by construction.
3. **Its own campaigns dir.** The setup agent writes to a *shared* `__setup__`
   scratch dir *inside* the campaigns dir, so two sessions that share one
   campaigns dir and both run setup will **clobber each other's setup**. Each
   session needs an isolated campaigns dir — see *Where results land* below. (The
   one exception: sessions that only *resume distinct existing* campaigns from a
   shared dir are fine — no setup, separate per-campaign subdirs.)

Example assignment for 4 targets:

| i | target | `--session` | `--port-base` | `--data-dir` |
|---|--------|-------------|---------------|--------------|
| 0 | seed A | `pt-a` | 30000 | `<root>/pt-a` |
| 1 | seed B | `pt-b` | 30002 | `<root>/pt-b` |
| 2 | seed C | `pt-c` | 30004 | `<root>/pt-c` |
| 3 | seed D | `pt-d` | 30006 | `<root>/pt-d` |

### Where results land (data dir)

You almost never want `--live` for a sweep — that's machine-scope real saves.
Pick by whether you keep the output:

- **Throwaway** → default (no data flag): each session auto-gets its own
  `tmpdir()/mvplay/<id>/campaigns`. Isolated, but gone after.
- **Keep it in a playtest directory** (the usual case) → give each session its
  **own** subdir under one root: `--data-dir <playtest-root>/<id>`. Every run
  collects under the one known root (per-session subdirs), and `__setup__` stays
  isolated. **Never point multiple concurrent sessions at a single shared
  `--data-dir` for fresh sweeps** — they collide on `__setup__`.
- **Resume real machine saves** → `--live`, one subagent per campaign, only the
  campaigns the user named. Mutates real data — last resort, not the default.

## Concurrency & quota

Codex (ChatGPT/Pro) rate-limits, and a **drained quota hangs turns** (bounded by
the StallWatchdog, but it burns wall-time). So **cap concurrency** — ~**3–4 live
sessions at once** is a safe default; run more targets as sequential batches.
Don't fan out 20 simultaneously (~a dozen back-to-back runs is enough to drain a
day's quota). Keep port-bases unique across the *whole* sweep, not just per batch,
so a straggler from batch 1 can't collide with batch 2.

## Dispatch loop

1. **Build the target list** — the seeds to sweep, or the campaigns to resume.
2. **Assign** each a session id, `port-base = 30000 + 2*i` (i over the whole
   list), and its own `--data-dir <root>/<id>` (for kept results) or nothing
   (throwaway temp). One `--data-dir` per session — never shared for fresh sweeps.
3. **Spawn a batch** of subagents (Agent tool — multiple in one message run
   concurrently). Cap the batch at your concurrency limit.
4. **Collect** each batch's reports; spawn the next batch as slots free.
5. **Aggregate** into one summary for the user, then **clean up** (below).

## Subagent prompt (keep it lean)

Give each subagent only its assignment and the report shape — not a command
reference. Template:

> You're running one **live playtest**. Pass **`--session <id>`** on *every*
> `mvplay` command (it selects your isolated session — never omit it). On your
> **`start`**, also pass **`--port-base <N>`** and **`--data-dir <dir>`** so your
> ports and campaigns can't collide with the other concurrent playtests.
> **Target:** _<seed name, or "resume campaign X">_.
> **Do:** boot (`start --session <id> --port-base <N> --data-dir <dir> [--fresh]`),
> then _<goal: e.g. "drive setup + play 5 turns" / "resume + play 3 turns">_,
> watching for _<criteria: crashes, DM naming tics, incoherence, image failures>_.
> **Waits are 1–5 min** — run `mvplay wait` in the background.
> When done, **`stop --session <id>`** and return ONLY a compact report:
> `{ target, turnsPlayed, crashed, findings: [...], verdict: "clean" | "issues" }`.
> You already know `mvplay`; if you want the command reference it's the `/play` skill.

## Cleanup (always)

A crashed or interrupted subagent can leave its launcher running. After the sweep
(and if anything looks off mid-sweep):

```bash
node --import tsx/esm packages/test-harness/bin/mvplay.ts list      # any survivors?
node --import tsx/esm packages/test-harness/bin/mvplay.ts stop --session <id>   # reap each
```

## Safety

- **`--live` MUTATES real saves** (narration, saves, images written) and is the
  *last* resort — only for resuming campaigns the user explicitly named. Default a
  sweep to a **per-session `--data-dir <root>/<id>`** (kept, collected under one
  playtest root) or the **temp dir** (throwaway) — never machine-scope just to
  persist output. See *Where results land*.
- **One campaigns dir per concurrent session during setup.** A shared campaigns
  dir means a shared `__setup__` scratch → concurrent fresh setups corrupt each
  other. Per-session `--data-dir` (or the temp default) keeps them apart.
- **One subagent per `--live` campaign.** Two on the same save corrupt it.
- Prefer `--fresh` per session only if you intend to replace a same-named session;
  with unique ids you never need it.
