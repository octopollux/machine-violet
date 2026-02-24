import { describe, it, expect } from "vitest";
import { CostTracker, formatK } from "./cost-tracker.js";
import type { UsageStats } from "../agents/agent-loop.js";

describe("formatK", () => {
  it("returns plain number below 1000", () => {
    expect(formatK(0)).toBe("0");
    expect(formatK(832)).toBe("832");
    expect(formatK(999)).toBe("999");
  });

  it("formats thousands with k suffix", () => {
    expect(formatK(1000)).toBe("1k");
    expect(formatK(1500)).toBe("1.5k");
    expect(formatK(2400)).toBe("2.4k");
    expect(formatK(10000)).toBe("10k");
    expect(formatK(150000)).toBe("150k");
  });

  it("formats millions with M suffix", () => {
    expect(formatK(1_000_000)).toBe("1M");
    expect(formatK(1_200_000)).toBe("1.2M");
    expect(formatK(15_000_000)).toBe("15M");
  });
});

describe("CostTracker", () => {
  const usage: UsageStats = {
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 5000,
    cacheCreationTokens: 0,
  };

  it("tracks tokens per tier", () => {
    const tracker = new CostTracker();
    tracker.record(usage, "large");

    const b = tracker.getBreakdown();
    expect(b.byTier.large.input).toBe(1200); // inputTokens + outputTokens
    expect(b.byTier.large.output).toBe(200);
    expect(b.byTier.large.cached).toBe(5000);
    expect(b.byTier.medium.input).toBe(0);
    expect(b.byTier.small.input).toBe(0);
  });

  it("accumulates across multiple calls", () => {
    const tracker = new CostTracker();
    tracker.record(usage, "large");
    tracker.record(usage, "small");

    const b = tracker.getBreakdown();
    expect(b.apiCalls).toBe(2);
    expect(b.tokens.inputTokens).toBe(2000);
    expect(b.tokens.outputTokens).toBe(400);
    expect(b.tokens.cacheReadTokens).toBe(10000);
    expect(b.byTier.large.input).toBe(1200);
    expect(b.byTier.small.input).toBe(1200);
  });

  it("returns independent copies from getBreakdown", () => {
    const tracker = new CostTracker();
    tracker.record(usage, "large");

    const b1 = tracker.getBreakdown();
    const b2 = tracker.getBreakdown();
    b1.byTier.large.input = 999999;
    b1.apiCalls = 999;
    expect(b2.byTier.large.input).toBe(1200);
    expect(b2.apiCalls).toBe(1);
  });

  describe("formatTokens", () => {
    it("returns empty string when no tokens recorded", () => {
      const tracker = new CostTracker();
      expect(tracker.formatTokens()).toBe("");
    });

    it("formats single tier", () => {
      const tracker = new CostTracker();
      tracker.record({ inputTokens: 5000, outputTokens: 200, cacheReadTokens: 40000, cacheCreationTokens: 0 }, "large");
      expect(tracker.formatTokens()).toBe("L 5.2k/40k");
    });

    it("formats multiple tiers, skips empty ones", () => {
      const tracker = new CostTracker();
      tracker.record({ inputTokens: 5000, outputTokens: 200, cacheReadTokens: 40000, cacheCreationTokens: 0 }, "large");
      tracker.record({ inputTokens: 2000, outputTokens: 0, cacheReadTokens: 15000, cacheCreationTokens: 0 }, "medium");
      // small has nothing
      expect(tracker.formatTokens()).toBe("L 5.2k/40k | M 2k/15k");
    });

    it("shows all three tiers when all have usage", () => {
      const tracker = new CostTracker();
      tracker.record({ inputTokens: 5000, outputTokens: 200, cacheReadTokens: 40000, cacheCreationTokens: 0 }, "large");
      tracker.record({ inputTokens: 2000, outputTokens: 0, cacheReadTokens: 15000, cacheCreationTokens: 0 }, "medium");
      tracker.record({ inputTokens: 8000, outputTokens: 0, cacheReadTokens: 60000, cacheCreationTokens: 0 }, "small");
      expect(tracker.formatTokens()).toBe("L 5.2k/40k | M 2k/15k | S 8k/60k");
    });
  });
});
