---
name: record-tape
description: Record or re-record a golden tape against the live API so it can be replayed deterministically forever after. USE THIS when a golden is legitimately stale (a replay failed because you INTENDED to change DM behavior — a prompt edit, tool change, new behavior), when adding a new scenario to the corpus, or when the user says "record a golden", "re-record", "regenerate the goldens", "the golden is stale", "update the tape", "capture a tape", "/record-tape". Requires a live API key and spends a little budget. For the offline regression check (no recording), use /replay-goldens.
allowed-tools: Bash(npm run golden:record:*), Bash(npm run golden:verify:*), Bash(npx vitest:*), Bash(npm run play:*), Bash(node --import tsx/esm packages/test-harness/bin/mvplay.ts:*), Read, Edit, Write
---

# Record a golden tape

A golden tape is a real recording of the LLM interactions a scenario makes,
captured once against the live API, then replayed offline forever. Recording is
the **only** step that spends API budget — do it deliberately, then commit the
tape and review the diff. **Never hand-edit a tape.** If a tape is wrong, re-record.

There are two kinds of golden, with two record paths.

## A. In-process engine goldens (the corpus) — the common case

These drive the real `GameEngine` directly (DM turns, tool loops, multi-turn
context). They live in
[`packages/engine/src/testing/corpus.golden.test.ts`](../../../packages/engine/src/testing/corpus.golden.test.ts),
one entry per scenario in the `SCENARIOS` array, each with its tape under
`goldens/<name>.golden.json`.

**Re-record a stale golden** (you changed DM behavior on purpose):

```bash
npm run golden:record                       # re-records ALL goldens (live)
# or a subset:
npx cross-env RECORD_GOLDENS=1 npx vitest run golden -t "dm-skill-check"
```

Then **review the git diff** on the `.golden.json` files — confirm the narrative
change is what you intended — and verify it replays:

```bash
npm run golden:verify     # offline, must pass
```

Commit the test + the regenerated tapes together.

**Add a new scenario:** add one entry to `SCENARIOS` (a `name` + a `play(engine)`
that drives `processInput`), record it (`-t "<name>"`), verify, commit. Keep the
mock scene/state coherent with the player input so the DM narrates in character
rather than asking for context — see the seeded scene at the top of the file.

> The record half is gated behind `RECORD_GOLDENS=1`; without it (i.e. in normal
> `npm test`) only the offline replay runs. The key is sourced from `.env`.

## B. Full-stack / setup goldens — live-pilot with mvplay

The in-process path can't reach the **setup agent**, the setup→game handoff, or
the TUI. To capture those you live-pilot the real stack in record mode and pull
the tape out afterward. This is the load-bearing "a Claude live-pilots once to
record" capability.

```bash
mvplay record <scenario> [--player NAME] [--fresh]   # boots in record mode
# ...drive it turn-for-turn exactly like the /play skill:
#    key/say/pick to act, `wait` (run in background) between beats...
mvplay save-tape packages/engine/src/testing/goldens/<scenario>.golden.json
mvplay stop
```

Drive it **yourself**, turn for turn (see the **/play** skill for the loop and
gotchas) — that judgement IS the recording. `save-tape` pulls the tape via the
engine's dev-only `GET /tape` route and writes `{ scenario, tape,
expectedNarrative }`. Pull the tape **before** `mvplay stop` — teardown
force-kills the engine and its in-memory tape with it.

> **Capture works today; deterministic auto-replay of full-stack tapes is the
> open edge.** The in-process corpus is the replay backbone. A captured
> full-stack tape is a real artifact (inspect it, seed a future replay test from
> it), but there is not yet an in-process driver that replays a setup→game tape
> end to end. Setup-agent calls currently bucket as `"default"` (no
> `conversationId`) — the future replay-runner must account for that. Don't
> commit a full-stack tape as a passing golden until that runner exists.

## The discipline (both paths)

- Record deliberately; it costs API. Re-record on **intended** change, not to
  paper over a regression — decide which it is first (see /replay-goldens).
- Never hand-edit a tape. Re-record and review the diff.
- Bias player preferences when you must, but don't co-author the agent's choices
  — the recording should reflect what the agent naturally does. See the memory
  `e2e-harness-is-a-thin-player-simulator-not-a-co-author`.

## Reference

- [docs/golden-tapes.md](../../../docs/golden-tapes.md) — record/replay model, when to re-record.
- [docs/tape-format.md](../../../docs/tape-format.md) — what's in a tape and why.
- [docs/e2e-harness.md](../../../docs/e2e-harness.md) — the three-tier strategy.
