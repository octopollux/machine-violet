/**
 * Autowrap (DECAWM) guard for the full-screen TUI.
 *
 * MV is unusual among Ink apps: it draws a frame that fills the *entire*
 * terminal (`height={rows}`, `width={cols}`), so it writes the terminal's
 * bottom-right cell — the one cell most Ink apps never touch. With autowrap
 * (DECAWM, private mode 7) enabled, writing a glyph to that last cell leaves
 * the terminal in a "deferred wrap" state; on Windows Terminal this nudges the
 * alternate-screen buffer to scroll by a single line. That one-line overflow is
 * enough for Windows Terminal to show its (auto-hidden) vertical scrollbar,
 * which is painted over the last column and visually eats the right frame edge.
 * A horizontal resize forces a full repaint that looks correct for a frame,
 * then the next paint re-triggers the scroll — the classic "right edge keeps
 * disappearing" report.
 *
 * The fix is the same one ncurses and vim use to draw the bottom-right corner
 * safely: turn autowrap OFF while the full-screen UI owns the terminal, then
 * restore it on teardown. Ink never relies on terminal autowrap — it wraps text
 * to each box width itself and moves the cursor explicitly — so disabling it has
 * no effect on layout, only on the last-cell scroll behavior.
 *
 * DECAWM is a terminal-wide mode (not saved/restored across the alt-screen
 * switch), so we must always restore it, including via an `exit` safety-net.
 */

/** Disable autowrap (DECAWM off). */
const DISABLE_AUTOWRAP = "\x1b[?7l";
/** Enable autowrap (DECAWM on) — the terminal default. */
const ENABLE_AUTOWRAP = "\x1b[?7h";

let _exitCleanup: (() => void) | null = null;

/**
 * Disable terminal autowrap so the full-screen frame can paint its bottom-right
 * cell without scrolling the alt-screen buffer. Registers an `exit` safety-net
 * so autowrap is restored even on SIGINT / uncaught exceptions. Idempotent.
 *
 * Call this AFTER Ink has entered the alternate screen so the mode change lands
 * while the TUI owns the terminal.
 */
export function disableAutowrap(stdout: { write(s: string): boolean }): void {
  if (_exitCleanup) return; // already active

  stdout.write(DISABLE_AUTOWRAP);

  const onExit = () => { stdout.write(ENABLE_AUTOWRAP); };
  process.on("exit", onExit);

  _exitCleanup = () => {
    process.removeListener("exit", onExit);
  };
}

/**
 * Restore terminal autowrap to its default (on) and remove the exit safety-net.
 * Safe to call when autowrap was never disabled.
 */
export function restoreAutowrap(stdout: { write(s: string): boolean }): void {
  if (!_exitCleanup) return;
  stdout.write(ENABLE_AUTOWRAP);
  _exitCleanup();
  _exitCleanup = null;
}
