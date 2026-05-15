import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import type { UsageStatus } from "@machine-violet/shared";
import { UsageGauge, gaugeCells } from "./UsageGauge.js";

function makeUsage(primaryUsedPercent: number, opts?: { includeSecondary?: boolean }): UsageStatus {
  const segments: UsageStatus["segments"] = [
    {
      id: "primary",
      label: "5-hour window",
      kind: "percentage",
      usedPercent: primaryUsedPercent,
      status: primaryUsedPercent >= 80 ? "warning" : "ok",
    },
  ];
  if (opts?.includeSecondary) {
    segments.push({
      id: "secondary",
      label: "7-day window",
      kind: "percentage",
      usedPercent: 50,
      status: "ok",
    });
  }
  return { segments, snapshotAt: 1, fresh: true };
}

describe("gaugeCells", () => {
  it("renders five full diamonds at 100% remaining", () => {
    const cells = gaugeCells(100);
    expect(cells.map((c) => c.glyph)).toEqual(["◆", "◆", "◆", "◆", "◆"]);
  });

  it("renders five spaces at 0% remaining", () => {
    const cells = gaugeCells(0);
    expect(cells.map((c) => c.glyph)).toEqual([" ", " ", " ", " ", " "]);
  });

  it("degrades the leftmost cell first", () => {
    // 96% remaining: 24 ticks → leftmost cell holds 4 (⬢), rest 5 (◆)
    const cells = gaugeCells(96);
    expect(cells.map((c) => c.glyph)).toEqual(["⬢", "◆", "◆", "◆", "◆"]);
  });

  it("walks the leftmost cell through all states before touching the next", () => {
    expect(gaugeCells(100).map((c) => c.glyph)).toEqual(["◆", "◆", "◆", "◆", "◆"]);
    expect(gaugeCells(96).map((c) => c.glyph)).toEqual(["⬢", "◆", "◆", "◆", "◆"]);
    expect(gaugeCells(92).map((c) => c.glyph)).toEqual(["■", "◆", "◆", "◆", "◆"]);
    expect(gaugeCells(88).map((c) => c.glyph)).toEqual(["*", "◆", "◆", "◆", "◆"]);
    // 84% (21 ticks): cell 0 has 1 bucket left → still `*`
    expect(gaugeCells(84).map((c) => c.glyph)).toEqual(["*", "◆", "◆", "◆", "◆"]);
    // 80% (20 ticks): cell 0 fully empty, cell 1 still full
    expect(gaugeCells(80).map((c) => c.glyph)).toEqual([" ", "◆", "◆", "◆", "◆"]);
    // 76% (19 ticks): cell 1 drops to ⬢
    expect(gaugeCells(76).map((c) => c.glyph)).toEqual([" ", "⬢", "◆", "◆", "◆"]);
  });

  it("renders only the rightmost cell at very low remaining", () => {
    // 4% remaining (1 tick): only rightmost cell, at state *
    expect(gaugeCells(4).map((c) => c.glyph)).toEqual([" ", " ", " ", " ", "*"]);
  });

  it("clamps out-of-range inputs", () => {
    expect(gaugeCells(-50).map((c) => c.glyph)).toEqual([" ", " ", " ", " ", " "]);
    expect(gaugeCells(200).map((c) => c.glyph)).toEqual(["◆", "◆", "◆", "◆", "◆"]);
  });
});

describe("<UsageGauge />", () => {
  it("renders nothing when usage is null", () => {
    const { lastFrame } = render(<UsageGauge usage={null} />);
    expect(lastFrame()).toBe("");
  });

  it("renders nothing when there is no primary segment", () => {
    const usage: UsageStatus = {
      segments: [{
        id: "credits",
        label: "Credit balance",
        kind: "balance",
        used: 0,
        total: 100,
        status: "ok",
      }],
      snapshotAt: 1,
      fresh: true,
    };
    const { lastFrame } = render(<UsageGauge usage={usage} />);
    expect(lastFrame()).toBe("");
  });

  it("renders five glyphs for the primary segment", () => {
    const { lastFrame } = render(<UsageGauge usage={makeUsage(0)} />);
    expect(lastFrame()).toBe("◆◆◆◆◆");
  });

  it("ignores the secondary 7-day window", () => {
    // Primary at 100% used → 0% remaining → all space. Secondary at 50%
    // would otherwise pull the gauge to half if we accidentally summed.
    // ink-testing-library trims trailing whitespace, so the rendered
    // frame is empty — but no gem glyphs is the point.
    const { lastFrame } = render(<UsageGauge usage={makeUsage(100, { includeSecondary: true })} />);
    const frame = lastFrame()!;
    expect(frame).not.toContain("◆");
    expect(frame).not.toContain("⬢");
    expect(frame).not.toContain("■");
    expect(frame).not.toContain("*");

    // And primary at 50% used → 50% remaining gives a clearly mixed gauge.
    const { lastFrame: mixed } = render(<UsageGauge usage={makeUsage(50, { includeSecondary: true })} />);
    const mixedFrame = mixed()!;
    // 50% remaining = 13 ticks (rounded), cells from rightmost: [3,5,5] only the rightmost 3 cells get any ticks.
    expect(mixedFrame).toContain("◆");
  });
});
