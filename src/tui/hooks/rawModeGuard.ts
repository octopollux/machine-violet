/**
 * Prevents raw mode from being disabled during gameplay.
 *
 * On Windows, when stdin briefly leaves raw mode the console processes
 * pending Backspace bytes destructively — visually erasing characters
 * from the terminal display.  This happens even if raw mode is
 * re-enabled nanoseconds later, because the Windows console subsystem
 * processes the input in the gap.
 *
 * Two layers of protection:
 * 1. Intercept `stdin.setRawMode(false)` and swallow it — prevents
 *    Ink's reference-counting from ever turning raw mode off.
 * 2. A watchdog timer that re-asserts `setRawMode(true)` every 10 ms
 *    to recover from external OS-level console mode resets (e.g.
 *    Windows resetting ENABLE_ECHO_INPUT on window focus changes).
 *
 * Call `unlock()` during shutdown to restore normal behavior.
 */

/** How often the watchdog re-asserts raw mode (ms). */
export const WATCHDOG_INTERVAL_MS = 10;

export function installRawModeGuard(
  stdin: NodeJS.ReadStream & {
    setRawMode?: (mode: boolean) => NodeJS.ReadStream;
    isRaw?: boolean;
    isTTY?: boolean;
  },
): () => void {
  if (!stdin.setRawMode || !stdin.isTTY) {
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- no-op unlock when setRawMode unavailable
    return () => {};
  }

  const originalSetRawMode = stdin.setRawMode.bind(stdin);

  stdin.setRawMode = function (mode: boolean): NodeJS.ReadStream {
    if (!mode) {
      // Swallow the disable — keep raw mode on.
      return stdin;
    }
    return originalSetRawMode(mode);
  } as typeof stdin.setRawMode;

  // Ensure raw mode is on from the start.
  originalSetRawMode(true);

  // Watchdog: re-assert raw mode periodically to recover from
  // external resets by the OS / terminal emulator / ConPTY.
  const watchdog = setInterval(() => {
    try {
      if (stdin.isRaw === false) {
        originalSetRawMode(true);
      }
    } catch {
      // stdin may be destroyed during shutdown — ignore
    }
  }, WATCHDOG_INTERVAL_MS);

  // Unlock: stop watchdog and restore original setRawMode.
  return () => {
    clearInterval(watchdog);
    stdin.setRawMode = originalSetRawMode;
  };
}
