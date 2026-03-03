/**
 * Prevents raw mode from being disabled during gameplay.
 *
 * On Windows, when stdin briefly leaves raw mode the console processes
 * pending Backspace bytes destructively — visually erasing characters
 * from the terminal display.  This happens even if raw mode is
 * re-enabled nanoseconds later, because the Windows console subsystem
 * processes the input in the gap.
 *
 * This guard intercepts `process.stdin.setRawMode(false)` and silently
 * swallows it so the console never leaves raw mode while the TUI is
 * running.  Call `unlock()` during shutdown to restore normal behavior.
 */

export function installRawModeGuard(
  stdin: NodeJS.ReadStream & { setRawMode?: (mode: boolean) => NodeJS.ReadStream },
): () => void {
  if (!stdin.setRawMode) {
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

  // Unlock: restore original so shutdown can actually disable raw mode.
  return () => {
    stdin.setRawMode = originalSetRawMode;
  };
}
