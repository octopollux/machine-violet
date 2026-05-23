# @machine-violet/test-harness

End-to-end test harness. Drives the full Machine Violet stack like a human
player via the agent sidecar's HTTP endpoints.

See [docs/e2e-harness.md](../../docs/e2e-harness.md) for the full reference,
scenario catalogue, and authoring guide.

## Quick start

```bash
# Quick precondition — no API key needed:
npm run e2e:boot

# The baseline smoke test (live API, 5-10 min):
npm run e2e:golden-path

# Custom scenario:
npm run e2e -- <scenario-id>
```

## Library usage

```ts
import { Harness } from "@machine-violet/test-harness";

const h = await Harness.launch();
try {
  await h.waitForScreen("Machine Violet");
  await h.sendKey("return"); // pick "New Campaign"
  // `mode` stays "play" throughout the setup conversation — the setup
  // session runs under a synthetic campaign id "__setup__". Watch for
  // that instead. See docs/e2e-harness.md "Engine-state surprises" for
  // the full list of non-obvious state signals.
  await h.waitForState(
    (s) => s.currentTurn?.campaignId === "__setup__" && s.currentTurn?.status === "open",
    { description: "setup turn opens", timeoutMs: 60_000 },
  );
  // ...
} finally {
  await h.shutdown();
}
```
