import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { disableReactPerfTrackUnlessRequested, shouldKeepReactPerfTrack } from "./react-perf-track.js";

// Reproduce a real Node process — which HAS `console.timeStamp` (vitest's console
// shim omits it) — then apply our fix, ALL BEFORE Ink/react-reconciler is imported
// anywhere in this file. react-reconciler captures `supportsUserTiming` exactly
// ONCE, when it first evaluates (vitest's resetModules can't re-evaluate an
// externalized node_modules dep — Node's require cache persists), so the state we
// leave here is the state the GUARD's render observes. Installing the probe and
// THEN clearing it via the helper makes the GUARD non-trivial: if the helper ever
// stops clearing it, the reconciler captures `true` and the render below emits.
(console as { timeStamp?: unknown }).timeStamp = () => {};
const disabledAtLoad = disableReactPerfTrackUnlessRequested({});

describe("React dev Performance Track suppression (#694)", () => {
  it("GUARD: a real Ink render emits ZERO performance measures once the track is disabled", async () => {
    expect(disabledAtLoad).toBe(true);
    expect(console.timeStamp).toBeUndefined(); // the probe React reads at eval-time is gone

    const React = (await import("react")).default;
    const { render } = await import("ink-testing-library");
    const { Text } = await import("ink");

    performance.clearMeasures();
    const { rerender, unmount } = render(React.createElement(Text, null, "0"));
    for (let i = 1; i <= 30; i++) rerender(React.createElement(Text, null, String(i)));
    unmount();

    expect(performance.getEntriesByType("measure").length).toBe(0);
  });

  it("CANARY: react-reconciler still gates its Performance Track on `typeof console.timeStamp`", () => {
    // The exact probe our fix neutralizes. If a React upgrade renames/removes this
    // gate, clearing console.timeStamp would silently stop suppressing the track
    // (the GUARD could pass vacuously) — fail here so we re-derive the mechanism.
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve("react-reconciler/package.json");
    const devBuild = join(dirname(pkgJson), "cjs", "react-reconciler.development.js");
    const src = readFileSync(devBuild, "utf8");
    expect(src).toContain("typeof console.timeStamp");
  });

  it("respects MV_REACT_PERF_TRACK opt-in: leaves the probe untouched so profiling still works", () => {
    for (const v of ["1", "true", "on", "yes", "YES"]) {
      const stub = () => {};
      (console as { timeStamp?: unknown }).timeStamp = stub;
      expect(shouldKeepReactPerfTrack({ MV_REACT_PERF_TRACK: v })).toBe(true);
      expect(disableReactPerfTrackUnlessRequested({ MV_REACT_PERF_TRACK: v })).toBe(false);
      expect(console.timeStamp).toBe(stub); // untouched
    }
  });

  it("treats absent/empty/other values as opted-out (default off)", () => {
    for (const env of [{}, { MV_REACT_PERF_TRACK: "" }, { MV_REACT_PERF_TRACK: "0" }, { MV_REACT_PERF_TRACK: "off" }]) {
      expect(shouldKeepReactPerfTrack(env)).toBe(false);
    }
  });
});
