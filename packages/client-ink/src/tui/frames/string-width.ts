/**
 * Pure string-width helpers used by the frame renderer and the .theme composer.
 * Kept in their own module so the composer doesn't pull in the ink/React-laden
 * renderer when imported from browser tools (e.g. the theme editor).
 */

/**
 * Approximate string width (handles most common cases).
 * Does not handle full Unicode width detection — just counts characters.
 */
export function stringWidth(str: string): number {
  // Strip ANSI escape codes
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * Truncate a string to a maximum display width.
 */
export function truncateToWidth(str: string, maxWidth: number): string {
  if (stringWidth(str) <= maxWidth) return str;
  if (maxWidth <= 1) return str.slice(0, maxWidth);
  return str.slice(0, maxWidth - 1) + "…";
}
