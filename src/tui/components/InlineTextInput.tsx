import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, useInput, useStdin } from "ink";
import chalk from "chalk";

interface State {
  value: string;
  cursorOffset: number;
  pendingDeleteCount: number;
}

type Action =
  | { type: "move-cursor-left" }
  | { type: "move-cursor-right" }
  | { type: "move-cursor-start" }
  | { type: "move-cursor-end" }
  | { type: "insert"; text: string }
  | { type: "mark-delete" }
  | { type: "commit-delete" };

/** Flush any pending (strikethrough-marked) deletes into the string. */
function commitPendingDeletes(state: State): State {
  if (state.pendingDeleteCount === 0) return state;
  return {
    ...state,
    value: state.value.slice(0, state.cursorOffset) + state.value.slice(state.cursorOffset + state.pendingDeleteCount),
    pendingDeleteCount: 0,
  };
}

export function reducer(state: State, action: Action): State {
  // Auto-commit pending deletes before any action except mark-delete / commit-delete
  if (action.type !== "mark-delete" && action.type !== "commit-delete") {
    state = commitPendingDeletes(state);
  }

  switch (action.type) {
    case "move-cursor-left":
      return { ...state, cursorOffset: Math.max(0, state.cursorOffset - 1) };
    case "move-cursor-right":
      return { ...state, cursorOffset: Math.min(state.value.length, state.cursorOffset + 1) };
    case "move-cursor-start":
      return { ...state, cursorOffset: 0 };
    case "move-cursor-end":
      return { ...state, cursorOffset: state.value.length };
    case "insert":
      return {
        ...state,
        value: state.value.slice(0, state.cursorOffset) + action.text + state.value.slice(state.cursorOffset),
        cursorOffset: state.cursorOffset + action.text.length,
      };
    case "mark-delete": {
      if (state.cursorOffset === 0) return state;
      return {
        ...state,
        cursorOffset: state.cursorOffset - 1,
        pendingDeleteCount: state.pendingDeleteCount + 1,
      };
    }
    case "commit-delete":
      return commitPendingDeletes(state);
  }
}

const cursorChar = chalk.inverse(" ");

/**
 * Style a text string by splitting into segments around the cursor and
 * pending-delete range, applying chalk once per segment rather than per
 * character. Reduces chalk calls from O(n) to O(1).
 */
function styleSegments(
  text: string,
  cursorOffset: number,
  pendingDeleteCount: number,
): string {
  if (text.length === 0) return "";

  // Common case: no pending deletes — 3 segments max
  if (pendingDeleteCount === 0) {
    const before = text.slice(0, cursorOffset);
    const cursorCh = text[cursorOffset];
    if (cursorCh === undefined) return before; // cursor past end
    const after = text.slice(cursorOffset + 1);
    return before + chalk.inverse(cursorCh) + after;
  }

  // With pending deletes: up to 4 segments
  // [before cursor] [cursor char (strikethrough+inverse)] [pending (strikethrough+dim)] [after pending]
  const before = text.slice(0, cursorOffset);
  const cursorCh = text[cursorOffset];
  const pendingStart = cursorOffset + 1;
  const pendingEnd = cursorOffset + pendingDeleteCount;
  const pendingText = text.slice(pendingStart, pendingEnd);
  const after = text.slice(pendingEnd);

  let result = before;
  if (cursorCh !== undefined) {
    result += chalk.strikethrough.inverse(cursorCh);
  }
  if (pendingText.length > 0) {
    result += chalk.strikethrough.dim(pendingText);
  }
  result += after;
  return result;
}

/** Known Home key escape sequences across terminal emulators. */
const HOME_SEQUENCES = new Set([
  "\x1b[H",   // xterm
  "\x1bOH",   // xterm/gnome
  "\x1b[1~",  // xterm/rxvt
  "\x1b[7~",  // rxvt
]);

/** Known End key escape sequences across terminal emulators. */
const END_SEQUENCES = new Set([
  "\x1b[F",   // xterm
  "\x1bOF",   // xterm/gnome
  "\x1b[4~",  // xterm/rxvt
  "\x1b[8~",  // rxvt
]);

/**
 * Compute the horizontal scroll offset so the cursor stays visible
 * within a fixed-width viewport window. The window always fills the
 * available width — it won't leave empty space on the right when text
 * is shorter than viewStart + viewWidth (e.g. after deletion).
 */
export function computeViewStart(
  prevViewStart: number,
  cursorOffset: number,
  viewWidth: number,
  textLength: number,
): number {
  if (!Number.isFinite(viewWidth) || viewWidth <= 0) return 0;
  // Cursor fits without scrolling
  if (cursorOffset < viewWidth) {
    // If previous view was already at 0 or cursor is in the current window, stay put
    if (prevViewStart === 0) return 0;
  }
  let vs = prevViewStart;
  // Cursor moved left of window → snap left edge to cursor
  if (cursorOffset < vs) {
    vs = cursorOffset;
  }
  // Cursor moved right of window → snap so cursor is at right edge
  if (cursorOffset >= vs + viewWidth) {
    vs = cursorOffset - viewWidth + 1;
  }
  // Don't leave empty space on the right — clamp so the viewport is full.
  // +1 accounts for the cursor block column at end-of-text.
  const maxVs = Math.max(0, textLength + 1 - viewWidth);
  vs = Math.min(vs, maxVs);
  return Math.max(0, vs);
}

export interface InlineTextInputProps {
  isDisabled?: boolean;
  defaultValue?: string;
  availableWidth?: number;
  /** Dim hint text shown when the input is empty. Clears on first keystroke. */
  placeholder?: string;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
}

/** Delay (ms) after the last Backspace before pending deletes are committed.
 *  120ms > 2× Windows key repeat interval (~33ms), reliably detects key release. */
export const DELETE_RELEASE_MS = 120;

/**
 * Uncontrolled text input with full cursor positioning.
 * Supports: left/right arrows, Home/End, Ctrl+A/E, backspace, delete.
 * Clear by changing the React `key` prop.
 *
 * Backspace uses a two-phase "mark then delete" approach: characters are
 * visually marked with strikethrough while the key is held, then removed
 * all at once on release. This sidesteps Windows ConPTY corruption caused
 * by rapid intermediate re-renders during Backspace key repeat.
 */
export const InlineTextInput = React.memo(function InlineTextInput({ isDisabled = false, defaultValue = "", availableWidth, placeholder, onChange, onSubmit }: InlineTextInputProps) {
  const initialState: State = {
    value: defaultValue,
    cursorOffset: defaultValue.length,
    pendingDeleteCount: 0,
  };

  // True state lives in a ref — always current, never triggers a render.
  const stateRef = useRef<State>(initialState);

  // Render state — synced from stateRef on every action.
  const [renderState, setRenderState] = useState<State>(initialState);

  // Timer handle for the Backspace release detection.
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track last value reported to onChange to avoid duplicate callbacks.
  const lastReportedValueRef = useRef(defaultValue);

  const viewStartRef = useRef(0);

  /** Apply an action and immediately sync to render state. */
  const processAction = useCallback((action: Action) => {
    const prev = stateRef.current;
    const next = reducer(prev, action);
    if (next === prev) return; // No state change (e.g. backspace at position 0)
    stateRef.current = next;
    setRenderState(next);

    if (action.type === "mark-delete") {
      // Reset release timer — commit will fire when Backspace key is released
      if (releaseTimerRef.current !== null) {
        clearTimeout(releaseTimerRef.current);
      }
      releaseTimerRef.current = setTimeout(() => {
        releaseTimerRef.current = null;
        const committed = commitPendingDeletes(stateRef.current);
        if (committed !== stateRef.current) {
          stateRef.current = committed;
          setRenderState(committed);
        }
      }, DELETE_RELEASE_MS);
    } else if (releaseTimerRef.current !== null) {
      // Non-backspace action — auto-commit already handled in reducer, cancel timer
      clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
    }
  }, []);

  // Clean up release timer on unmount.
  useEffect(() => {
    return () => {
      if (releaseTimerRef.current !== null) {
        clearTimeout(releaseTimerRef.current);
      }
    };
  }, []);

  // Access Ink's internal event emitter to detect Home/End keys.
  // Ink's useInput doesn't expose these — its parser recognizes them but
  // the key object has no home/end properties. We listen to the same raw
  // input events and match the escape sequences directly.
  const stdinCtx = useStdin();

  useEffect(() => {
    if (isDisabled) return;
    const emitter = (stdinCtx as Record<string, unknown>).internal_eventEmitter as
      import("node:events").EventEmitter | undefined;
    if (!emitter) return;

    const handleRaw = (data: string) => {
      if (HOME_SEQUENCES.has(data)) {
        processAction({ type: "move-cursor-start" });
      } else if (END_SEQUENCES.has(data)) {
        processAction({ type: "move-cursor-end" });
      }
    };

    emitter.on("input", handleRaw);
    return () => { emitter.removeListener("input", handleRaw); };
  }, [isDisabled, stdinCtx, processAction]);

  const submit = useCallback(() => {
    // Commit any pending deletes before submitting
    const committed = commitPendingDeletes(stateRef.current);
    if (committed !== stateRef.current) {
      stateRef.current = committed;
      setRenderState(committed);
    }
    // Cancel release timer if pending
    if (releaseTimerRef.current !== null) {
      clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
    }
    onSubmit?.(stateRef.current.value);
  }, [onSubmit]);

  // Fire onChange when the rendered value diverges from the last reported value.
  useEffect(() => {
    if (renderState.value !== lastReportedValueRef.current) {
      lastReportedValueRef.current = renderState.value;
      onChange?.(renderState.value);
    }
  }, [renderState.value, onChange]);

  useInput((input, key) => {
    // Pass through keys we don't handle
    if (key.upArrow || key.downArrow || (key.ctrl && input === "c") || key.tab || (key.shift && key.tab)) {
      return;
    }
    if (key.return) {
      submit();
      return;
    }
    // Ctrl+A → start of line (readline/emacs convention)
    if (key.ctrl && input === "a") {
      processAction({ type: "move-cursor-start" });
      return;
    }
    // Ctrl+E → end of line (readline/emacs convention)
    if (key.ctrl && input === "e") {
      processAction({ type: "move-cursor-end" });
      return;
    }
    if (key.leftArrow) {
      processAction({ type: "move-cursor-left" });
    } else if (key.rightArrow) {
      processAction({ type: "move-cursor-right" });
    } else if (key.backspace || key.delete) {
      // Ink maps the physical Backspace key (\x7f) to key.delete, not
      // key.backspace (\x08). We must catch both to reach mark-delete.
      processAction({ type: "mark-delete" });
    } else if (input && !key.ctrl && !key.meta) {
      processAction({ type: "insert", text: input });
    }
  }, { isActive: !isDisabled });

  // +1 accounts for the cursor block at the end of text
  const needsViewport = availableWidth != null
    && Number.isFinite(availableWidth)
    && availableWidth > 0
    && renderState.value.length + 1 > availableWidth;

  // Reset viewport whenever the text fits without scrolling — this prevents
  // a stale offset from causing the window to jump when text grows back past
  // the threshold after deletion.
  if (!needsViewport) {
    viewStartRef.current = 0;
  }

  const rendered = useMemo(() => {
    const { value, cursorOffset, pendingDeleteCount } = renderState;

    let result: string;
    let visibleLen: number;

    if (isDisabled) {
      result = value;
      visibleLen = value.length;
    } else if (value.length === 0) {
      if (placeholder) {
        const maxPh = availableWidth != null && availableWidth > 1 ? availableWidth - 1 : placeholder.length;
        const ph = placeholder.length > maxPh ? placeholder.slice(0, maxPh) : placeholder;
        result = cursorChar + chalk.dim(ph);
        visibleLen = 1 + ph.length;
      } else {
        result = cursorChar;
        visibleLen = 1;
      }
    } else if (needsViewport) {
      const viewStart = computeViewStart(viewStartRef.current, cursorOffset, availableWidth, value.length);
      viewStartRef.current = viewStart;

      const viewEnd = viewStart + availableWidth;
      const atEnd = cursorOffset === value.length;
      const sliceEnd = atEnd ? Math.min(viewEnd - 1, value.length) : Math.min(viewEnd, value.length);
      const visible = value.slice(viewStart, sliceEnd);

      // Segment-based styling: O(1) chalk calls instead of per-character
      result = styleSegments(visible, cursorOffset - viewStart, pendingDeleteCount);
      if (atEnd && cursorOffset >= viewStart && cursorOffset < viewEnd) {
        result += cursorChar;
      }
      visibleLen = availableWidth;
    } else {
      // No viewport needed — render full text with segment-based styling
      const atEnd = cursorOffset === value.length;
      result = styleSegments(value, cursorOffset, pendingDeleteCount);
      if (atEnd) {
        result += cursorChar;
      }
      visibleLen = value.length + (atEnd ? 1 : 0);
    }

    // Pad to fixed width so the Text element never changes visual width.
    // This prevents Yoga layout reflows that corrupt Ink's ANSI output.
    if (availableWidth != null && availableWidth > 0 && visibleLen < availableWidth) {
      result += " ".repeat(availableWidth - visibleLen);
    }

    return result;
  }, [isDisabled, renderState.value, renderState.cursorOffset, renderState.pendingDeleteCount, availableWidth, needsViewport, placeholder]);

  return <Text>{rendered}</Text>;
});
