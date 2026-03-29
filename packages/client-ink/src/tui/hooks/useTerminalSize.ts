import { useState, useEffect } from "react";
import { useStdout } from "ink";

export interface TerminalSize {
  columns: number;
  rows: number;
}

/**
 * Returns reactive terminal dimensions that update on resize.
 *
 * Ink's `useStdout()` gives a static snapshot — reading `stdout.columns`
 * doesn't trigger a re-render when the terminal resizes. This hook
 * listens for the `resize` event and forces a state update.
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 40,
  });

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      setSize({ columns: stdout.columns, rows: stdout.rows });
    };
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  return size;
}
