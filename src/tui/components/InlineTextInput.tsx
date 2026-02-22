import React, { useReducer, useCallback, useEffect, useMemo } from "react";
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

function reducer(state: State, action: Action): State {
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
      const newOffset = Math.max(0, state.cursorOffset - 1);
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

export interface InlineTextInputProps {
  isDisabled?: boolean;
  defaultValue?: string;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
}

/**
 * Uncontrolled text input with full cursor positioning.
 * Supports: left/right arrows, Home/End, Ctrl+A/E, backspace, delete.
 * Clear by changing the React `key` prop.
 */
export function InlineTextInput({ isDisabled = false, defaultValue = "", onChange, onSubmit }: InlineTextInputProps) {
  const [state, dispatch] = useReducer(reducer, {
    previousValue: defaultValue,
    value: defaultValue,
    cursorOffset: defaultValue.length,
  });

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
        dispatch({ type: "move-cursor-start" });
      } else if (END_SEQUENCES.has(data)) {
        dispatch({ type: "move-cursor-end" });
      }
    };

    emitter.on("input", handleRaw);
    return () => { emitter.removeListener("input", handleRaw); };
  }, [isDisabled, stdinCtx]);

  const submit = useCallback(() => {
    onSubmit?.(state.value);
  }, [state.value, onSubmit]);

  useEffect(() => {
    if (state.value !== state.previousValue) {
      onChange?.(state.value);
    }
  }, [state.previousValue, state.value, onChange]);

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
      dispatch({ type: "move-cursor-start" });
      return;
    }
    // Ctrl+E → end of line (readline/emacs convention)
    if (key.ctrl && input === "e") {
      dispatch({ type: "move-cursor-end" });
      return;
    }
    if (key.leftArrow) {
      dispatch({ type: "move-cursor-left" });
    } else if (key.rightArrow) {
      dispatch({ type: "move-cursor-right" });
    } else if (key.backspace || key.delete) {
      dispatch({ type: "delete" });
    } else if (input && !key.ctrl && !key.meta) {
      dispatch({ type: "insert", text: input });
    }
  }, { isActive: !isDisabled });

  const rendered = useMemo(() => {
    if (isDisabled) {
      return state.value;
    }
    if (state.value.length === 0) {
      return cursorChar;
    }
    let result = "";
    let index = 0;
    for (const char of state.value) {
      result += index === state.cursorOffset ? chalk.inverse(char) : char;
      index++;
    }
    if (state.cursorOffset === state.value.length) {
      result += cursorChar;
    }
    return result;
  }, [isDisabled, state.value, state.cursorOffset]);

  return <Text>{rendered}</Text>;
}
