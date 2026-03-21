import React from "react";
import { Box } from "ink";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { PlayerNotesModal, editorReducer, ensureVisible } from "./PlayerNotesModal.js";
import type { EditorState, EditorAction } from "./PlayerNotesModal.js";
import { resolveTheme } from "../themes/resolver.js";
import { resetThemeCache } from "../themes/loader.js";
import { BUILTIN_DEFINITIONS } from "../themes/builtin-definitions.js";

// --- Reducer unit tests ---

function mkState(overrides: Partial<EditorState> = {}): EditorState {
  return { lines: [""], row: 0, col: 0, scrollOffset: 0, ...overrides };
}

describe("editorReducer", () => {
  it("inserts text at cursor position", () => {
    const state = mkState({ lines: ["hello"], col: 5 });
    const next = editorReducer(state, { type: "insert", text: " world" });
    expect(next.lines).toEqual(["hello world"]);
    expect(next.col).toBe(11);
  });

  it("inserts text in the middle of a line", () => {
    const state = mkState({ lines: ["helo"], col: 2 });
    const next = editorReducer(state, { type: "insert", text: "l" });
    expect(next.lines).toEqual(["hello"]);
    expect(next.col).toBe(3);
  });

  it("handles sequential inserts correctly", () => {
    let state = mkState();
    state = editorReducer(state, { type: "insert", text: "a" });
    state = editorReducer(state, { type: "insert", text: "b" });
    state = editorReducer(state, { type: "insert", text: "c" });
    expect(state.lines).toEqual(["abc"]);
    expect(state.col).toBe(3);
  });

  it("backspace deletes character before cursor", () => {
    const state = mkState({ lines: ["abc"], col: 2 });
    const next = editorReducer(state, { type: "backspace", maxRows: 20 });
    expect(next.lines).toEqual(["ac"]);
    expect(next.col).toBe(1);
  });

  it("backspace at start of line merges with previous", () => {
    const state = mkState({ lines: ["ab", "cd"], row: 1, col: 0 });
    const next = editorReducer(state, { type: "backspace", maxRows: 20 });
    expect(next.lines).toEqual(["abcd"]);
    expect(next.row).toBe(0);
    expect(next.col).toBe(2);
  });

  it("backspace at start of first line is a no-op", () => {
    const state = mkState({ lines: ["abc"], col: 0 });
    const next = editorReducer(state, { type: "backspace", maxRows: 20 });
    expect(next).toBe(state);
  });

  it("enter splits line at cursor", () => {
    const state = mkState({ lines: ["hello world"], col: 5 });
    const next = editorReducer(state, { type: "enter", maxRows: 20 });
    expect(next.lines).toEqual(["hello", " world"]);
    expect(next.row).toBe(1);
    expect(next.col).toBe(0);
  });

  it("enter at end of line creates empty line below", () => {
    const state = mkState({ lines: ["hello"], col: 5 });
    const next = editorReducer(state, { type: "enter", maxRows: 20 });
    expect(next.lines).toEqual(["hello", ""]);
    expect(next.row).toBe(1);
    expect(next.col).toBe(0);
  });

  it("up arrow moves cursor up, clamping col", () => {
    const state = mkState({ lines: ["ab", "cdef"], row: 1, col: 3 });
    const next = editorReducer(state, { type: "up", maxRows: 20 });
    expect(next.row).toBe(0);
    expect(next.col).toBe(2); // clamped to "ab".length
  });

  it("up arrow at first line is a no-op", () => {
    const state = mkState({ lines: ["abc"], row: 0, col: 1 });
    const next = editorReducer(state, { type: "up", maxRows: 20 });
    expect(next).toBe(state);
  });

  it("down arrow moves cursor down, clamping col", () => {
    const state = mkState({ lines: ["abcd", "ef"], row: 0, col: 3 });
    const next = editorReducer(state, { type: "down", maxRows: 20 });
    expect(next.row).toBe(1);
    expect(next.col).toBe(2); // clamped to "ef".length
  });

  it("down arrow at last line is a no-op", () => {
    const state = mkState({ lines: ["abc"], row: 0, col: 1 });
    const next = editorReducer(state, { type: "down", maxRows: 20 });
    expect(next).toBe(state);
  });

  it("left arrow moves cursor left", () => {
    const state = mkState({ lines: ["abc"], col: 2 });
    const next = editorReducer(state, { type: "left", maxRows: 20 });
    expect(next.col).toBe(1);
  });

  it("left arrow at start of line moves to end of previous", () => {
    const state = mkState({ lines: ["ab", "cd"], row: 1, col: 0 });
    const next = editorReducer(state, { type: "left", maxRows: 20 });
    expect(next.row).toBe(0);
    expect(next.col).toBe(2);
  });

  it("right arrow moves cursor right", () => {
    const state = mkState({ lines: ["abc"], col: 1 });
    const next = editorReducer(state, { type: "right", maxRows: 20 });
    expect(next.col).toBe(2);
  });

  it("right arrow at end of line moves to start of next", () => {
    const state = mkState({ lines: ["ab", "cd"], row: 0, col: 2 });
    const next = editorReducer(state, { type: "right", maxRows: 20 });
    expect(next.row).toBe(1);
    expect(next.col).toBe(0);
  });

  it("home moves cursor to start of line", () => {
    const state = mkState({ lines: ["abc"], col: 2 });
    const next = editorReducer(state, { type: "home" });
    expect(next.col).toBe(0);
  });

  it("end moves cursor to end of line", () => {
    const state = mkState({ lines: ["abc"], col: 0 });
    const next = editorReducer(state, { type: "end" });
    expect(next.col).toBe(3);
  });
});

describe("ensureVisible", () => {
  it("scrolls up when cursor is above viewport", () => {
    expect(ensureVisible(2, 10, 5)).toBe(2);
  });

  it("scrolls down when cursor is below viewport", () => {
    expect(ensureVisible(15, 10, 5)).toBe(6);
  });

  it("keeps scroll when cursor is in viewport", () => {
    expect(ensureVisible(7, 10, 5)).toBe(5);
  });
});

// --- Rendering tests ---

let theme: ReturnType<typeof resolveTheme>;

beforeEach(() => {
  resetThemeCache();
  theme = resolveTheme(BUILTIN_DEFINITIONS["gothic"], "exploration", "#cc4444");
});

function renderModal(initialContent = "", onSave = vi.fn(), onClose = vi.fn()) {
  return {
    onSave,
    onClose,
    ...render(
      <Box width={80} height={30}>
        <PlayerNotesModal
          theme={theme}
          width={80}
          height={30}
          initialContent={initialContent}
          onSave={onSave}
          onClose={onClose}
        />
      </Box>,
    ),
  };
}

describe("PlayerNotesModal rendering", () => {
  it("renders title and footer", () => {
    const { lastFrame } = renderModal();
    const frame = lastFrame()!;
    expect(frame).toContain("Player Notes");
    expect(frame).toContain("ESC save & close");
  });

  it("displays initial content", () => {
    const { lastFrame } = renderModal("Hello world\nSecond line");
    const frame = lastFrame()!;
    expect(frame).toContain("ello world");
    expect(frame).toContain("Second line");
  });

  it("renders empty content without crashing", () => {
    const { lastFrame } = renderModal("");
    expect(lastFrame()).toContain("Player Notes");
  });

  it("shows in GameMenu items after Compendium", async () => {
    const { getMenuItems } = await import("./GameMenu.js");
    const items = getMenuItems();
    expect(items).toContain("Player Notes");
    const compIndex = items.indexOf("Compendium");
    const notesIndex = items.indexOf("Player Notes");
    expect(notesIndex).toBe(compIndex + 1);
  });
});
