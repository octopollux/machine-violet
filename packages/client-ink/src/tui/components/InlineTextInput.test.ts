import { describe, it, expect, vi } from "vitest";
import { computeViewStart, reducer } from "./InlineTextInput.js";
import React from "react";
import { render } from "ink-testing-library";
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
  const make = (value: string, cursorOffset: number) => ({
    value,
    cursorOffset,
  });

  describe("delete", () => {
    it("is a no-op when cursor is at position 0", () => {
      const state = make("hello", 0);
      const next = reducer(state, { type: "delete" });
      expect(next).toBe(state);
    });

    it("removes character before cursor", () => {
      const state = make("hello", 5);
      const next = reducer(state, { type: "delete" });
      expect(next.value).toBe("hell");
      expect(next.cursorOffset).toBe(4);
    });

    it("removes character from mid-string", () => {
      const state = make("hello", 3);
      const next = reducer(state, { type: "delete" });
      expect(next.value).toBe("helo");
      expect(next.cursorOffset).toBe(2);
    });

    it("chains multiple deletes", () => {
      let state = make("hello", 5);
      state = reducer(state, { type: "delete" });
      state = reducer(state, { type: "delete" });
      state = reducer(state, { type: "delete" });
      expect(state.value).toBe("he");
      expect(state.cursorOffset).toBe(2);
    });

    it("stops at position 0", () => {
      let state = make("hi", 2);
      for (let i = 0; i < 5; i++) {
        state = reducer(state, { type: "delete" });
      }
      expect(state.cursorOffset).toBe(0);
      expect(state.value).toBe("");
    });
  });

  describe("insert", () => {
    it("inserts text at cursor", () => {
      const state = make("hello", 5);
      const next = reducer(state, { type: "insert", text: "X" });
      expect(next.value).toBe("helloX");
      expect(next.cursorOffset).toBe(6);
    });

    it("inserts in middle of string", () => {
      const state = make("hello", 3);
      const next = reducer(state, { type: "insert", text: "X" });
      expect(next.value).toBe("helXlo");
      expect(next.cursorOffset).toBe(4);
    });
  });

  describe("cursor movement", () => {
    it("moves cursor left", () => {
      const state = make("hello", 3);
      const next = reducer(state, { type: "move-cursor-left" });
      expect(next.cursorOffset).toBe(2);
    });

    it("moves cursor right", () => {
      const state = make("hello", 3);
      const next = reducer(state, { type: "move-cursor-right" });
      expect(next.cursorOffset).toBe(4);
    });

    it("moves cursor to start", () => {
      const state = make("hello", 3);
      const next = reducer(state, { type: "move-cursor-start" });
      expect(next.cursorOffset).toBe(0);
    });

    it("moves cursor to end", () => {
      const state = make("hello", 3);
      const next = reducer(state, { type: "move-cursor-end" });
      expect(next.cursorOffset).toBe(5);
    });

    it("clamps cursor left at 0", () => {
      const state = make("hello", 0);
      const next = reducer(state, { type: "move-cursor-left" });
      expect(next.cursorOffset).toBe(0);
    });

    it("clamps cursor right at end", () => {
      const state = make("hello", 5);
      const next = reducer(state, { type: "move-cursor-right" });
      expect(next.cursorOffset).toBe(5);
    });
  });
});

describe("reducer with rapid sequential deletes", () => {
  const make = (value: string, cursorOffset: number) => ({
    value,
    cursorOffset,
  });

  it("correctly chains multiple deletes from end", () => {
    let state = make("hello world", 11);
    for (let i = 0; i < 5; i++) {
      state = reducer(state, { type: "delete" });
    }
    expect(state.value).toBe("hello ");
    expect(state.cursorOffset).toBe(6);
  });

  it("stops deleting when cursor reaches position 0", () => {
    let state = make("abc", 3);
    for (let i = 0; i < 10; i++) {
      state = reducer(state, { type: "delete" });
    }
    expect(state.cursorOffset).toBe(0);
    expect(state.value).toBe("");
  });
});

describe("InlineTextInput component", () => {
  it("renders default value", () => {
    const { lastFrame } = render(
      React.createElement(InlineTextInput, { defaultValue: "hello" }),
    );
    const frame = lastFrame()!;
    expect(frame).toContain("hello");
  });

  it("handles backspace immediately", async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      React.createElement(InlineTextInput, { defaultValue: "hello", onChange }),
    );
    stdin.write("\x7f");
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledWith("hell");
    });
  });

  it("handles multiple rapid backspaces", async () => {
    const onChange = vi.fn();
    const { stdin } = render(
      React.createElement(InlineTextInput, { defaultValue: "hello", onChange }),
    );
    stdin.write("\x7f");
    stdin.write("\x7f");
    stdin.write("\x7f");
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith("he");
    });
  });

  it("shows placeholder as dim text when input is empty", () => {
    const { lastFrame } = render(
      React.createElement(InlineTextInput, { placeholder: "Type here..." }),
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Type here...");
  });

  it("hides placeholder after input", async () => {
    const onChange = vi.fn();
    const { lastFrame, stdin } = render(
      React.createElement(InlineTextInput, { placeholder: "Type here...", onChange }),
    );
    stdin.write("H");
    await vi.waitFor(() => {
      const frame = lastFrame()!;
      // After typing, placeholder should be gone and typed char should appear
      expect(frame).not.toContain("Type here...");
      expect(frame).toContain("H");
    });
  });

  it("inserts bracketed-paste content with newlines collapsed and doesn't submit", async () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const { stdin } = render(
      React.createElement(InlineTextInput, { onChange, onSubmit }),
    );
    // Bracketed paste: CSI 200 ~ <text> CSI 201 ~. The embedded "\r" would
    // trigger a submit via useInput's key.return path if it leaked through
    // the normal input channel — usePaste keeps it on a separate event.
    stdin.write("\x1b[200~hello\r\nworld\n\x1b[201~");
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith("hello world");
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("InlineTextInput wrap mode", () => {
  it("wraps text across multiple lines", async () => {
    const onChange = vi.fn();
    const { lastFrame, stdin } = render(
      React.createElement(InlineTextInput, {
        availableWidth: 10,
        wrap: true,
        onChange,
      }),
    );
    // Type 15 characters — should wrap to 2 lines
    stdin.write("abcdefghijklmno");
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith("abcdefghijklmno");
    });
    const frame = lastFrame()!;
    const lines = frame.split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("abcdefghij");
    expect(lines[1]).toContain("klmno");
  });

  it("shrinks back to single line after deleting", async () => {
    const onChange = vi.fn();
    const { lastFrame, stdin } = render(
      React.createElement(InlineTextInput, {
        defaultValue: "abcdefghijklmno",
        availableWidth: 10,
        wrap: true,
        onChange,
      }),
    );
    // Delete 6 chars to fit within one line (10 chars + cursor)
    for (let i = 0; i < 6; i++) stdin.write("\x7f");
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith("abcdefghi");
    });
    const frame = lastFrame()!;
    const lines = frame.split("\n");
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("abcdefghi");
  });

  it("shows placeholder on single line in wrap mode", () => {
    const { lastFrame } = render(
      React.createElement(InlineTextInput, {
        availableWidth: 20,
        wrap: true,
        placeholder: "Type here...",
      }),
    );
    const frame = lastFrame()!;
    expect(frame).toContain("Type here...");
    expect(frame.split("\n").length).toBe(1);
  });
});
