/**
 * Pure string-width helpers used by the frame renderer and the .theme composer.
 * Kept in their own module so the composer doesn't pull in the ink/React-laden
 * renderer when imported from browser tools (e.g. the theme editor).
 */
import realStringWidth from "string-width";

/**
 * Display width of a string in terminal columns — the SAME oracle Ink uses for
 * layout (the `string-width` package). Handles full Unicode: CJK/wide glyphs
 * count 2, zero-width/combining marks count 0, emoji (incl. ZWJ sequences and
 * variation selectors) count their rendered width, and ANSI escapes are
 * stripped. This is load-bearing for width-safety: wrapping that measured
 * `String.length` (code units) overflowed on wide chars and truncated content.
 *
 * `truncateToWidth` (below) still slices by code-unit index, so it can over-cut
 * a line containing wide glyphs — acceptable for the frame/modal sizing callers
 * (which deal in box-drawing + mostly-ASCII chrome). The narrative layout engine
 * does width-aware breaking itself rather than relying on truncation.
 */
export function stringWidth(str: string): number {
  return realStringWidth(str);
}

/**
 * Truncate a string to a maximum display width.
 */
export function truncateToWidth(str: string, maxWidth: number): string {
  if (stringWidth(str) <= maxWidth) return str;
  if (maxWidth <= 1) return str.slice(0, maxWidth);
  return str.slice(0, maxWidth - 1) + "…";
}
