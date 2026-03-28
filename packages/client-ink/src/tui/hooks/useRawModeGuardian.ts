import { useEffect, useRef } from "react";
import { forceRefreshRawMode } from "./rawModeGuard.js";

export interface RawModeGuardianOptions {
  /** Set false to pause polling (e.g. during loading / shutdown). Default true. */
  enabled?: boolean;
  /** Polling interval in ms.  Default 500. */
  intervalMs?: number;
  /** Called each time raw mode is force-refreshed. */
  onRefresh?: () => void;
}

/**
 * Periodically force-refreshes the console mode on Windows to recover
 * from ConPTY console-mode corruption (microsoft/terminal#19674).
 *
 * On Windows, ConPTY can silently re-enable ENABLE_PROCESSED_INPUT
 * during long-running TUI sessions, causing backspace and other
 * control characters to be processed destructively.  libuv caches
 * the raw-mode state internally and short-circuits repeated
 * setRawMode(true) calls, so simply calling setRawMode(true)
 * cannot fix the corruption.
 *
 * This hook calls `forceRefreshRawMode()` (which toggles raw mode
 * off→on via the original setRawMode, bypassing both the guard
 * intercept and libuv's cache) every `intervalMs` milliseconds.
 *
 * No-op on non-Windows platforms.
 */
export function useRawModeGuardian(options?: RawModeGuardianOptions): void {
  const enabled = options?.enabled ?? true;
  const intervalMs = options?.intervalMs ?? 500;
  const onRefresh = options?.onRefresh;
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    if (!enabled || process.platform !== "win32") return;
    const id = setInterval(() => {
      forceRefreshRawMode();
      onRefreshRef.current?.();
    }, intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);
}
