# @machine-violet/test-harness

End-to-end test harness. Drives the full Machine Violet stack like a human
player via the agent sidecar's HTTP endpoints.

See [docs/e2e-harness.md](../../docs/e2e-harness.md) for the primitives
reference, gotchas, and engine-log breadcrumb catalogue.

## Quick start

```bash
# Cheap precondition — no API key needed, ~10s:
npm run e2e:boot

# The smoke probe — walk setup + observe two in-game turns (live API, 7-12 min):
npm run smoketest
```

Both probes are standalone TypeScript files under `bin/`. There is no
scenario registry — for ad-hoc walks, write your own script following
the same shape.

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
