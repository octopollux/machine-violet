# E2E Harness v2 — Implementation Plan

> **Status:** in progress (started 2026-06-04). Record→replay loop **CLOSED 2026-06-05** — first
> golden (`dm-open-door`) recorded live and replaying offline through the real `GameEngine`. This is a
> temporary implementation tracker.
> When the slices land, its content folds into a rewritten `e2e-harness.md` and this file is removed.

## Why

The old e2e backbone — keystroke injection over the agent sidecar + 200ms HTTP polling, driven through the
live `/smoketest` against the real LLM — is flaky by construction. It races real async LLM/subagent
activity (scribe dropping keystrokes, ESC-menu phantom-close, setup-overlay stickiness, poll latency). No
framework fixes that; the fix is architectural: stop driving non-deterministic LLM flows through keystroke
injection as the verification layer. Gemini CLI (same Ink/React stack) reached the same conclusion —
golden/mocked model responses, assert on effects.

## The model — three tiers, deterministic-first

1. **Tier 1 — component/render.** `ink-testing-library`, in-process. Already healthy (~30 files in
   `packages/client-ink`); just expand. Where modal bleed-through, overlay choreography, layout belong.
2. **Tier 2 — full-stack deterministic (the backbone).** Record/replay "session tapes": wrap `LLMProvider`
   to tape real request/response pairs; drive **logical inputs** (`said X`, `picked choice 2`) not raw
   keystrokes; the **real engine runs**; replay needs **no API key, no network**. Implemented as
   **in-process vitest tests** so goldens ride the same `vitest related` pass as Tier 1.
3. **Tier 3 — thin live smoke.** Asserts on **behavior** (engine events + save files via REST/programmatic
   seams), run rarely. The repurposed `/smoketest`. Not the backbone.

**Load-bearing capability:** a Claude live-pilots the game **once** to record a golden tape (logical inputs
+ real LLM I/O + resulting events/frames). Replay thereafter needs no Claude and no API. Regenerating a
stale golden = re-pilot once + review a **readable git diff** — never hand-edit a tape.

## Wiring (new code)

| File | Role |
|---|---|
| `packages/engine/src/providers/tape-provider.ts` | `LLMProvider` record/replay decorator. Record: forward + tape. Replay: serve from tape, no network, throw loudly on miss. Must cover `chat`/`stream` and `generateImage`; replay `getCapabilities` verbatim. |
| `packages/engine/src/providers/tape.ts` | Tape format + serializer + matcher. Human-readable JSON, image bytes out-of-line (content-addressed) for diffable goldens. Lives in `engine` (not `test-harness`) so the dependency runs test-harness → engine. |
| `packages/test-harness/src/replay-runner.ts` | Boots the real engine in-process in replay mode, injects logical inputs via a programmatic seam, asserts on engine events / save files / (optionally) frames. |
| `packages/test-harness/tapes/<scenario>/` | Golden fixtures, one dir per scenario. |
| `packages/test-harness/src/index.ts` | New barrel exports for the above. |

**Seam:** wrap each `TierProvider.provider` at `buildTierProvidersWithCache`
(`packages/engine/src/config/tier-resolver.ts`), env-gated (`MV_TAPE_MODE=record|replay` + `MV_TAPE_PATH`).
One chokepoint covers DM + every subagent + setup + scribe + choice-gen + image-gen — no per-agent plumbing.
The interface is already hand-mocked in `agent-loop-bridge.test.ts`, so the shim is a generalization of a
working pattern; reuse its `ChatResult` fixtures as the tape schema reference.

## Locked decisions

- **Tape matching:** ordinal-per-agent-bucket + loose request validation. A benign prompt-wording tweak
  yields a readable diff + one re-record, not a cache-miss storm.
- **Record against the API-key provider, NOT codex.** The codex/app-server path runs the whole tool loop
  inside one `chat()` (opaque to the bridge, unstable to serialize). Codex path is covered by Tier-3 only.
- **Tier-2 = in-process vitest** (no per-test engine boot).
- **Determinism normalization:** replay `tool_use` IDs verbatim (so the bridge re-pairs tool_use↔tool_result
  and `normalizeTurn` is stable); thinking `signature` / `redacted_thinking` / reasoning blobs opaque
  verbatim; image base64 out-of-line; record usage counts but exclude from matching; ignore
  timestamps/`durationMs`; scope `engine.jsonl` reads by `launchedAt`.

## Hooks (final)

- **pre-commit** (lefthook — net-new tooling): lint `--cache` + `vitest related $(git diff --cached
  --name-only)` — **Tier-1 + unit only** (cheap, a few seconds, offline). NOT Tier-2 goldens: cold-importing the engine module graph is ~20–30s, too heavy per commit.
- **pre-push:** full `npm run check` (which includes Tier-2 `golden:verify`). This is where goldens run — ~80s+, once before sharing.
- **No per-edit / per-turn hooks.** Live tiers (`smoketest`, `golden:record`) **never** auto-run.
- npm scripts: `golden:record` (live, taping), `golden:verify` + `golden:verify:changed` (deterministic).
  Fold `golden:verify` into `check`, gated on tape existence.

## Surfaces to build / rewrite

- **Skills:** `record-tape` (new, load-bearing), `replay-goldens` (new backbone — absorbs old "did I break
  it" triggers), `smoketest` (rewrite → Tier-3), `play` (repurpose → record substrate), `dump-state` (keep).
- **Docs:** rewrite `e2e-harness.md` in place + `CLAUDE.md` "Validating changes end-to-end"; new
  `golden-tapes.md` + `tape-format.md`; retarget `maintenance.md`; recaption module-map/architecture/dev-plan.
- **Memories:** rewrite `feedback_harness_design.md` (keep principles, re-scope framing); add
  `project_tiered_e2e_testing.md`; update `MEMORY.md` lines.

## Retirement

Demote — not delete — the keystroke-injection + 200ms-polling **backbone status**. The sidecar/session-driver
machinery survives as the record pilot's live-driving substrate. The smoketest probe body is the scenario
blueprint; its keystroke choreography (`navigateToRealChoice`, stale-overlay/fingerprint dance) is retired.

## Slices

1. **Tier-2 core** — `tape.ts` + `tape-provider.ts` + env wiring at the seam.
   1a. Prove **replay** against a hand-authored minimal tape, real engine in-process, **no API**.
       (Surfaces edge #3 programmatic-input seam + edge #4 assertion target.)
   1b. One **live record** → real golden → replays green offline.
2. npm scripts + lefthook pre-commit/pre-push + permission entry.
3. Skills: `record-tape` + `replay-goldens`; rewrite/demote `smoketest`; `play` record-mode.
4. Docs rewrite (same commit as the code each describes).
5. Memories.
6. Record the initial corpus (10–15 scenarios).

Main branch only — new infra, not a release bug.

## Open edges (resolved during build / deferred)

- **CI enforcement** of `golden:verify` on PRs — **deferred** until the pre-commit hook proves stable.
- **Programmatic input seam** — replay injects via REST; `endSession()` exists, a "submit turn / select
  choice" endpoint may need adding. Verify in slice 1a.
- **Tier-2 assertion target** — engine-events + save-files (engine in-process, cheap) vs. frame snapshots
  (needs the Ink client too). Lean: Tier-2 asserts on events/saves; leave frame-level to Tier-1. Confirm 1a.
- **Freshness guard** — periodic real-API *structural* re-pilot (tool-calls/state-transitions still match
  though text drifts) so tapes can't silently lie. Design after the rest is solid.
