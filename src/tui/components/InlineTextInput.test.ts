import { describe, it, expect } from "vitest";
import { computeViewStart, reducer, RENDER_THROTTLE_MS } from "./InlineTextInput.js";

describe("computeViewStart", () => {
  it("returns 0 when text fits in view", () => {
    // cursor at position 5, text length 10, view is 20 wide — no scrolling needed
    expect(computeViewStart(0, 5, 20, 10)).toBe(0);
  });

  it("returns 0 for non-finite viewWidth", () => {
    expect(computeViewStart(0, 10, Infinity, 20)).toBe(0);
    expect(computeViewStart(0, 10, NaN, 20)).toBe(0);
    expect(computeViewStart(0, 10, -1, 20)).toBe(0);
    expect(computeViewStart(0, 10, 0, 20)).toBe(0);
  });

  it("slides window right when cursor moves past right edge", () => {
    // viewWidth=10, prevViewStart=0, cursor at position 12, text 20 chars
    // cursor should be at right edge: viewStart = 12 - 10 + 1 = 3
    expect(computeViewStart(0, 12, 10, 20)).toBe(3);
  });

  it("snaps window to cursor when cursor moves before left edge", () => {
    // prevViewStart=10, cursor moved back to position 5, text 30 chars
    expect(computeViewStart(10, 5, 20, 30)).toBe(5);
  });

  it("respects prevViewStart when cursor is within the window", () => {
    // prevViewStart=5, cursor at 8, viewWidth=10 → window is [5..15)
    // cursor 8 is inside the window, so viewStart stays at 5
    expect(computeViewStart(5, 8, 10, 20)).toBe(5);
  });

  it("handles cursor at end of text needing 1 col for cursor block", () => {
    // Text is 30 chars, cursor at position 30 (end), viewWidth=10
    // maxVs = 30 + 1 - 10 = 21, cursor slide = 30 - 10 + 1 = 21
    expect(computeViewStart(0, 30, 10, 30)).toBe(21);
  });

  it("handles cursor at position 0 with nonzero prevViewStart", () => {
    // User pressed Home — cursor snaps to 0
    expect(computeViewStart(15, 0, 10, 30)).toBe(0);
  });

  it("handles cursor exactly at window right boundary", () => {
    // prevViewStart=0, cursor at 9, viewWidth=10 → window [0..10)
    // cursor 9 is inside, no change needed
    expect(computeViewStart(0, 9, 10, 20)).toBe(0);
    // cursor at 10 means it's at position viewStart + viewWidth, out of window
    expect(computeViewStart(0, 10, 10, 20)).toBe(1);
  });

  it("clamps viewStart so viewport stays full after deletion", () => {
    // Text was 50 chars, viewStart was 31 (showing chars 31-50).
    // User deletes down to 40 chars, cursor at 39.
    // Without clamping: viewStart would stay 31, showing only 9 chars + cursor.
    // maxVs = 40 + 1 - 20 = 21, so viewStart clamps to 21.
    expect(computeViewStart(31, 39, 20, 40)).toBe(21);
  });

  it("clamps viewStart when text shrinks below viewport size", () => {
    // Text was long (viewStart=15), but user deleted most of it.
    // Now text is 8 chars, cursor at 8, viewWidth=20.
    // Text + cursor (9) fits in view, maxVs = max(0, 8+1-20) = 0.
    expect(computeViewStart(15, 8, 20, 8)).toBe(0);
  });

  it("fills viewport from the right when cursor is mid-text after deletion", () => {
    // Text is 25 chars, viewWidth=20, cursor at 15, prevViewStart=10.
    // maxVs = 25 + 1 - 20 = 6. prevViewStart 10 > 6, so clamps to 6.
    expect(computeViewStart(10, 15, 20, 25)).toBe(6);
  });
});

describe("reducer", () => {
  const make = (value: string, cursorOffset: number) => ({
    previousValue: value,
    value,
    cursorOffset,
  });

  describe("delete (backspace)", () => {
    it("is a no-op when cursor is at position 0", () => {
      const state = make("hello", 0);
      const next = reducer(state, { type: "delete" });
      expect(next).toBe(state); // same reference → no mutation
    });

    it("deletes the character before the cursor", () => {
      const state = make("hello", 3);
      const next = reducer(state, { type: "delete" });
      expect(next.value).toBe("helo");
      expect(next.cursorOffset).toBe(2);
    });

    it("deletes the last character when cursor is at end", () => {
      const state = make("hi", 2);
      const next = reducer(state, { type: "delete" });
      expect(next.value).toBe("h");
      expect(next.cursorOffset).toBe(1);
    });

    it("empties the string when one character remains and cursor is at end", () => {
      const state = make("x", 1);
      const next = reducer(state, { type: "delete" });
      expect(next.value).toBe("");
      expect(next.cursorOffset).toBe(0);
    });
  });
});

describe("render throttle constant", () => {
  it("exports RENDER_THROTTLE_MS as a positive number", () => {
    expect(RENDER_THROTTLE_MS).toBeGreaterThan(0);
    expect(Number.isFinite(RENDER_THROTTLE_MS)).toBe(true);
  });
});

describe("reducer with rapid sequential deletes", () => {
  it("correctly chains multiple deletes from the same starting state", () => {
    const make = (value: string, cursorOffset: number) => ({
      previousValue: value,
      value,
      cursorOffset,
    });

    // Simulate rapid backspace: 5 deletes on "hello world" (cursor at end)
    let state = make("hello world", 11);
    for (let i = 0; i < 5; i++) {
      state = reducer(state, { type: "delete" });
    }
    expect(state.value).toBe("hello ");
    expect(state.cursorOffset).toBe(6);
  });

  it("stops deleting when cursor reaches position 0", () => {
    const make = (value: string, cursorOffset: number) => ({
      previousValue: value,
      value,
      cursorOffset,
    });

    // More deletes than characters: should empty the string, not crash
    let state = make("abc", 3);
    for (let i = 0; i < 10; i++) {
      state = reducer(state, { type: "delete" });
    }
    expect(state.value).toBe("");
    expect(state.cursorOffset).toBe(0);
  });
});
