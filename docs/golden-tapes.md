# Golden Tapes (Tier-2 — the deterministic backbone)

A **golden tape** is a real recording of every LLM interaction a scenario makes,
captured once against the live API and replayed deterministically forever after
through the **real** `GameEngine` — with **no API key and no network**. Replaying
the goldens is Machine Violet's regression backbone: the honest "did I break
it?" signal for anything touching the DM loop, the provider/bridge seam, turn
processing, tools, or context handling, in ~4 seconds, for free, every time.

This replaces the old live-smoketest-as-gate. The live [smoketest](e2e-harness.md)
is now a rare Tier-3 confirmation, not the gate.

> **Tape format details** (schema, bucketing, ordinal matching, determinism
> normalization) live in [tape-format.md](tape-format.md). This doc is the
> operating model: how to record, replay, and keep tapes honest.

## The loop

```bash
npm run golden:verify     # replay all goldens offline (~4s, no key)
npm run golden:record     # re-record all goldens against the live API (spends budget)
```

The goldens are co-located vitest tests, so they also ride the normal
`npm test` / `npm run check` suite (and the pre-push hook). `golden:verify` is
just the fast targeted subset.

The load-bearing capability: a Claude (or a human) records a golden **once**;
replay thereafter needs no Claude and no API. Adapting to change = re-record +
review a readable git diff. **Never hand-edit a tape.**

## The two record paths

### A. In-process engine goldens (the corpus)

The common case. Scenarios drive the real `GameEngine` directly — DM turns, tool
loops, multi-turn context — in
[`packages/engine/src/testing/corpus.golden.test.ts`](../packages/engine/src/testing/corpus.golden.test.ts).
Each entry in the `SCENARIOS` array is a `name` + a `play(engine)` that calls
`processInput`, with its tape at `goldens/<name>.golden.json`.

Recording: the test's record half is gated behind `RECORD_GOLDENS=1` (it spends
API); without it, only the offline replay runs. A taping decorator
(`createTapingProvider`) wraps a real provider and captures the I/O; replay uses
`createReplayProvider` over the saved tape.

```bash
npm run golden:record                                   # all
npx cross-env RECORD_GOLDENS=1 npx vitest run golden -t "dm-skill-check"   # one
```

Subagents (scribe / scene-tracker / ai-player / character-promotion) are mocked
to no-ops in the corpus so each golden is a single deterministic DM bucket — the
golden's job is the DM turn and its tool loop, not subagent behavior (which has
its own tests). Keep the seeded scene coherent with each player input so the DM
narrates in character rather than asking for context.

### B. Full-stack / setup goldens (live-pilot via mvplay)

The in-process path can't reach the **setup agent**, the setup→game handoff, or
the TUI. To capture those, live-pilot the real stack in record mode and pull the
tape out afterward:

```bash
mvplay record <scenario> [--player NAME] [--fresh]   # boots with MV_TAPE_MODE=record
# ...drive it turn-for-turn, exactly like the /play skill...
mvplay save-tape packages/engine/src/testing/goldens/<scenario>.golden.json
mvplay stop
```

`save-tape` pulls the tape via the engine's dev-only `GET /tape` route and writes
`{ scenario, tape, expectedNarrative }`. Pull it **before** `mvplay stop` — the
teardown force-kills the engine (and its in-memory tape) without running exit
handlers, which is exactly why the tape is read over an HTTP route rather than
flushed on exit (see `packages/engine/src/providers/tape-mode.ts`).

> **Capture works; deterministic auto-replay of full-stack tapes is the open
> edge.** A captured full-stack tape is a real artifact you can inspect or seed a
> future replay test from, but there is not yet an in-process driver that
> replays a setup→game tape end to end. Setup-agent calls currently carry no
> `conversationId`, so they bucket as `"default"` — the future replay-runner must
> account for that. Don't commit a full-stack tape as a passing golden until that
> runner exists; the in-process corpus is the replay backbone.

## How recording is wired

One seam covers everything. `wrapForRecording(tiers)`
(`packages/engine/src/providers/tape-mode.ts`) is called at every
provider-resolution site (`session-manager.ts`, `setup-session.ts`); when
`MV_TAPE_MODE=record` it decorates each tier's provider with the taping shim into
one process-global writer, deduped by provider identity. Production never sets
`MV_TAPE_MODE`, so it's an identity pass-through. In-process corpus tests skip
this and wrap the provider directly.

## When to re-record vs. fix the code

A failing replay means the engine produced different narrative (or a different
LLM-call shape — a "Tape miss") than the tape for the same logical input. Decide
which:

- **Real regression** — your change broke the DM loop / bridge / tool path. Fix
  the code; the golden was right.
- **Intended behavior change** — you meant to change what the DM does (prompt
  edit, tool change). The golden is stale: re-record it (`/record-tape` /
  `golden:record`) and review the diff to confirm the change is what you wanted.

## Hooks

- **pre-commit** (lefthook): lint (cached) + `vitest related --run` on staged
  files — Tier-1/unit only, offline, a few seconds. NOT the goldens (cold-import
  of the engine graph is ~20-30s, too heavy per commit).
- **pre-push**: full `npm run check`, which includes the golden replays.

Activated by `npm install` (the root `prepare` runs `lefthook install`).

## Deferred / open edges

- **Full-stack replay-runner** — capturing a setup→game tape works (`mvplay
  save-tape`); replaying one deterministically in-process does not exist yet. The
  in-process corpus is the backbone; full-stack tapes are capture-only until a
  runner that drives `SetupSession` + `GameEngine` from a tape is built (and
  handles the `"default"` setup bucket).
- **CI enforcement** of `golden:verify` on PRs — deferred until the pre-commit
  hook has proven stable in practice.
- **Freshness guard** — a periodic real-API *structural* re-pilot (tool calls /
  state transitions still match though text drifts) so tapes can't silently lie.
  Designed later.
- **Image bytes out-of-line** — `generateImage` base64 is inline; move to a
  content-addressed sidecar before image-bearing goldens land (see
  [tape-format.md](tape-format.md)).

## Related

- [tape-format.md](tape-format.md) — the on-disk tape schema and matching rules.
- [e2e-harness.md](e2e-harness.md) — the three-tier strategy and the live Tier-3 harness.
- Skills: `/replay-goldens` (verify), `/record-tape` (record), `/play` (live-pilot substrate).
