import { describe, it, expect } from "vitest";
import { toUsageStatus, shouldWarn } from "./usage.js";
import type { RateLimits } from "./protocol.js";

function makeLimits(overrides: Partial<RateLimits> = {}): RateLimits {
  return {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 0 },
    secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 0 },
    planType: "plus",
    rateLimitReachedType: null,
    ...overrides,
  };
}

describe("toUsageStatus", () => {
  it("emits one segment per non-empty window with kind=percentage", () => {
    const status = toUsageStatus(makeLimits({
      primary: { usedPercent: 23.4, windowDurationMins: 300, resetsAt: 1_700_000_000 },
      secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1_700_500_000 },
    }));
    expect(status.segments).toHaveLength(2);
    expect(status.segments[0].id).toBe("primary");
    expect(status.segments[0].kind).toBe("percentage");
    expect(status.segments[0].usedPercent).toBe(23.4);
    expect(status.segments[0].resetsAt).toBe(1_700_000_000);
    expect(status.segments[0].liveUpdates).toBe(true);
    expect(status.segments[0].source).toBe("rpc-notification");
    expect(status.segments[1].id).toBe("secondary");
  });

  it("omits the secondary segment when not provided", () => {
    const status = toUsageStatus(makeLimits({
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1 },
      secondary: undefined,
    }));
    expect(status.segments).toHaveLength(1);
    expect(status.segments[0].id).toBe("primary");
  });

  it("classifies status by usedPercent thresholds", () => {
    const cases: [number, "ok" | "warning" | "critical" | "exceeded"][] = [
      [0, "ok"],
      [50, "ok"],
      [79.9, "ok"],
      [80, "warning"],
      [94.9, "warning"],
      [95, "critical"],
      [99.5, "critical"],
      [100, "exceeded"],
      [150, "exceeded"],
    ];
    for (const [pct, expected] of cases) {
      const status = toUsageStatus(makeLimits({
        primary: { usedPercent: pct, windowDurationMins: 300, resetsAt: 0 },
        secondary: undefined,
      }));
      expect(status.segments[0].status, `at ${pct}%`).toBe(expected);
    }
  });

  it("formats label by window duration", () => {
    const fiveHr = toUsageStatus(makeLimits({
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 0 },
      secondary: undefined,
    }));
    expect(fiveHr.segments[0].label).toBe("5-hour window");

    const sevenDay = toUsageStatus(makeLimits({
      primary: { usedPercent: 0, windowDurationMins: 60 * 24 * 7, resetsAt: 0 },
      secondary: undefined,
    }));
    expect(sevenDay.segments[0].label).toBe("7-day window");

    const oneMin = toUsageStatus(makeLimits({
      primary: { usedPercent: 0, windowDurationMins: 1, resetsAt: 0 },
      secondary: undefined,
    }));
    expect(oneMin.segments[0].label).toBe("1-minute window");
  });

  it("snapshot is fresh and timestamped", () => {
    const before = Date.now();
    const status = toUsageStatus(makeLimits());
    const after = Date.now();
    expect(status.fresh).toBe(true);
    expect(status.snapshotAt).toBeGreaterThanOrEqual(before);
    expect(status.snapshotAt).toBeLessThanOrEqual(after);
  });
});

describe("shouldWarn", () => {
  it("is true when primary >= 80%", () => {
    expect(shouldWarn(makeLimits({
      primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: 0 },
      secondary: undefined,
    }))).toBe(true);
  });

  it("is true when secondary >= 80% even if primary is fine", () => {
    expect(shouldWarn(makeLimits({
      primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 0 },
      secondary: { usedPercent: 95, windowDurationMins: 10080, resetsAt: 0 },
    }))).toBe(true);
  });

  it("is false when both windows are below threshold", () => {
    expect(shouldWarn(makeLimits({
      primary: { usedPercent: 79.99, windowDurationMins: 300, resetsAt: 0 },
      secondary: { usedPercent: 79.99, windowDurationMins: 10080, resetsAt: 0 },
    }))).toBe(false);
  });
});
