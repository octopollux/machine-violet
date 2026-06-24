---
name: smoketest
description: Tier-3 LIVE smoke — boot the full launcher stack (engine + Ink TUI + sidecar) and walk new-campaign setup + two DM turns against the REAL API (~7-12 min, spends budget). Use this RARELY, only when you specifically need to prove the live end-to-end stack behaves — the setup agent, the setup→game handoff, server+client+WebSocket boot — against the real model. Pass `boot-and-quit` for the cheap no-API precondition (~10s). Triggers: "smoke test", "/smoketest", "live smoke", "run the live walk", "boot and quit", "does it boot". For the everyday "did I break it?" regression check, DON'T use this — use /replay-goldens (offline, ~4s). To record a golden, use /record-tape.
allowed-tools: Bash(npm run smoketest:*), Bash(npm run e2e:boot:*), Read
---

# Smoketest (Tier-3 — live, rare)

This is the **thin live smoke**, not the regression backbone. It boots the real
launcher stack and walks the real setup→game flow against the **live API**. It's
slow (~7-12 min) and spends budget, so reach for it only when you specifically
need to prove the *live* stack behaves end to end — the setup agent, the
setup→game handoff, the server+client+WebSocket boot path.

**For "did I break it?" use [`/replay-goldens`](../replay-goldens/SKILL.md)** —
deterministic, offline, ~4s. The goldens replay real DM turns through the real
engine with no API. That's the gate now. The smoketest is the occasional
live confirmation on top.

There are exactly two probes here:

| User says... | Run | API? | ~Time |
|---|---|---|---|
| `/smoketest boot-and-quit`, "just check it boots" | `npm run e2e:boot` | no | ~10s |
| `/smoketest`, "live smoke", "run the live walk" | `npm run smoketest` | **yes** | 7-12 min |

`boot-and-quit` is the cheap precondition for everything else — launcher boots,
sidecar reachable, main menu renders, clean teardown. Run it freely. The full
`smoketest` is the live one; run it deliberately.

## How to invoke

Use the `Bash` tool with `run_in_background: true`:

```bash
npm run smoketest      # or: npm run e2e:boot
```

Then keep working — write a commit message, draft a doc edit, run `/replay-goldens`.
The harness re-invokes you with a `<task-notification>` when the process exits.

- **Do NOT delegate to a subagent.** Subagent `Bash` has a 10-minute hard cap
  that orphans a slow run mid-poll. Main-thread background does not.
- **Do NOT tail the output file in subsequent turns.** Wait for the notification.

## What `smoketest` actually does

1. Boot to the main menu.
2. Select "New Campaign", enter the setup-agent conversation.
3. Walk setup: pick the first real choice at each `present_choices`, submit
   `"you decide"` for free-text prompts.
4. Wait for the setup → live handoff (state-driven; never a wall-clock sleep).
5. Submit one player action, wait for the DM's response.
6. Submit a second action, wait for that response too.

Then it hard-kills the launcher. **Save & Exit is intentionally not part of the
walk** (it's covered by unit tests on `session-manager`).

## Reading the result

The harness writes one terminal line as its last output:

- `✔ OK <probe> (<n>s)` — pass. Report one line with the wall-clock time.
- `✘ FAIL <probe> (<n>s)` — fail, followed by a structured dump (error, stack,
  last 50 lines of launcher output, `/state`, `/screen`, engine-log tail). Paste
  the dump verbatim; let the human or next agent read it.

## When to reach for something else

- **Everyday regression check ("did I break it?")** → `/replay-goldens` (offline, fast). This is almost always what you want.
- **Record/refresh a golden** → `/record-tape`.
- **Interactively play / feel out a path** (a specific personality, a world, reproducing an in-game bug by hand) → the `/play` skill (`mvplay`). You stay in the loop, turn for turn.
- **A repeatable pass/fail on a specific path** (save/load round-trip, image-gen persisted) → write a one-shot `runProbe` script; see [docs/e2e-harness.md](../../../docs/e2e-harness.md) "Writing a probe."

## Reference

- [docs/e2e-harness.md](../../../docs/e2e-harness.md) — the three-tier strategy, harness primitives, engine-state gotchas, engine-log breadcrumbs, how to write a probe.
- [packages/test-harness/bin/smoketest.ts](../../../packages/test-harness/bin/smoketest.ts) — the live walk source.
- [packages/test-harness/bin/boot-and-quit.ts](../../../packages/test-harness/bin/boot-and-quit.ts) — the precondition source.
