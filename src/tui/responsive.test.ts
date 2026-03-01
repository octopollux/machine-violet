import { describe, it, expect } from "vitest";
import {
  getViewportTier,
  getVisibleElements,
  narrativeRows,
  PLAYER_PANE_HEIGHT,
  MIN_COLUMNS,
  MIN_ROWS,
} from "./responsive.js";

describe("getViewportTier", () => {
  it("full at 80x40", () => {
    expect(getViewportTier({ columns: 80, rows: 40 })).toBe("full");
  });

  it("full at 120x50", () => {
    expect(getViewportTier({ columns: 120, rows: 50 })).toBe("full");
  });

  it("standard at 80x30 (enough cols, not enough rows)", () => {
    expect(getViewportTier({ columns: 80, rows: 30 })).toBe("standard");
  });

  it("standard at 60x50 (enough rows, not enough cols)", () => {
    expect(getViewportTier({ columns: 60, rows: 50 })).toBe("standard");
  });

  it("standard at 30x15 (small terminal)", () => {
    expect(getViewportTier({ columns: 30, rows: 15 })).toBe("standard");
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
  });

  it("standard drops top frame and activity line", () => {
    const e = getVisibleElements("standard");
    expect(e.topFrame).toBe(false);
    expect(e.activityLine).toBe(false);
    expect(e.activityGlyphInModeline).toBe(true);
    expect(e.sideFrames).toBe(true);
    expect(e.lowerFrame).toBe(true);
    expect(e.modeline).toBe(true);
    expect(e.playerSelector).toBe(true);
  });
});

describe("constants", () => {
  it("MIN_COLUMNS is 80", () => {
    expect(MIN_COLUMNS).toBe(80);
  });

  it("MIN_ROWS is 25", () => {
    expect(MIN_ROWS).toBe(25);
  });
});

describe("narrativeRows", () => {
  it("calculates rows for full layout with fixed player pane", () => {
    const elements = getVisibleElements("full");
    const rows = narrativeRows(40, elements);
    // Full: playerPane(9) + topFrame(2) + activity(1) + lowerFrame(2) + playerSelector(1) = 15
    expect(rows).toBe(25);
  });

  it("calculates rows for standard layout", () => {
    const elements = getVisibleElements("standard");
    const rows = narrativeRows(30, elements);
    // Standard: playerPane(9) + lowerFrame(2) + playerSelector(1) = 12
    expect(rows).toBe(18);
  });

  it("never returns less than 1", () => {
    const elements = getVisibleElements("full");
    expect(narrativeRows(3, elements)).toBe(1);
  });

  it("hideInputLine does not affect rows (Player Pane always visible)", () => {
    const elements = getVisibleElements("full");
    const normal = narrativeRows(40, elements);
    const hidden = narrativeRows(40, elements, true);
    expect(hidden).toBe(normal);
  });

  it("player pane height is fixed regardless of modeline content", () => {
    const elements = getVisibleElements("full");
    const rows = narrativeRows(40, elements);
    expect(rows).toBe(40 - (PLAYER_PANE_HEIGHT + 2 + 1 + 2 + 1));
  });

  it("does not reserve playerSelector row when only 1 PC", () => {
    const elements = getVisibleElements("full");
    const multi = narrativeRows(40, elements, false, 2, 2);
    const single = narrativeRows(40, elements, false, 2, 1);
    expect(single).toBe(multi + 1);
  });

  it("reserves playerSelector row when 2+ PCs", () => {
    const elements = getVisibleElements("full");
    const two = narrativeRows(40, elements, false, 2, 2);
    const three = narrativeRows(40, elements, false, 2, 3);
    expect(three).toBe(two);
  });
});
