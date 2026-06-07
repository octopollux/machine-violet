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

## A. In-process corpora (the common case)

Two co-located corpora inject a provider directly and replay offline. Both gate
their record half behind `RECORD_GOLDENS=1` (without it, normal `npm test` runs
only the offline replay); the key is sourced from `.env`.

**The DM corpus** —
[`corpus.golden.test.ts`](../../../packages/engine/src/testing/corpus.golden.test.ts):
drives the real `GameEngine` (DM turns, tool loops, multi-turn context), one
entry per scenario in `SCENARIOS`, tape at `goldens/<name>.golden.json`.

**The setup corpus** —
[`setup-corpus.golden.test.ts`](../../../packages/engine/src/testing/setup-corpus.golden.test.ts):
drives the real `createSetupConversation` to `finalize_setup`, then the real
`buildCampaignWorld` handoff. One entry per scenario in `SETUP_SCENARIOS`.

**Re-record a stale golden** (you changed behavior on purpose):

```bash
npm run golden:record                       # re-records ALL goldens, both corpora (live)
# or a subset:
npx cross-env RECORD_GOLDENS=1 npx vitest run golden -t "dm-skill-check"
npx cross-env RECORD_GOLDENS=1 npx vitest run setup-corpus -t "setup-custom-noir"
```

Then **review the git diff** on the `.golden.json` files — confirm the change is
what you intended — and verify it replays:

```bash
npm run golden:verify     # offline, must pass
```

Commit the test + the regenerated tapes together.

**Add a DM scenario:** one entry in `SCENARIOS` (a `name` + a `play(engine)` that
drives `processInput`); keep the mock scene/state coherent with the input so the
DM narrates in character. **Add a setup scenario:** one entry in
`SETUP_SCENARIOS` — front-load the content the agent gates on (crucially the
player's *name*); the bounded finalize loop confirms until the tool fires. Set
`MV_SETUP_TRACE=1` to print the turn-by-turn flow when authoring/recording.
Record (`-t "<name>"`), verify, commit.

## B. Full-stack goldens — live-pilot with mvplay

The in-process corpora cover the setup *agent conversation* and the DM loop. What
they can't reach is the live stack: the setup→game handoff through the real
`SessionManager` loader, the WebSocket events, the TUI render. To capture those
you live-pilot the real stack in record mode and pull the tape out afterward.
This is the load-bearing "a Claude live-pilots once to record" capability.

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
> open edge.** The in-process corpora are the replay backbone (the setup agent
> now replays offline via the setup corpus). A captured full-stack tape is a real
> artifact (inspect it, seed a future test from it), but there is not yet a
> driver that replays one through the server stack — the capture records neither
> the player inputs nor a replayable narrative segmentation. Don't commit a
> full-stack tape as a passing golden until that runner exists.

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
