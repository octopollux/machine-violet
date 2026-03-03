/**
 * Prevents raw mode from being disabled during gameplay.
 *
 * On Windows, when stdin briefly leaves raw mode the console enables
 * ENABLE_LINE_INPUT + ENABLE_PROCESSED_INPUT, which causes the system
 * to process Backspace bytes destructively — visually erasing characters
 * from the terminal display.  Delete key is unaffected because its
 * escape sequence (\x1b[3~) is not handled by the Windows console in
 * cooked mode.
 *
 * Three layers of protection:
 * 1. **Intercept** `stdin.setRawMode(false)` — swallow it so Ink's
 *    reference-counting can never turn raw mode off.
 * 2. **Watchdog timer** — unconditionally re-assert `setRawMode(true)`
 *    every tick to recover from external OS-level console mode resets
 *    (ConPTY, window focus changes, etc.).  The call is unconditional
 *    because `stdin.isRaw` may be stale after an external reset.
 * 3. **Pre-read hook** — `prependListener('readable', …)` re-asserts
 *    raw mode right before each batch of input is read, limiting any
 *    cooked-mode gap to at most one key event.
 *
 * Call `unlock()` during shutdown to restore normal behavior.
 */

/** How often the watchdog re-asserts raw mode (ms). */
export const WATCHDOG_INTERVAL_MS = 10;

export interface RawModeGuardStdin {
  setRawMode?: (mode: boolean) => unknown;
  isRaw?: boolean;
  isTTY?: boolean;
  prependListener?(event: string, listener: () => void): unknown;
  removeListener?(event: string, listener: () => void): unknown;
}

export function installRawModeGuard(stdin: RawModeGuardStdin): () => void {
  if (!stdin.setRawMode || !stdin.isTTY) {
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- no-op unlock when setRawMode unavailable
    return () => {};
  }

  const originalSetRawMode = stdin.setRawMode.bind(stdin);

  // --- Layer 1: intercept setRawMode(false) ---
  stdin.setRawMode = function (mode: boolean) {
    if (!mode) {
      // Swallow the disable — keep raw mode on.
      return stdin;
    }
    return originalSetRawMode(mode);
  };

  // Ensure raw mode is on from the start.
  originalSetRawMode(true);

  // --- Layer 2: periodic watchdog ---
  // Unconditionally re-assert raw mode.  We do NOT check stdin.isRaw
  // because it may be stale after an external console mode change.
  const watchdog = setInterval(() => {
    try {
      originalSetRawMode(true);
    } catch {
      // stdin may be destroyed during shutdown — ignore
    }
  }, WATCHDOG_INTERVAL_MS);

  // Don't let the watchdog keep the process alive during shutdown.
  if (typeof watchdog === "object" && "unref" in watchdog) {
    watchdog.unref();
  }

  // --- Layer 3: pre-read hook ---
  // Re-assert raw mode right before Ink reads the next batch of input.
  // This limits any cooked-mode gap to at most one key event.
  const onReadable = () => {
    try {
      originalSetRawMode(true);
    } catch {
      // ignore — stdin may be destroyed
    }
  };
  stdin.prependListener?.("readable", onReadable);

  // Unlock: stop all guards and restore original setRawMode.
  return () => {
    clearInterval(watchdog);
    stdin.removeListener?.("readable", onReadable);
    stdin.setRawMode = originalSetRawMode;
  };
}
