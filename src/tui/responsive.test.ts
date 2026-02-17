import { describe, it, expect } from "vitest";
import {
  getViewportTier,
  getVisibleElements,
  useAsciiFallback,
  narrativeRows,
} from "./responsive.js";

describe("getViewportTier", () => {
  it("full at 80x40", () => {
    expect(getViewportTier({ columns: 80, rows: 40 })).toBe("full");
  });

  it("full at 120x50", () => {
    expect(getViewportTier({ columns: 120, rows: 50 })).toBe("full");
  });

  it("narrow at 60x40", () => {
    expect(getViewportTier({ columns: 60, rows: 40 })).toBe("narrow");
  });

  it("narrow at 40x40", () => {
    expect(getViewportTier({ columns: 40, rows: 40 })).toBe("narrow");
  });

  it("short at 80x30", () => {
    expect(getViewportTier({ columns: 80, rows: 30 })).toBe("short");
  });

  it("short at 80x24", () => {
    expect(getViewportTier({ columns: 80, rows: 24 })).toBe("short");
  });

  it("compact at 60x30", () => {
    expect(getViewportTier({ columns: 60, rows: 30 })).toBe("compact");
  });

  it("compact at 40x24", () => {
    expect(getViewportTier({ columns: 40, rows: 24 })).toBe("compact");
  });

  it("minimal at 30x15", () => {
    expect(getViewportTier({ columns: 30, rows: 15 })).toBe("minimal");
  });

  it("minimal at 20x12", () => {
    expect(getViewportTier({ columns: 20, rows: 12 })).toBe("minimal");
  });

  it("minimal at tiny viewport", () => {
    expect(getViewportTier({ columns: 10, rows: 5 })).toBe("minimal");
  });
});

describe("getVisibleElements", () => {
  it("full shows everything", () => {
    const e = getVisibleElements("full");
    expect(e.topFrame).toBe(true);
    expect(e.sideFrames).toBe(true);
    expect(e.activityLine).toBe(true);
    expect(e.lowerFrame).toBe(true);
    expect(e.modeline).toBe(true);
    expect(e.playerSelector).toBe(true);
    expect(e.activityGlyphInModeline).toBe(false);
    expect(e.playerInPrompt).toBe(false);
  });

  it("narrow drops side frames only", () => {
    const e = getVisibleElements("narrow");
    expect(e.sideFrames).toBe(false);
    expect(e.topFrame).toBe(true);
    expect(e.activityLine).toBe(true);
    expect(e.lowerFrame).toBe(true);
    expect(e.modeline).toBe(true);
  });

  it("short drops top frame and activity line", () => {
    const e = getVisibleElements("short");
    expect(e.topFrame).toBe(false);
    expect(e.activityLine).toBe(false);
    expect(e.activityGlyphInModeline).toBe(true);
    expect(e.sideFrames).toBe(true);
    expect(e.lowerFrame).toBe(true);
    expect(e.modeline).toBe(true);
  });

  it("compact drops sides, top, and activity", () => {
    const e = getVisibleElements("compact");
    expect(e.sideFrames).toBe(false);
    expect(e.topFrame).toBe(false);
    expect(e.activityLine).toBe(false);
    expect(e.activityGlyphInModeline).toBe(true);
    expect(e.lowerFrame).toBe(true);
    expect(e.modeline).toBe(true);
  });

  it("minimal shows only narrative + input", () => {
    const e = getVisibleElements("minimal");
    expect(e.topFrame).toBe(false);
    expect(e.sideFrames).toBe(false);
    expect(e.activityLine).toBe(false);
    expect(e.lowerFrame).toBe(false);
    expect(e.modeline).toBe(false);
    expect(e.playerSelector).toBe(false);
    expect(e.playerInPrompt).toBe(true);
  });
});

describe("useAsciiFallback", () => {
  it("uses ASCII below 40 columns", () => {
    expect(useAsciiFallback(39)).toBe(true);
    expect(useAsciiFallback(20)).toBe(true);
  });

  it("uses Unicode at 40+ columns", () => {
    expect(useAsciiFallback(40)).toBe(false);
    expect(useAsciiFallback(80)).toBe(false);
  });
});

describe("narrativeRows", () => {
  it("calculates rows for full layout", () => {
    const elements = getVisibleElements("full");
    const rows = narrativeRows(40, elements);
    // Full: topFrame(2) + activity(1) + lowerFrame(1) + modeline(1) + playerSelector(1) + input(1) = 7
    expect(rows).toBe(33);
  });

  it("calculates rows for minimal layout", () => {
    const elements = getVisibleElements("minimal");
    const rows = narrativeRows(12, elements);
    // Minimal: just input(1)
    expect(rows).toBe(11);
  });

  it("never returns less than 1", () => {
    const elements = getVisibleElements("full");
    expect(narrativeRows(3, elements)).toBe(1);
  });
});
