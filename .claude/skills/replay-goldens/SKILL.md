---
name: replay-goldens
description: The fast, deterministic "did I break it?" check — replay the recorded golden tapes offline (no API key, no network, ~4s). USE THIS whenever validating a change for regressions — anything touching the DM loop, the provider/bridge seam, turn processing, tools, state, or context handling — and whenever the user says "did I break it", "run the goldens", "replay goldens", "/replay-goldens", "verify goldens", "is it still working", "run the e2e", "check for regressions". This replaces the old live smoketest as the regression backbone. For a re-record after an INTENDED behavior change, use /record-tape. For a live behavioral smoke against the real API, use /smoketest.
allowed-tools: Bash(npm run golden:verify:*), Bash(npx vitest:*), Bash(npm test:*), Read
---

# Replay goldens (Tier-2 — the regression backbone)

Golden tapes are real LLM interactions, recorded once and replayed
deterministically forever after through the **real** `GameEngine` with **no API
key and no network**. Replaying them is the honest "did I break it?" signal for
cross-cutting changes — it catches regressions in the DM loop, the
provider/bridge seam, turn processing, tools, and context handling in ~4
seconds, every time, for free.

This is the backbone. The live `/smoketest` is now a rare Tier-3 smoke, not the
gate.

## Run it

```bash
npm run golden:verify     # just the goldens — ~4s, offline
```

The goldens also ride the normal suite, so `npm test` / `npm run check` (and the
pre-push hook) verify them too. Use `golden:verify` for a tight loop.

To replay a single scenario while iterating:

```bash
npx vitest run golden -t "dm-skill-check"
```

## Reading the result

- **All pass** → no regression in the taped behavior. Report one line.
- **A replay FAILS** → the engine produced different narrative than the tape for
  the same logical input. Two possibilities, and you must decide which:
  1. **A real regression** — your change broke the DM loop / bridge / tool path.
     Fix the code.
  2. **An intended behavior change** — you *meant* to change what the DM does
     (prompt edit, tool change, new behavior). The golden is now stale. Do NOT
     hand-edit the tape. Re-record it with **`/record-tape`** and review the git
     diff to confirm the change is what you intended.

A "Tape miss" error (the engine asked for an LLM call the tape doesn't have)
means the **shape** of the run changed — a different number/sequence of LLM
calls per agent (e.g. a new subagent fired, or a tool loop got longer). That's
almost always either a real regression or a scenario that needs re-recording.

## What this does NOT do

- It does **not** call the API or prove the live stack boots. For "does it
  actually run end to end against the real model," that's `/smoketest` (Tier-3,
  slow, rare).
- It does **not** record new goldens. That's `/record-tape`.

## Reference

- [docs/golden-tapes.md](../../../docs/golden-tapes.md) — the record/replay model, when to re-record, the corpus.
- [docs/e2e-harness.md](../../../docs/e2e-harness.md) — the full three-tier strategy.
- `packages/engine/src/testing/corpus.golden.test.ts` — the in-process golden corpus.
