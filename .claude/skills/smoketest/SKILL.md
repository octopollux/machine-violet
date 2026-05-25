---
name: smoketest
description: Run the Machine Violet end-to-end smoke test against the local repo. Default scenario is `golden-path` — the full new-campaign → live DM turn cycle, ~5-7 minutes, real LLM API calls. Pass `boot-and-quit` for the cheap precondition (no API key, ~10s). Args are freeform — `golden-path, with The Crossroads as the DM personality` is valid. USE THIS SKILL whenever validating cross-cutting changes — anything touching UI flow, session lifecycle, the setup agent, the DM loop, save/load, or any code path that spans server + client + WebSocket — and whenever the user says "smoke test", "/smoketest", "run the harness", "validate end-to-end", "golden path", "run e2e", "did I break it", "is it still working". Type checks and unit tests do not prove the flow works end-to-end; the harness does.
allowed-tools: Bash(npm run e2e:*), Bash(npm run e2e -- :*), Bash(SMOKETEST_*:*), Read
---

# Smoketest

Runs `packages/test-harness` against the full launcher stack (engine server + Ink TUI client + agent sidecar). The harness drives the TUI like a human player and asserts state-driven success.

## Parse the args

`$ARGUMENTS` is **freeform**. Default scenario is `golden-path`.

Parse it as:

1. **Scenario id** — usually the first token (or first comma-separated chunk). If it matches a scenario in `packages/test-harness/src/scenarios/`, that's the scenario. Otherwise treat all of `$ARGUMENTS` as tweaks and default to `golden-path`.
2. **Tweaks** — anything past the scenario id is freeform natural-language guidance. Interpret it and apply.

Available scenarios today:

- `golden-path` — full live cycle. ~5-7 min. Real LLM calls. The baseline every cross-cutting change should clear.
- `boot-and-quit` — confirms the launcher boots and the main menu renders. ~10s. No API key needed. The precondition for everything else.

### Applying tweaks

Map the natural-language tweak onto an existing scenario hook. Today's hooks:

- **DM personality preference** (golden-path only) — env var `SMOKETEST_PERSONALITY="<name>"`. When set, the scenario prefers that personality if it appears in the offered choices, and injects the name into the first free-text answer as a hint to the setup agent. Pass the exact display name (e.g. `"The Crossroads"`).

If the tweak doesn't map to an existing hook, you have two options:

- **Add a new hook** if the tweak is likely to recur — extend the scenario with another env var, default to current behavior when unset, then invoke with that env var set. Land the new hook with the smoketest run.
- **Temporarily edit the scenario** for a one-off — make the change, run, then revert. Do not commit the temp edit.

If the tweak is too vague to act on confidently, ask the user instead of guessing.

## How to invoke

Use the `Bash` tool with `run_in_background: true`. Set any env-var tweaks inline:

```bash
# No tweaks:
npm run e2e:golden-path
# or
npm run e2e -- <scenario-id>

# With env-var tweaks:
SMOKETEST_PERSONALITY="The Crossroads" npm run e2e -- golden-path
```

Then continue with whatever else needs doing in the same turn — write a commit message, draft a follow-up doc edit, sketch the next change. The harness auto-invokes you with a `<task-notification>` when the process exits.

**Do NOT delegate this to a subagent.** Subagent `Bash` has a 10-minute hard cap that orphans the run mid-poll on a worst-case golden-path. Main-thread background does not share that cap. (`boot-and-quit` is short enough that delegating it is fine, but there's no real reason to — the main-thread pattern works for both.)

**Do NOT tail the output file in subsequent turns.** Wait for the notification. Polling adds nothing and burns context.

## Reading the result

The notification arrives with the output file path. The harness writes exactly one terminal line as its last output:

- `✔ OK <scenario> (<n>s)` — pass. Report one line with the wall-clock time. Nothing else.
- `✘ FAIL <scenario> (<n>s)` — fail, followed by a structured dump (error, stack, last 50 lines of launcher output, `/state`, `/screen`). Paste the dump verbatim. Do not summarize, do not propose fixes inline, do not interpret the DM's narrative — let the human or next agent read it and decide.

## Running lint and tests at the same time

When you're finishing a cross-cutting change, kick off `npm run check` (lint + tests, ~80s) in parallel — but as a `general-purpose` subagent, not in the main thread. Both validations cover different ground: lint/tests catch code-level breakage in seconds; smoketest catches behavioral breakage over minutes. Launch both in the same turn so they run concurrently while you keep working.

## Reference

See [docs/e2e-harness.md](../../../docs/e2e-harness.md) for the scenario catalogue, harness primitives (`Harness.launch`, `waitFor*` family, `sendKey`/`submitText`), the engine-state pitfalls section (why certain naive predicates time out), and how to author a new scenario.
