# @machine-violet/test-harness

End-to-end test harness. Drives the full Machine Violet stack like a human
player via the agent sidecar's HTTP endpoints.

Two modes, same launcher + sidecar:
- **Scripted probes** (`runProbe`) — spawn, run a fixed body, assert, kill.
  For pass/fail checks (`smoketest`, `boot-and-quit`, ad-hoc one-shots).
- **Interactive play** (`mvplay`) — a persistent session you drive turn-for-turn,
  one command per turn. For actually *playing* the game. See below.

See [docs/e2e-harness.md](../../docs/e2e-harness.md) for the primitives
reference, gotchas, and engine-log breadcrumb catalogue.

## Quick start

```bash
# Cheap precondition — no API key needed, ~10s:
npm run e2e:boot

# The smoke probe — walk setup + observe two in-game turns (live API, 7-12 min):
npm run smoketest
```

Both probes are standalone TypeScript files under `bin/`. For ad-hoc
walks (a specific personality, save/load round-trip, image consent flow,
etc.), write your own script using `runProbe` — see Library usage below.

## Library usage

```ts
import { runProbe, DEFAULT_TURN_TIMEOUT_MS } from "@machine-violet/test-harness";

await runProbe({
  name: "my-probe",
  title: "What this probe proves",
  body: async ({ harness, log }) => {
    log("Waiting for main menu...");
    await harness.waitForScreen("Machine Violet");
    await harness.sendKey("return"); // pick "New Campaign"

    // `mode` stays "play" throughout the setup conversation — the setup
    // session runs under a synthetic campaign id "__setup__". Watch for
    // that instead. See docs/e2e-harness.md "Engine-state surprises" for
    // the full list of non-obvious state signals.
    await harness.waitForState(
      (s) => s.currentTurn?.campaignId === "__setup__" && s.currentTurn?.status === "open",
      { description: "setup turn opens", timeoutMs: DEFAULT_TURN_TIMEOUT_MS },
    );
    // ...
  },
});
```

Run with `node --import tsx/esm path/to/my-probe.ts`. `runProbe` handles
launch, the error dump on failure (stack + launcher tail + /state +
/screen + engine-log tail), and clean shutdown.

## Interactive play (mvplay)

When you want to *play* rather than assert, `bin/mvplay.ts` keeps a persistent
launcher + sidecar alive in the background so you submit one turn per command:

```bash
npm run play -- start              # boot to the main menu
npm run play -- key return         # select "New Campaign"
npm run play -- wait               # (run in background) settle on the next beat
npm run play -- pick 1             # answer a choice
npm run play -- say "you decide"   # answer a free-text prompt
# ... walk setup to handoff, then play in-game turns ...
npm run play -- say "I open the door and step through"
npm run play -- wait               # (run in background) → prints the DM's reply
npm run play -- stop
```

`say`/`pick` confirm the input registered and retry once (the engine can drop a
keystroke during the scribe's post-turn finalization — see the gotcha in the
doc). `wait` is the slow one (a DM turn is 1-5 min); run it with
`run_in_background` so you're re-invoked on exit. Full command table and the
turn loop are in [docs/e2e-harness.md](../../docs/e2e-harness.md) under
"Interactive play (mvplay)"; the `/play` skill is the canonical agent handle.
