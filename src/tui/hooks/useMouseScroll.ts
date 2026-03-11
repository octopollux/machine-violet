import { useEffect } from "react";

/** Anything with a scrollBy method (ScrollHandle, ScrollViewRef, etc.). */
interface Scrollable {
  scrollBy(delta: number): void;
}

// ---------------------------------------------------------------------------
// ANSI escape sequences for mouse reporting
// ---------------------------------------------------------------------------

/** Enable basic button-event tracking (includes scroll wheel). */
const MOUSE_BTN_ON = "\x1b[?1000h";
/** Enable SGR extended encoding (clean ASCII, no 223-column limit). */
const MOUSE_SGR_ON = "\x1b[?1006h";

/** Disable button-event tracking. */
const MOUSE_BTN_OFF = "\x1b[?1000l";
/** Disable SGR extended encoding. */
const MOUSE_SGR_OFF = "\x1b[?1006l";

export function enableMouseReporting(output: { write(s: string): boolean }): void {
  output.write(MOUSE_BTN_ON);
  output.write(MOUSE_SGR_ON);
}

export function disableMouseReporting(output: { write(s: string): boolean }): void {
  output.write(MOUSE_BTN_OFF);
  output.write(MOUSE_SGR_OFF);
}

// ---------------------------------------------------------------------------
// SGR mouse sequence parser (scroll events only)
// ---------------------------------------------------------------------------

/**
 * SGR mouse sequences look like: \x1b[<btn;x;yM  (press) or ...m (release)
 * For scroll wheel: btn has bit 6 set (btn & 64). Bit 0 = direction:
 *   0 → scroll up, 1 → scroll down.
 *
 * Returns +1 (down) / -1 (up) per scroll event found, or empty array.
 */
export function parseScrollEvents(data: Buffer): number[] {
  const results: number[] = [];
  const str = data.toString("utf8");

  // Match all SGR mouse sequences in the buffer
  // eslint-disable-next-line no-control-regex -- intentional: parsing ANSI escape sequences
  const re = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str)) !== null) {
    const btn = parseInt(m[1], 10);
    if (btn & 64) {
      // Scroll event: bit 0 → 0 = up, 1 = down
      results.push(btn & 1 ? 1 : -1);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/**
 * Enable terminal mouse reporting and scroll the narrative area on wheel
 * events. Each wheel tick scrolls by exactly 1 line.
 *
 * Enables reporting on mount, disables on unmount. A process 'exit' listener
 * acts as a safety net so a crash doesn't leave the terminal in mouse mode.
 */
export function useMouseScroll(
  scrollRef: React.RefObject<Scrollable | null>,
): void {
  useEffect(() => {
    const output = process.stdout;
    const input = process.stdin;

    // Skip in non-TTY environments (tests, piped output).
    if (!output.isTTY) return;

    enableMouseReporting(output);

    const onData = (data: Buffer) => {
      const scrolls = parseScrollEvents(data);
      for (const delta of scrolls) {
        scrollRef.current?.scrollBy(delta);
      }
    };

    // Safety net: disable mouse reporting on process exit even if unmount
    // doesn't run (e.g. uncaught exception after default handler).
    const onExit = () => { disableMouseReporting(output); };

    input.on("data", onData);
    process.on("exit", onExit);

    return () => {
      input.off("data", onData);
      process.off("exit", onExit);
      disableMouseReporting(output);
    };
  }, [scrollRef]);
}
