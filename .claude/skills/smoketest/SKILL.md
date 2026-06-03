---
name: smoketest
description: Run the Machine Violet end-to-end smoke probe — walks new-campaign setup once and observes two in-game player/DM turn cycles against the local repo. ~7-12 minutes, real LLM API calls. Pass `boot-and-quit` for the cheap precondition (no API key, ~10s). USE THIS SKILL whenever validating cross-cutting changes — anything touching UI flow, session lifecycle, the setup agent, the DM loop, save/load, or any code path that spans server + client + WebSocket — and whenever the user says "smoke test", "/smoketest", "run the harness", "validate end-to-end", "smoketest", "run e2e", "did I break it", "is it still working". Type checks and unit tests do not prove the flow works end-to-end; the harness does.
allowed-tools: Bash(npm run smoketest:*), Bash(npm run e2e:boot:*), Read
---

# Smoketest

Runs `packages/test-harness` against the full launcher stack (engine server + Ink TUI client + agent sidecar). The harness drives the TUI like a human player and asserts state-driven success.

There are exactly two long-lived probes. Pick one based on what the user typed:

| User says... | Run |
|---|---|
| `/smoketest`, "smoke test", "run the harness", "did I break it", etc. | `npm run smoketest` |
| `/smoketest boot-and-quit`, "just check it boots" | `npm run e2e:boot` |
| Anything else | Don't invent a third probe — see "Custom walks" below. |

## How to invoke

Use the `Bash` tool with `run_in_background: true`:

```bash
npm run smoketest
# or
npm run e2e:boot
```

Then continue with whatever else needs doing in the same turn — write a commit message, draft a follow-up doc edit, sketch the next change. The harness auto-invokes you with a `<task-notification>` when the process exits.

**Do NOT delegate this to a subagent.** Subagent `Bash` has a 10-minute hard cap that orphans a slow smoketest run mid-poll. Main-thread background does not share that cap. (`e2e:boot` is short enough that delegating it is fine, but there's no real reason to.)

**Do NOT tail the output file in subsequent turns.** Wait for the notification. Polling adds nothing and burns context.

## Reading the result

The notification arrives with the output file path. The harness writes exactly one terminal line as its last output:

- `✔ OK <probe> (<n>s)` — pass. Report one line with the wall-clock time. Nothing else.
- `✘ FAIL <probe> (<n>s)` — fail, followed by a structured dump (error, stack, last 50 lines of launcher output, `/state`, `/screen`, engine-log tail). Paste the dump verbatim. Do not summarize, do not propose fixes inline, do not interpret the DM's narrative — let the human or next agent read it and decide.

## Running lint and tests at the same time

When you're finishing a cross-cutting change, kick off `npm run check` (lint + tests, ~80s) in parallel — but as a `general-purpose` subagent, not in the main thread. Both validations cover different ground: lint/tests catch code-level breakage in seconds; the harness catches behavioral breakage over minutes. Launch both in the same turn so they run concurrently while you keep working.

## Custom walks

`smoketest` is deliberately rigid: walk setup with `"you decide"` + first-choice, then two turns. That's it. It does NOT take args, env-var hooks, or a "with The Crossroads as personality" tweak. If you need a different path, pick by what you're actually after:

- **To interactively *play* / feel out a path** — a specific personality, a particular world, reproducing an in-game bug by hand — use the **`/play` skill** (`mvplay`). It's a persistent session you drive turn-for-turn; you stay in the loop. Don't write a rigid scripted probe (and don't hand it to a subagent) just to watch the game behave — that throws away your per-turn judgement. See [docs/e2e-harness.md](../../../docs/e2e-harness.md) "Interactive play (mvplay)".
- **For a repeatable pass/fail assertion** on a path — save/load round-trip, image-gen persisted, a deterministic regression guard — write your own one-shot probe inline.

A probe is just a `runProbe` call with a body function:

```ts
// e.g. packages/test-harness/bin/my-adhoc.ts (or any other path)
import { runProbe, DEFAULT_TURN_TIMEOUT_MS } from "@machine-violet/test-harness";

await runProbe({
  name: "my-adhoc",
  title: "Walk setup and check images persist",
  body: async ({ harness, log }) => {
    // ... use harness.sendKey / submitText / waitForState / waitForEngineEvent / readEngineLog ...
  },
});
```

Run with `node --import tsx/esm <path>`. `runProbe` handles launch, the error dump on failure (stack + launcher tail + /state + /screen + engine-log tail), and clean shutdown.

The full primitives reference, engine-state gotchas, engine-log breadcrumb catalogue, and signal-picking cheatsheet live in [docs/e2e-harness.md](../../../docs/e2e-harness.md). Read it before writing your first probe — most of the surprising failure modes are documented there with the failed run that found them.

## Reference

- [docs/e2e-harness.md](../../../docs/e2e-harness.md) — primitives, gotchas, breadcrumbs, how to write a probe.
- [packages/test-harness/bin/smoketest.ts](../../../packages/test-harness/bin/smoketest.ts) — the smoketest source. Copy-and-modify template for ad-hoc probes.
- [packages/test-harness/bin/boot-and-quit.ts](../../../packages/test-harness/bin/boot-and-quit.ts) — the precondition source. The minimal probe shape.
