---
name: smoketest
description: Run the Machine Violet end-to-end smoke test against the local repo. Default scenario is `golden-path` — the full new-campaign → live DM turn cycle, ~5-7 minutes, real LLM API calls. Pass `boot-and-quit` for the cheap precondition (no API key, ~10s). USE THIS SKILL whenever validating cross-cutting changes — anything touching UI flow, session lifecycle, the setup agent, the DM loop, save/load, or any code path that spans server + client + WebSocket — and whenever the user says "smoke test", "/smoketest", "run the harness", "validate end-to-end", "golden path", "run e2e", "did I break it", "is it still working". Type checks and unit tests do not prove the flow works end-to-end; the harness does.
---

# Smoketest

Runs `packages/test-harness` against the full launcher stack (engine server + Ink TUI client + agent sidecar). The harness drives the TUI like a human player and asserts state-driven success.

## Pick the scenario

If `$ARGUMENTS` is non-empty, use it as the scenario id. Otherwise default to `golden-path`.

Available scenarios live in `packages/test-harness/src/scenarios/`. Today:

- `golden-path` — full live cycle. ~5-7 min. Real LLM calls. The baseline every cross-cutting change should clear.
- `boot-and-quit` — confirms the launcher boots and the main menu renders. ~10s. No API key needed. The precondition for everything else.

## How to invoke

Use the `Bash` tool with `run_in_background: true`:

```
npm run e2e -- <scenario>
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
