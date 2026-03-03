/**
 * Prevents raw mode from being disabled during gameplay.
 *
 * On Windows, when stdin briefly leaves raw mode the console enables
 * ENABLE_LINE_INPUT + ENABLE_PROCESSED_INPUT, which causes the system
 * to process Backspace bytes destructively — visually erasing characters
 * from the terminal display.
 *
 * Defense: intercept `stdin.setRawMode(false)` and swallow it so Ink's
 * reference-counting can never turn raw mode off.  The separate
 * `useRawModeGuardian` React hook (500ms poll) recovers from rare
 * OS-level console mode resets (ConPTY, window focus changes).
 *
 * Call `unlock()` during shutdown to restore normal behavior.
 */

export interface RawModeGuardStdin {
  setRawMode?: (mode: boolean) => unknown;
  isRaw?: boolean;
  isTTY?: boolean;
}

export function installRawModeGuard(stdin: RawModeGuardStdin): () => void {
  if (!stdin.setRawMode || !stdin.isTTY) {
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- no-op unlock when setRawMode unavailable
    return () => {};
  }

  const originalSetRawMode = stdin.setRawMode.bind(stdin);

  // Intercept setRawMode(false) — keep raw mode on.
  stdin.setRawMode = function (mode: boolean) {
    if (!mode) {
      return stdin;
    }
    return originalSetRawMode(mode);
  };

  // Ensure raw mode is on from the start.
  originalSetRawMode(true);

  // Unlock: restore original setRawMode.
  return () => {
    stdin.setRawMode = originalSetRawMode;
  };
}
