import { useEffect, useRef } from "react";

/** Minimal subset of stdin we need for raw mode checks. */
export interface RawModeStdin {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): void;
}

/**
 * Checks whether raw mode has been externally disabled (e.g. terminal lost
 * focus on Windows) and re-enables it.  Exported for direct unit testing.
 */
export function checkAndRestoreRawMode(
  stdin: RawModeStdin,
  onRestore?: () => void,
): void {
  if (!stdin.isTTY) return;
  if (stdin.isRaw !== false) return; // already raw or undefined
  try {
    stdin.setRawMode?.(true);
    onRestore?.();
  } catch {
    // stdin may already be destroyed during shutdown — ignore
  }
}

export interface RawModeGuardianOptions {
  /** Set false to pause polling (e.g. during loading / shutdown). Default true. */
  enabled?: boolean;
  /** Polling interval in ms.  Default 500. */
  intervalMs?: number;
  /** Called each time raw mode is restored. */
  onRestore?: () => void;
}

/**
 * Polls `process.stdin.isRaw` and re-enables raw mode if the OS/terminal
 * disabled it externally (e.g. window blur on Windows 11).
 *
 * Safe to call unconditionally — guards against non-TTY and shutdown races.
 */
export function useRawModeGuardian(options?: RawModeGuardianOptions): void {
  const enabled = options?.enabled ?? true;
  const intervalMs = options?.intervalMs ?? 500;
  const onRestore = options?.onRestore;
  const onRestoreRef = useRef(onRestore);
  onRestoreRef.current = onRestore;

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      checkAndRestoreRawMode(process.stdin, onRestoreRef.current);
    }, intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);
}
