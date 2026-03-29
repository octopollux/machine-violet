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
export function parseScrollEvents(data: Buffer | string): number[] {
  const results: number[] = [];
  const str = typeof data === "string" ? data : data.toString("utf8");

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
 * Strip all SGR mouse sequences from a string, returning the remainder.
 * Returns null if the entire string was mouse sequences.
 */
export function stripMouseSequences(data: string): string | null {
  const stripped = data.replace(SGR_MOUSE_RE, "");
  if (stripped.length === 0) return null;
  if (stripped.length === data.length) return data; // nothing changed
  return stripped;
}

// ---------------------------------------------------------------------------
// stdin filter — intercepts read() to strip mouse sequences before
// Ink's input handler sees them.
//
// Ink uses the readable stream protocol: it listens for 'readable' events
// then pulls chunks via stdin.read(). Intercepting emit('data') does nothing
// because Ink never uses 'data' events. We monkey-patch read() instead.
// ---------------------------------------------------------------------------

export interface ReadableStdin {
  read(size?: number): Buffer | string | null;
}

/**
 * Install a stdin filter that wraps read() to strip SGR mouse sequences
 * from chunks before Ink processes them. Calls `onScroll` for each scroll
 * event found, deferred via process.nextTick so the read() call completes
 * before any React re-rendering occurs. If a chunk is entirely mouse data,
 * read() returns an empty string so the stream's readable state stays
 * consistent (returning null would signal "no data" and can desync the
 * stream's internal buffer tracking).
 *
 * Returns a teardown function that restores the original read.
 */
export function installMouseFilter(
  input: ReadableStdin,
  onScroll: (delta: number) => void,
): () => void {
  const originalRead = input.read.bind(input);

  input.read = function filteredRead(size?: number): Buffer | string | null {
    const chunk = originalRead(size);
    if (chunk === null) return null;

    const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");

    // Extract scroll events — defer dispatch so read() returns before
    // any React/Ink re-rendering is triggered by scrollBy().
    const scrolls = parseScrollEvents(str);
    if (scrolls.length > 0) {
      process.nextTick(() => {
        for (const delta of scrolls) {
          onScroll(delta);
        }
      });
    }

    // Strip all mouse sequences; pass remainder to Ink.
    // Return empty string (not null) when fully consumed — null would
    // signal "no data available" and can desync the stream's internal
    // buffer state since originalRead() already consumed the bytes.
    const remainder = stripMouseSequences(str);
    if (remainder === null) return typeof chunk === "string" ? "" : Buffer.alloc(0);

    // Preserve the original type (Ink sets encoding to utf8, so string)
    if (typeof chunk === "string") return remainder;
    return Buffer.from(remainder, "utf8");
  };

  return () => {
    input.read = originalRead;
  };
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/** Lines scrolled per mouse wheel tick. */
export const LINES_PER_TICK = 2;

/**
 * Enable terminal mouse reporting and scroll the narrative area on wheel
 * events. Each wheel tick scrolls by {@link LINES_PER_TICK} lines.
 *
 * Wraps stdin.read() to intercept mouse sequences before Ink processes
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

    // Skip in non-TTY environments (tests, piped input/output).
    if (!output.isTTY || !input.isTTY) return;

    enableMouseReporting(output);

    const removeFilter = installMouseFilter(
      input as ReadableStdin,
      (delta) => { scrollRef.current?.scrollBy(delta * LINES_PER_TICK); },
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
