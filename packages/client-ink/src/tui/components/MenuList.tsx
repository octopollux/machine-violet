import React from "react";
import { Text } from "ink";
import type { ResolvedTheme } from "../themes/types.js";
import { themeColor } from "../themes/color-resolve.js";

/**
 * Shared menu-list rendering for out-of-game screens.
 *
 * Every full-screen menu (Settings, Connect to AI, wizards) renders rows
 * through `buildMenuLines` so the selection markers (◆/○), colors, disabled
 * treatment, and description grammar stay identical across screens. The
 * caller keeps input handling and passes the current selection index.
 */

export interface MenuRow {
  key: string;
  label: string;
  /** Dim explanatory text rendered after the label (` — description`). */
  description?: string;
  /** Disabled rows render dark and callers should refuse Enter on them. */
  disabled?: boolean;
  /** Emphasized rows render in the accent color even when not selected. */
  emphasis?: boolean;
  /** Trailing text rendered after the description (e.g. `  ON`, ` · in use`). */
  suffix?: string;
  suffixColor?: string;
  /** Extra leading indent (columns of two spaces). */
  indent?: number;
}

export interface MenuPalette {
  accent: string;
  fg: string;
  dim: string;
  disabled: string;
}

/** Resolve the standard menu palette from a theme. */
export function menuPalette(theme: ResolvedTheme): MenuPalette {
  return {
    accent: themeColor(theme, "title") ?? "#ffffff",
    fg: "#cccccc",
    dim: themeColor(theme, "separator") ?? "#666666",
    disabled: "#555555",
  };
}

/**
 * Render menu rows as one physical line each. The returned array length is
 * exactly `rows.length`, so callers can pass it straight to
 * `FullScreenFrame`'s `contentRows` math (plus any header/footer lines they
 * add themselves).
 */
export function buildMenuLines(
  rows: MenuRow[],
  selectedIndex: number,
  palette: MenuPalette,
): React.ReactNode[] {
  return rows.map((row, i) => {
    const selected = i === selectedIndex;
    const marker = selected ? "◆" : "○";
    const markerColor = row.disabled
      ? palette.disabled
      : row.emphasis
        ? palette.accent
        : selected
          ? palette.accent
          : palette.dim;
    const labelColor = row.disabled
      ? palette.disabled
      : row.emphasis || selected
        ? palette.accent
        : palette.fg;
    const descColor = row.disabled ? palette.disabled : palette.dim;
    const pad = "  ".repeat(row.indent ?? 0);
    return (
      <Text key={row.key}>
        <Text>{pad}</Text>
        <Text color={markerColor}>{marker}</Text>
        <Text color={labelColor} bold={row.emphasis || (selected && !row.disabled)} dimColor={row.disabled}>
          {` ${row.label}`}
        </Text>
        {row.description ? (
          <Text color={descColor} dimColor={row.disabled}>{` — ${row.description}`}</Text>
        ) : null}
        {row.suffix ? (
          <Text color={row.suffixColor ?? palette.dim} bold={selected}>{row.suffix}</Text>
        ) : null}
      </Text>
    );
  });
}

/**
 * Standard key-hint footer: joins parts with ` · `. All menus use the same
 * grammar — `↑↓ select · Enter confirm · Esc back` — with screen-specific
 * verbs after Enter/letter keys. Falsy parts are skipped so hints can be
 * conditional inline.
 */
export function hintBar(...parts: (string | false | null | undefined)[]): string {
  return parts.filter((p): p is string => !!p).join(" · ");
}
