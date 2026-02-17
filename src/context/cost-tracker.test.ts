import { describe, it, expect } from "vitest";
import { CostTracker, calculateCost } from "./cost-tracker.js";
import type { UsageStats } from "../agents/agent-loop.js";

describe("calculateCost", () => {
  it("calculates Opus cost correctly", () => {
    const usage: UsageStats = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 2000,
      cacheCreationTokens: 0,
    };
    const cost = calculateCost(usage, "claude-opus-4-6");
    // 1000 * 5/1M + 500 * 25/1M + 2000 * 0.50/1M
    // = 0.005 + 0.0125 + 0.001
    // = 0.0185
    expect(cost).toBeCloseTo(0.0185, 4);
  });

  it("calculates Haiku cost correctly", () => {
    const usage: UsageStats = {
      inputTokens: 5000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    const cost = calculateCost(usage, "claude-haiku-4-5-20251001");
    // 5000 * 1/1M + 200 * 5/1M
    // = 0.005 + 0.001
    // = 0.006
    expect(cost).toBeCloseTo(0.006, 4);
  });

  it("includes cache creation cost", () => {
    const usage: UsageStats = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 10000,
    };
    const cost = calculateCost(usage, "claude-opus-4-6");
    // 10000 * 6.25/1M = 0.0625
    expect(cost).toBeCloseTo(0.0625, 4);
  });
});

describe("CostTracker", () => {
  it("tracks cumulative costs across calls", () => {
    const tracker = new CostTracker();

    tracker.record(
      { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 },
      "claude-opus-4-6",
    );
    tracker.record(
      { inputTokens: 2000, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
      "claude-haiku-4-5-20251001",
    );

    const breakdown = tracker.getBreakdown();
    expect(breakdown.apiCalls).toBe(2);
    expect(breakdown.tokens.inputTokens).toBe(3000);
    expect(breakdown.tokens.outputTokens).toBe(150);
    expect(breakdown.totalCost).toBeGreaterThan(0);
  });

  it("tracks costs by model", () => {
    const tracker = new CostTracker();

    tracker.record(
      { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 },
      "claude-opus-4-6",
    );
    tracker.record(
      { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 },
      "claude-haiku-4-5-20251001",
    );

    const breakdown = tracker.getBreakdown();
    expect(breakdown.byModel["claude-opus-4-6"]).toBeGreaterThan(breakdown.byModel["claude-haiku-4-5-20251001"]);
  });

  it("formats cost for display", () => {
    const tracker = new CostTracker();

    // Record a tiny amount
    tracker.record(
      { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 },
      "claude-haiku-4-5-20251001",
    );

    const terse = tracker.formatTerse();
    expect(terse).toBe("<1¢");

    // Record more to push past 1 cent
    tracker.record(
      { inputTokens: 10000, outputTokens: 5000, cacheReadTokens: 0, cacheCreationTokens: 0 },
      "claude-opus-4-6",
    );

    const terse2 = tracker.formatTerse();
    expect(terse2).toMatch(/^\d+¢$|^\$\d/);
  });

  it("returns independent copies from getBreakdown", () => {
    const tracker = new CostTracker();
    tracker.record(
      { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 },
      "claude-opus-4-6",
    );

    const b1 = tracker.getBreakdown();
    const b2 = tracker.getBreakdown();
    b1.totalCost = 999;
    expect(b2.totalCost).not.toBe(999);
  });
});
