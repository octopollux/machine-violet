import { describe, it, expect, vi, afterEach } from "vitest";
import { computeViewStart, reducer, DELETE_RELEASE_MS } from "./InlineTextInput.js";
import React from "react";
import { render } from "ink-testing-library";
import chalk from "chalk";
import { InlineTextInput } from "./InlineTextInput.js";

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
  const make = (value: string, cursorOffset: number, pendingDeleteCount = 0) => ({
    previousValue: value,
    value,
    cursorOffset,
    pendingDeleteCount,
  });

  describe("delete (Delete key)", () => {
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

  describe("mark-delete", () => {
    it("is a no-op when cursor is at position 0", () => {
      const state = make("hello", 0);
      const next = reducer(state, { type: "mark-delete" });
      expect(next).toBe(state);
    });

    it("decrements cursor and increments pending count without mutating value", () => {
      const state = make("hello", 5);
      const next = reducer(state, { type: "mark-delete" });
      expect(next.value).toBe("hello");
      expect(next.cursorOffset).toBe(4);
      expect(next.pendingDeleteCount).toBe(1);
    });

    it("accumulates multiple mark-deletes", () => {
      let state = make("hello", 5);
      state = reducer(state, { type: "mark-delete" });
      state = reducer(state, { type: "mark-delete" });
      state = reducer(state, { type: "mark-delete" });
      expect(state.value).toBe("hello");
      expect(state.cursorOffset).toBe(2);
      expect(state.pendingDeleteCount).toBe(3);
    });

    it("stops at position 0", () => {
      let state = make("hi", 2);
      for (let i = 0; i < 5; i++) {
        state = reducer(state, { type: "mark-delete" });
      }
      expect(state.cursorOffset).toBe(0);
      expect(state.pendingDeleteCount).toBe(2);
      expect(state.value).toBe("hi");
    });

    it("works from mid-string position", () => {
      const state = make("hello", 3);
      const next = reducer(state, { type: "mark-delete" });
      expect(next.value).toBe("hello");
      expect(next.cursorOffset).toBe(2);
      expect(next.pendingDeleteCount).toBe(1);
    });
  });

  describe("commit-delete", () => {
    it("is a no-op when no pending deletes", () => {
      const state = make("hello", 3);
      const next = reducer(state, { type: "commit-delete" });
      expect(next).toBe(state);
    });

    it("removes pending characters from end of string", () => {
      // "hello" cursor at 3, pending 2 → remove [3,5) = "lo"
      const state = make("hello", 3, 2);
      const next = reducer(state, { type: "commit-delete" });
      expect(next.value).toBe("hel");
      expect(next.cursorOffset).toBe(3);
      expect(next.pendingDeleteCount).toBe(0);
    });

    it("removes pending characters from mid-string", () => {
      // "abcdef" cursor at 2, pending 2 → remove [2,4) = "cd"
      const state = make("abcdef", 2, 2);
      const next = reducer(state, { type: "commit-delete" });
      expect(next.value).toBe("abef");
      expect(next.cursorOffset).toBe(2);
      expect(next.pendingDeleteCount).toBe(0);
    });

    it("removes all characters when fully marked", () => {
      const state = make("abc", 0, 3);
      const next = reducer(state, { type: "commit-delete" });
      expect(next.value).toBe("");
      expect(next.cursorOffset).toBe(0);
      expect(next.pendingDeleteCount).toBe(0);
    });
  });

  describe("auto-commit before other actions", () => {
    it("commits pending deletes before insert", () => {
      const state = make("hello", 3, 2);
      const next = reducer(state, { type: "insert", text: "X" });
      expect(next.value).toBe("helX");
      expect(next.cursorOffset).toBe(4);
      expect(next.pendingDeleteCount).toBe(0);
    });

    it("commits pending deletes before move-cursor-left", () => {
      const state = make("hello", 3, 2);
      const next = reducer(state, { type: "move-cursor-left" });
      expect(next.value).toBe("hel");
      expect(next.cursorOffset).toBe(2);
      expect(next.pendingDeleteCount).toBe(0);
    });

    it("commits pending deletes before move-cursor-right", () => {
      const state = make("hello", 3, 2);
      const next = reducer(state, { type: "move-cursor-right" });
      // After commit: "hel" cursor=3 (at end), then right: min(3, 3) = 3
      expect(next.value).toBe("hel");
      expect(next.cursorOffset).toBe(3);
      expect(next.pendingDeleteCount).toBe(0);
    });

    it("commits pending deletes before move-cursor-start", () => {
      const state = make("hello", 3, 2);
      const next = reducer(state, { type: "move-cursor-start" });
      expect(next.value).toBe("hel");
      expect(next.cursorOffset).toBe(0);
      expect(next.pendingDeleteCount).toBe(0);
    });

    it("commits pending deletes before move-cursor-end", () => {
      const state = make("hello", 3, 2);
      const next = reducer(state, { type: "move-cursor-end" });
      expect(next.value).toBe("hel");
      expect(next.cursorOffset).toBe(3);
      expect(next.pendingDeleteCount).toBe(0);
    });

    it("commits pending deletes before delete (Delete key)", () => {
      // "hello" cursor at 2, pending 2 → commit → "heo" cursor=2 → delete → "ho" cursor=1
      const state = make("hello", 2, 2);
      const next = reducer(state, { type: "delete" });
      expect(next.value).toBe("ho");
      expect(next.cursorOffset).toBe(1);
      expect(next.pendingDeleteCount).toBe(0);
    });

    it("is a no-op when nothing pending", () => {
      const state = make("hello", 3, 0);
      const next = reducer(state, { type: "insert", text: "X" });
      expect(next.value).toBe("helXlo");
      expect(next.cursorOffset).toBe(4);
      expect(next.pendingDeleteCount).toBe(0);
    });
  });
});

describe("DELETE_RELEASE_MS constant", () => {
  it("exports DELETE_RELEASE_MS as a positive number", () => {
    expect(DELETE_RELEASE_MS).toBeGreaterThan(0);
    expect(Number.isFinite(DELETE_RELEASE_MS)).toBe(true);
  });
});

describe("reducer with rapid sequential deletes", () => {
  const make = (value: string, cursorOffset: number) => ({
    previousValue: value,
    value,
    cursorOffset,
    pendingDeleteCount: 0,
  });

  it("correctly chains multiple deletes from the same starting state", () => {
    // Simulate rapid Delete key presses: 5 deletes on "hello world" (cursor at end)
    let state = make("hello world", 11);
    for (let i = 0; i < 5; i++) {
      state = reducer(state, { type: "delete" });
    }
    expect(state.value).toBe("hello ");
    expect(state.cursorOffset).toBe(6);
  });

  it("stops deleting when cursor reaches position 0", () => {
    // More deletes than characters: should empty the string, not crash
    let state = make("abc", 3);
    for (let i = 0; i < 10; i++) {
      state = reducer(state, { type: "delete" });
    }
    expect(state.value).toBe("");
    expect(state.cursorOffset).toBe(0);
  });
});

describe("InlineTextInput component", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows strikethrough styling on backspace", () => {
    const { lastFrame, stdin } = render(
      React.createElement(InlineTextInput, { defaultValue: "hello" }),
    );
    // Simulate backspace (mark-delete)
    stdin.write("\x7f");
    const frame = lastFrame()!;
    // The cursor character ("o") should get strikethrough + inverse
    expect(frame).toContain(chalk.strikethrough.inverse("o"));
  });

  it("shows strikethrough.dim on non-cursor pending chars", () => {
    const { lastFrame, stdin } = render(
      React.createElement(InlineTextInput, { defaultValue: "hello" }),
    );
    // Two backspaces: cursor on "l" (strikethrough.inverse), "o" (strikethrough.dim)
    stdin.write("\x7f");
    stdin.write("\x7f");
    const frame = lastFrame()!;
    expect(frame).toContain(chalk.strikethrough.inverse("l"));
    expect(frame).toContain(chalk.strikethrough.dim("o"));
  });

  it("commits pending deletes after release timeout", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { stdin } = render(
      React.createElement(InlineTextInput, { defaultValue: "hello", onChange }),
    );
    // Simulate backspace (mark-delete — value stays "hello")
    stdin.write("\x7f");
    // Fire the release timer callback (calls setRenderState with committed value)
    vi.advanceTimersByTime(DELETE_RELEASE_MS);
    // Restore real timers so Ink's internal render pipeline can flush
    vi.useRealTimers();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(onChange).toHaveBeenCalledWith("hell");
  });

  it("does not commit before release timeout", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { stdin } = render(
      React.createElement(InlineTextInput, { defaultValue: "hello", onChange }),
    );
    stdin.write("\x7f");
    // Advance but not past the timeout
    vi.advanceTimersByTime(DELETE_RELEASE_MS - 1);
    // onChange should not have been called — value hasn't changed (still "hello")
    expect(onChange).not.toHaveBeenCalled();
  });
});
