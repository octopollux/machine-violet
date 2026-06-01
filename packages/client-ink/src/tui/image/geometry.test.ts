import {
  spansOverlap, isOccluded, visibleBand, bandPixels, vacatedRows, fitImage,
} from "./geometry.js";

describe("spansOverlap", () => {
  it("detects overlap", () => {
    expect(spansOverlap({ top: 0, rows: 5 }, { top: 4, rows: 2 })).toBe(true);
    expect(spansOverlap({ top: 4, rows: 2 }, { top: 0, rows: 5 })).toBe(true);
  });

  it("treats touching edges as non-overlapping", () => {
    // [0,5) and [5,7) share no row.
    expect(spansOverlap({ top: 0, rows: 5 }, { top: 5, rows: 2 })).toBe(false);
  });

  it("returns false for zero-height spans", () => {
    expect(spansOverlap({ top: 0, rows: 0 }, { top: 0, rows: 5 })).toBe(false);
    expect(spansOverlap({ top: 0, rows: 5 }, { top: 2, rows: 0 })).toBe(false);
  });
});

describe("isOccluded", () => {
  const image = { top: 10, rows: 12 };
  it("is false when no overlay touches the image (e.g. inline choices below)", () => {
    expect(isOccluded(image, [{ top: 24, rows: 4 }])).toBe(false);
  });
  it("is true when any overlay overlaps", () => {
    expect(isOccluded(image, [{ top: 24, rows: 4 }, { top: 18, rows: 3 }])).toBe(true);
  });
  it("is false with no overlays", () => {
    expect(isOccluded(image, [])).toBe(false);
  });
});

describe("visibleBand", () => {
  it("returns the full image when wholly inside the viewport", () => {
    expect(visibleBand(5, 10, 0, 30)).toEqual({ visTop: 5, visRows: 10, srcTopRows: 0 });
  });

  it("clips at the top edge (image scrolled partly above)", () => {
    // image [-3, 7), viewport [0, 30) → visible [0, 7), 3 source rows clipped
    expect(visibleBand(-3, 10, 0, 30)).toEqual({ visTop: 0, visRows: 7, srcTopRows: 3 });
  });

  it("clips at the bottom edge (image extends past viewport)", () => {
    // image [25, 35), viewport [0, 30) → visible [25, 30)
    expect(visibleBand(25, 10, 0, 30)).toEqual({ visTop: 25, visRows: 5, srcTopRows: 0 });
  });

  it("returns null when entirely above or below the viewport", () => {
    expect(visibleBand(-20, 10, 0, 30)).toBeNull();
    expect(visibleBand(40, 10, 0, 30)).toBeNull();
  });

  it("returns null for degenerate sizes", () => {
    expect(visibleBand(0, 0, 0, 30)).toBeNull();
    expect(visibleBand(0, 10, 0, 0)).toBeNull();
  });
});

describe("bandPixels", () => {
  it("scales rows to pixels by the real cell height", () => {
    expect(bandPixels(3, 7, 20)).toEqual({ topPx: 60, bandPx: 140 });
  });
});

describe("fitImage", () => {
  const cell = { width: 10, height: 20 }; // cells are 2:1 tall:wide

  it("fills width for a landscape image", () => {
    // 1600x900 (16:9) into 40 cols: rows = 40 * 10 * 900 / (20 * 1600) = 11.25 → 11
    expect(fitImage(1600, 900, 40, 60, cell)).toEqual({ cols: 40, rows: 11 });
  });

  it("fills height (capped) for a portrait image", () => {
    // 900x1600 into 40x20: width-fill rows = 40*10*1600/(20*900)=35.6 > 20 cap →
    // rows=20, cols = 20*20*900/(10*1600) = 22.5 → 23, clamped to maxCols 40
    expect(fitImage(900, 1600, 40, 20, cell)).toEqual({ cols: 23, rows: 20 });
  });

  it("renders a square image as a square on screen (half the rows of cols)", () => {
    // square pixels → usedRows = usedCols * cellW/cellH = cols * 0.5
    expect(fitImage(512, 512, 40, 60, cell)).toEqual({ cols: 40, rows: 20 });
  });

  it("falls back to a safe footprint for degenerate inputs", () => {
    expect(fitImage(0, 0, 40, 60, cell)).toEqual({ cols: 40, rows: 40 });
  });
});

describe("vacatedRows", () => {
  it("returns rows no longer covered after shrinking", () => {
    // prev [5,10) → next [5,8): rows 8,9 vacated
    expect(vacatedRows({ top: 5, rows: 5 }, { top: 5, rows: 3 })).toEqual([8, 9]);
  });

  it("returns rows no longer covered after moving down", () => {
    // prev [5,8) → next [7,10): rows 5,6 vacated
    expect(vacatedRows({ top: 5, rows: 3 }, { top: 7, rows: 3 })).toEqual([5, 6]);
  });

  it("returns all prev rows when the image vanishes", () => {
    expect(vacatedRows({ top: 5, rows: 3 }, null)).toEqual([5, 6, 7]);
  });

  it("returns nothing when prev is null/empty", () => {
    expect(vacatedRows(null, { top: 0, rows: 3 })).toEqual([]);
    expect(vacatedRows({ top: 0, rows: 0 }, null)).toEqual([]);
  });
});
