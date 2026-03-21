import React, { useReducer, useMemo } from "react";
import { useInput, Box, Text } from "ink";
import chalk from "chalk";
import type { ResolvedTheme } from "../themes/types.js";
import { ThemedHorizontalBorder, ThemedSideFrame } from "../components/ThemedFrame.js";
import { themeColor, deriveModalTheme } from "../themes/color-resolve.js";
import { stringWidth } from "../frames/index.js";

interface PlayerNotesModalProps {
  theme: ResolvedTheme;
  width: number;
  height: number;
  initialContent: string;
  onSave: (content: string) => void;
  onClose: () => void;
  topOffset?: number;
}

interface EditorState {
  lines: string[];
  row: number;
  col: number;
  scrollOffset: number;
}

type EditorAction =
  | { type: "insert"; text: string }
  | { type: "backspace"; maxRows: number }
  | { type: "enter"; maxRows: number }
  | { type: "up"; maxRows: number }
  | { type: "down"; maxRows: number }
  | { type: "left"; maxRows: number }
  | { type: "right"; maxRows: number }
  | { type: "home" }
  | { type: "end" };

function ensureVisible(r: number, maxRows: number, currentScroll: number): number {
  if (r < currentScroll) return r;
  if (r >= currentScroll + maxRows) return r - maxRows + 1;
  return currentScroll;
}

function editorReducer(state: EditorState, action: EditorAction): EditorState {
  const { lines, row, col, scrollOffset } = state;

  switch (action.type) {
    case "insert": {
      const next = [...lines];
      const line = next[row];
      next[row] = line.slice(0, col) + action.text + line.slice(col);
      return { ...state, lines: next, col: col + action.text.length };
    }

    case "backspace": {
      if (col > 0) {
        const next = [...lines];
        const line = next[row];
        next[row] = line.slice(0, col - 1) + line.slice(col);
        return { ...state, lines: next, col: col - 1 };
      }
      if (row > 0) {
        const next = [...lines];
        const newCol = next[row - 1].length;
        next[row - 1] = next[row - 1] + next[row];
        next.splice(row, 1);
        const newRow = row - 1;
        return {
          lines: next,
          row: newRow,
          col: newCol,
          scrollOffset: ensureVisible(newRow, action.maxRows, scrollOffset),
        };
      }
      return state;
    }

    case "enter": {
      const next = [...lines];
      const line = next[row];
      next.splice(row, 1, line.slice(0, col), line.slice(col));
      const newRow = row + 1;
      return {
        lines: next,
        row: newRow,
        col: 0,
        scrollOffset: ensureVisible(newRow, action.maxRows, scrollOffset),
      };
    }

    case "up": {
      if (row <= 0) return state;
      const newRow = row - 1;
      return {
        ...state,
        row: newRow,
        col: Math.min(col, lines[newRow].length),
        scrollOffset: ensureVisible(newRow, action.maxRows, scrollOffset),
      };
    }

    case "down": {
      if (row >= lines.length - 1) return state;
      const newRow = row + 1;
      return {
        ...state,
        row: newRow,
        col: Math.min(col, lines[newRow].length),
        scrollOffset: ensureVisible(newRow, action.maxRows, scrollOffset),
      };
    }

    case "left": {
      if (col > 0) return { ...state, col: col - 1 };
      if (row > 0) {
        const newRow = row - 1;
        return {
          ...state,
          row: newRow,
          col: lines[newRow].length,
          scrollOffset: ensureVisible(newRow, action.maxRows, scrollOffset),
        };
      }
      return state;
    }

    case "right": {
      if (col < lines[row].length) return { ...state, col: col + 1 };
      if (row < lines.length - 1) {
        const newRow = row + 1;
        return {
          ...state,
          row: newRow,
          col: 0,
          scrollOffset: ensureVisible(newRow, action.maxRows, scrollOffset),
        };
      }
      return state;
    }

    case "home":
      return { ...state, col: 0 };

    case "end":
      return { ...state, col: lines[row].length };
  }
}

/**
 * Player notes modal — a simple multi-line plain text editor.
 * Saves content on ESC close.
 */
export function PlayerNotesModal({
  theme,
  width,
  height,
  initialContent,
  onSave,
  onClose,
  topOffset,
}: PlayerNotesModalProps) {
  const [state, dispatch] = useReducer(editorReducer, initialContent, (content) => {
    const split = content.split("\n");
    return { lines: split.length === 0 ? [""] : split, row: 0, col: 0, scrollOffset: 0 };
  });

  const { lines, row, col, scrollOffset } = state;

  const modalTheme = useMemo(() => deriveModalTheme(theme), [theme]);
  const textColor = themeColor(modalTheme, "sideFrame");

  const sideWidth = theme.asset.components.edge_left.width;
  const borderHeight = theme.asset.height;
  const sidePadding = 1;
  const modalWidth = Math.max(40, Math.min(Math.floor(width * 0.7), 999));
  const innerWidth = modalWidth - 2 * sideWidth - 2 * sidePadding;
  const maxContentRows = Math.max(3, height - 2 * borderHeight - 2);

  useInput((input, key) => {
    if (key.escape) {
      onSave(lines.join("\n"));
      onClose();
      return;
    }

    if (key.upArrow) { dispatch({ type: "up", maxRows: maxContentRows }); return; }
    if (key.downArrow) { dispatch({ type: "down", maxRows: maxContentRows }); return; }
    if (key.leftArrow) { dispatch({ type: "left", maxRows: maxContentRows }); return; }
    if (key.rightArrow) { dispatch({ type: "right", maxRows: maxContentRows }); return; }
    if (key.return) { dispatch({ type: "enter", maxRows: maxContentRows }); return; }
    if (key.backspace || key.delete) { dispatch({ type: "backspace", maxRows: maxContentRows }); return; }
    if (key.ctrl && input === "a") { dispatch({ type: "home" }); return; }
    if (key.ctrl && input === "e") { dispatch({ type: "end" }); return; }

    if (input && !key.ctrl && !key.meta) {
      dispatch({ type: "insert", text: input });
    }
  });

  // Render visible window of lines
  const visibleLines = lines.slice(scrollOffset, scrollOffset + maxContentRows);
  const padStr = " ".repeat(sidePadding);
  const fullRowWidth = innerWidth + 2 * sidePadding;
  const blankLine = " ".repeat(fullRowWidth);

  const contentRows = visibleLines.map((line, i) => {
    const lineIdx = scrollOffset + i;
    const isCursorLine = lineIdx === row;

    // Truncate display if line is wider than innerWidth (horizontal scroll)
    let displayLine = line;
    let displayCol = col;
    if (isCursorLine && stringWidth(line) >= innerWidth) {
      const viewStart = Math.max(0, col - innerWidth + 1);
      displayLine = line.slice(viewStart, viewStart + innerWidth);
      displayCol = col - viewStart;
    } else if (stringWidth(line) > innerWidth) {
      displayLine = line.slice(0, innerWidth);
    }

    // Pad to innerWidth
    const pad = Math.max(0, innerWidth - stringWidth(displayLine));
    const paddedLine = displayLine + " ".repeat(pad);

    if (isCursorLine) {
      const before = paddedLine.slice(0, displayCol);
      const cursorCh = paddedLine[displayCol] ?? " ";
      const after = paddedLine.slice(displayCol + 1);
      return (
        <Box key={lineIdx}>
          <Text color={textColor}>{padStr}{before}{chalk.inverse(cursorCh)}{after}{padStr}</Text>
        </Box>
      );
    }

    return (
      <Box key={lineIdx}>
        <Text color={textColor}>{padStr}{paddedLine}{padStr}</Text>
      </Box>
    );
  });

  // Fill remaining rows with blank lines for opacity
  for (let i = visibleLines.length; i < maxContentRows; i++) {
    contentRows.push(
      <Box key={`blank-${i}`}>
        <Text>{blankLine}</Text>
      </Box>,
    );
  }

  const linesBelow = Math.max(0, lines.length - scrollOffset - maxContentRows);
  const footer = linesBelow > 0
    ? `ESC save & close  (${linesBelow} more)`
    : "ESC save & close";
  const footerColor = themeColor(modalTheme, "title");

  // Render frame directly (not via CenteredModal) so every row is a single
  // opaque <Text> — no flexbox gaps that let the narrative bleed through.
  const modalHeight = maxContentRows + 2 * borderHeight;
  const topMargin = Math.max(0, (topOffset ?? 0) + Math.floor((height - modalHeight) / 2));
  const leftPad = Math.max(0, Math.floor((width - modalWidth) / 2));

  return (
    <Box position="absolute" flexDirection="column" marginTop={topMargin} marginLeft={leftPad}>
      <ThemedHorizontalBorder
        theme={modalTheme}
        width={modalWidth}
        position="top"
        centerText="Player Notes"
      />
      <Box height={maxContentRows} flexDirection="row">
        <ThemedSideFrame theme={modalTheme} side="left" height={maxContentRows} />
        <Box flexDirection="column" width={fullRowWidth}>
          {contentRows}
        </Box>
        <ThemedSideFrame theme={modalTheme} side="right" height={maxContentRows} />
      </Box>
      <ThemedHorizontalBorder
        theme={modalTheme}
        width={modalWidth}
        position="bottom"
        centerText={footer}
        centerTextColor={footerColor}
      />
    </Box>
  );
}

// Export for testing
export { editorReducer, ensureVisible };
export type { EditorState, EditorAction };
