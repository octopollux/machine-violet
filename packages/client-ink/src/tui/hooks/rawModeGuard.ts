/**
 * Prevents raw mode from being disabled during gameplay.
 *
 * On Windows, when stdin briefly leaves raw mode the console enables
 * ENABLE_LINE_INPUT + ENABLE_PROCESSED_INPUT, which causes the system
 * to process Backspace bytes destructively — visually erasing characters
 * from the terminal display.
 *
 * Defense layers:
 *  1. Intercept `stdin.setRawMode(false)` and swallow it so Ink's
 *     reference-counting can never turn raw mode off.
 *  2. `forceRefreshRawMode()` toggles raw mode off→on via the *original*
 *     setRawMode (bypassing the intercept), forcing libuv to re-call
 *     SetConsoleMode and restoring correct flags even when ConPTY has
 *     silently corrupted them. On Node ≥24.2 this also re-enables
 *     ENABLE_VIRTUAL_TERMINAL_INPUT (UV_TTY_MODE_RAW_VT).
 *
 * Call `unlock()` during shutdown to restore normal behavior.
 */

export interface RawModeGuardStdin {
  setRawMode?: (mode: boolean) => unknown;
  isRaw?: boolean;
  isTTY?: boolean;
}

let _originalSetRawMode: ((mode: boolean) => unknown) | null = null;

export function installRawModeGuard(stdin: RawModeGuardStdin): () => void {
  if (!stdin.setRawMode || !stdin.isTTY) {
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- no-op unlock when setRawMode unavailable
    return () => {};
  }

  const original = stdin.setRawMode.bind(stdin);
  _originalSetRawMode = original;

  // Intercept setRawMode(false) — keep raw mode on.
  stdin.setRawMode = function (mode: boolean) {
    if (!mode) {
      return stdin;
    }
    return original(mode);
  };

  // Ensure raw mode is on from the start.
  original(true);

  // Unlock: restore original setRawMode.
  return () => {
    stdin.setRawMode = original;
    _originalSetRawMode = null;
  };
}

/**
 * Force-toggle raw mode off→on, bypassing the guard's setRawMode(false)
 * intercept.  This defeats libuv's mode cache (which short-circuits
 * when the requested mode matches the cached mode) and forces an actual
 * SetConsoleMode call, restoring console flags that ConPTY may have
 * silently corrupted.
 *
 * The cooked-mode window between the two synchronous native calls is
 * a few microseconds — negligible risk of destructive input processing.
 *
 * No-op on non-Windows or when no guard is installed.
 */
export function forceRefreshRawMode(): void {
  if (process.platform !== "win32" || !_originalSetRawMode) return;
  try {
    _originalSetRawMode(false);
    _originalSetRawMode(true);
  } catch {
    // stdin may be destroyed during shutdown — ignore
  }
}
