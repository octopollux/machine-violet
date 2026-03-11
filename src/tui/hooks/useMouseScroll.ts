import { useEffect } from "react";
import type { EventEmitter } from "events";

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

/** Matches all SGR mouse sequences (press and release). */
// eslint-disable-next-line no-control-regex -- intentional: parsing ANSI escape sequences
const SGR_MOUSE_RE = /\x1b\[<(\d+);\d+;\d+[Mm]/g;

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

  const re = new RegExp(SGR_MOUSE_RE.source, SGR_MOUSE_RE.flags);
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

/**
 * Strip all SGR mouse sequences from a buffer, returning the remainder.
 * Returns null if the entire buffer was mouse sequences.
 */
export function stripMouseSequences(data: Buffer): Buffer | null {
  const str = data.toString("utf8");
  const stripped = str.replace(SGR_MOUSE_RE, "");
  if (stripped.length === 0) return null;
  if (stripped.length === str.length) return data; // nothing changed
  return Buffer.from(stripped, "utf8");
}

// ---------------------------------------------------------------------------
// stdin filter — intercepts emit('data') to strip mouse sequences before
// Ink's input handler sees them. Same monkey-patch pattern as rawModeGuard.
// ---------------------------------------------------------------------------

export interface FilterableInput extends EventEmitter {
  emit(event: string | symbol, ...args: unknown[]): boolean;
}

/**
 * Install a stdin filter that strips SGR mouse sequences from data events,
 * calling `onScroll` for each scroll event found. Non-mouse bytes pass
 * through to downstream listeners (Ink). If the entire buffer is mouse
 * data, the emit is suppressed entirely.
 *
 * Returns a teardown function that restores the original emit.
 */
export function installMouseFilter(
  input: FilterableInput,
  onScroll: (delta: number) => void,
): () => void {
  const originalEmit = input.emit.bind(input);

  input.emit = function filteredEmit(event: string | symbol, ...args: unknown[]): boolean {
    if (event !== "data") return originalEmit(event, ...args);

    const data = args[0];
    if (!Buffer.isBuffer(data)) return originalEmit(event, ...args);

    // Extract scroll events
    const scrolls = parseScrollEvents(data);
    for (const delta of scrolls) {
      onScroll(delta);
    }

    // Strip all mouse sequences; pass remainder to Ink
    const remainder = stripMouseSequences(data);
    if (remainder === null) return true; // fully consumed
    return originalEmit(event, remainder, ...args.slice(1));
  };

  return () => {
    input.emit = originalEmit;
  };
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/**
 * Enable terminal mouse reporting and scroll the narrative area on wheel
 * events. Each wheel tick scrolls by exactly 1 line.
 *
 * Installs a stdin filter that intercepts mouse sequences before Ink sees
 * them (preventing garbage in the text input). Enables reporting on mount,
 * disables on unmount. A process 'exit' listener acts as a safety net so
 * a crash doesn't leave the terminal in mouse mode.
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

    const removeFilter = installMouseFilter(
      input as FilterableInput,
      (delta) => { scrollRef.current?.scrollBy(delta); },
    );

    // Safety net: disable mouse reporting on process exit even if unmount
    // doesn't run (e.g. uncaught exception after default handler).
    const onExit = () => { disableMouseReporting(output); };
    process.on("exit", onExit);

    return () => {
      removeFilter();
      process.off("exit", onExit);
      disableMouseReporting(output);
    };
  }, [scrollRef]);
}
