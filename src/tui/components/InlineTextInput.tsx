import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, useInput, useStdin } from "ink";
import chalk from "chalk";

interface State {
  previousValue: string;
  value: string;
  cursorOffset: number;
}

type Action =
  | { type: "move-cursor-left" }
  | { type: "move-cursor-right" }
  | { type: "move-cursor-start" }
  | { type: "move-cursor-end" }
  | { type: "insert"; text: string }
  | { type: "delete" };

export function reducer(state: State, action: Action): State {
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
        previousValue: state.value,
        value: state.value.slice(0, state.cursorOffset) + action.text + state.value.slice(state.cursorOffset),
        cursorOffset: state.cursorOffset + action.text.length,
      };
    case "delete": {
      if (state.cursorOffset === 0) return state;
      const newOffset = state.cursorOffset - 1;
      return {
        ...state,
        previousValue: state.value,
        value: state.value.slice(0, newOffset) + state.value.slice(newOffset + 1),
        cursorOffset: newOffset,
      };
    }
  }
}

const cursorChar = chalk.inverse(" ");

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
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
}

/** Minimum interval (ms) between React re-renders triggered by input.
 *  ~34ms ≈ 30fps — fast enough for responsive typing, slow enough
 *  to let the terminal fully process each frame's ANSI escape codes
 *  before the next arrives. */
export const RENDER_THROTTLE_MS = 34;

/**
 * Uncontrolled text input with full cursor positioning.
 * Supports: left/right arrows, Home/End, Ctrl+A/E, backspace, delete.
 * Clear by changing the React `key` prop.
 *
 * Actions are applied immediately to a ref-held state so the value is
 * always current, but React re-renders are throttled to ~60 fps to
 * prevent terminal rendering corruption during rapid key repeats.
 */
export function InlineTextInput({ isDisabled = false, defaultValue = "", availableWidth, onChange, onSubmit }: InlineTextInputProps) {
  const initialState: State = {
    previousValue: defaultValue,
    value: defaultValue,
    cursorOffset: defaultValue.length,
  };

  // True state lives in a ref — always current, never triggers a render.
  const stateRef = useRef<State>(initialState);

  // Render state — synced from stateRef at a throttled rate.
  const [renderState, setRenderState] = useState<State>(initialState);

  // Timer handle for the throttled render sync.
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track last value reported to onChange to avoid duplicate callbacks.
  const lastReportedValueRef = useRef(defaultValue);

  const viewStartRef = useRef(0);

  /** Flush ref state to render state immediately. */
  const flushRender = useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    setRenderState(stateRef.current);
  }, []);

  /** Apply an action and schedule a throttled render. */
  const processAction = useCallback((action: Action) => {
    const prev = stateRef.current;
    const next = reducer(prev, action);
    if (next === prev) return; // No state change (e.g. backspace at position 0)
    stateRef.current = next;
    if (flushTimerRef.current === null) {
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        setRenderState(stateRef.current);
      }, RENDER_THROTTLE_MS);
    }
  }, []);

  // Clean up throttle timer on unmount.
  useEffect(() => {
    return () => {
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
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
    flushRender();
    onSubmit?.(stateRef.current.value);
  }, [onSubmit, flushRender]);

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
      processAction({ type: "delete" });
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
    if (isDisabled) {
      return renderState.value;
    }
    if (renderState.value.length === 0) {
      return cursorChar;
    }

    if (needsViewport) {
      const viewStart = computeViewStart(viewStartRef.current, renderState.cursorOffset, availableWidth, renderState.value.length);
      viewStartRef.current = viewStart;

      const viewEnd = viewStart + availableWidth;
      // If cursor is at end of text, we need room for the cursor block
      const atEnd = renderState.cursorOffset === renderState.value.length;
      const sliceEnd = atEnd ? Math.min(viewEnd - 1, renderState.value.length) : Math.min(viewEnd, renderState.value.length);
      const visible = renderState.value.slice(viewStart, sliceEnd);

      let result = "";
      for (let i = 0; i < visible.length; i++) {
        const globalIndex = viewStart + i;
        result += globalIndex === renderState.cursorOffset ? chalk.inverse(visible[i]) : visible[i];
      }
      if (atEnd && renderState.cursorOffset >= viewStart && renderState.cursorOffset < viewEnd) {
        result += cursorChar;
      }
      return result;
    }

    // No viewport needed — render full text
    let result = "";
    let index = 0;
    for (const char of renderState.value) {
      result += index === renderState.cursorOffset ? chalk.inverse(char) : char;
      index++;
    }
    if (renderState.cursorOffset === renderState.value.length) {
      result += cursorChar;
    }
    return result;
  }, [isDisabled, renderState.value, renderState.cursorOffset, availableWidth, needsViewport]);

  return <Text>{rendered}</Text>;
}
