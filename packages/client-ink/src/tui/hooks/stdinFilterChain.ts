/**
 * Managed stdin.read() filter chain.
 *
 * Both the Kitty keyboard protocol filter and the mouse scroll filter
 * need to intercept stdin.read() to strip escape sequences before Ink
 * processes them. Rather than each independently monkey-patching read()
 * (fragile ordering by mount timing), this module wraps read() once and
 * runs an ordered list of filter functions.
 *
 * Each filter processes the data string, strips matched sequences (with
 * side effects like dispatching keys or scroll events), and returns the
 * remainder. Filters run in registration order; each receives the output
 * of the previous filter.
 */

export interface ReadableStdin {
  read(size?: number): Buffer | string | null;
}

/**
 * A stdin filter processes a chunk of input data, strips matched
 * sequences (dispatching any side effects internally), and returns
 * the remainder. Return null if the entire chunk was consumed.
 */
export interface StdinFilter {
  /** Short name for debugging. */
  name: string;
  /** Process data, return remainder. Null = fully consumed. */
  process(data: string): string | null;
}

export interface StdinFilterChain {
  /** Add a filter to the end of the chain. Returns a remove function. */
  add(filter: StdinFilter): () => void;
  /** Remove all filters and restore the original read(). */
  teardown(): void;
}

/**
 * Install a filter chain on a readable stdin stream.
 *
 * Wraps `input.read()` once. All registered filters run in order on
 * each read() call. The chain preserves the original chunk type
 * (string or Buffer) and returns empty rather than null when the
 * chunk is fully consumed (to avoid desyncing the stream's internal
 * buffer state).
 */
export function installStdinFilterChain(input: ReadableStdin): StdinFilterChain {
  const originalRead = input.read.bind(input);
  const filters: StdinFilter[] = [];

  input.read = function chainedRead(size?: number): Buffer | string | null {
    const chunk = originalRead(size);
    if (chunk === null) return null;

    const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let current: string | null = str;

    for (const filter of filters) {
      if (current === null || current.length === 0) break;
      current = filter.process(current);
    }

    // Return empty (not null) when fully consumed — null would signal
    // "no data available" and desync the stream's internal buffer.
    if (current === null || current.length === 0) {
      return typeof chunk === "string" ? "" : Buffer.alloc(0);
    }
    if (typeof chunk === "string") return current;
    return Buffer.from(current, "utf8");
  };

  return {
    add(filter: StdinFilter): () => void {
      filters.push(filter);
      return () => {
        const idx = filters.indexOf(filter);
        if (idx !== -1) filters.splice(idx, 1);
      };
    },
    teardown() {
      filters.length = 0;
      input.read = originalRead;
    },
  };
}
