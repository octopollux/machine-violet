/**
 * State-driven waiting primitives. The whole point of the harness is to
 * watch for observable state transitions instead of guessing how long an
 * operation will take. Every wait returns the first observed state that
 * satisfies its predicate, or throws a structured TimeoutError after a
 * cap that is generous but finite.
 *
 * Defaults:
 *   - shortMs:  10s — UI transitions (menu navigation, choice presentation)
 *   - turnMs:   60s — most LLM turns
 *   - longMs:  600s — first DM turn after setup handoff (3-5 min observed)
 *
 * Pollers tick at 200 ms by default. Callers can override.
 */

export const DEFAULT_POLL_MS = 200;
export const DEFAULT_SHORT_TIMEOUT_MS = 10_000;
export const DEFAULT_TURN_TIMEOUT_MS = 60_000;
export const DEFAULT_LONG_TIMEOUT_MS = 600_000;

export interface WaitOptions {
  /** Human-readable description of what is being awaited. Appears in errors. */
  description: string;
  /** Total time budget before throwing. */
  timeoutMs?: number;
  /** Poll interval. */
  pollMs?: number;
  /** Optional callback invoked on each poll with the latest sample. */
  onSample?: (sample: unknown, elapsedMs: number) => void;
}

export class TimeoutError extends Error {
  constructor(
    description: string,
    public readonly elapsedMs: number,
    public readonly lastSample: unknown,
  ) {
    super(`Timed out after ${elapsedMs}ms waiting for: ${description}`);
    this.name = "TimeoutError";
  }
}

/**
 * Generic poller. Repeatedly calls `sample()` and tests the result with
 * `predicate()`. Returns the first satisfying sample, or throws TimeoutError.
 *
 * Errors thrown by `sample()` are swallowed and treated as "not ready yet"
 * unless the timeout elapses — useful for waiting on a process that hasn't
 * started its HTTP server yet.
 */
export async function pollUntil<T>(
  sample: () => Promise<T>,
  predicate: (value: T) => boolean,
  opts: WaitOptions,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SHORT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const start = Date.now();
  let lastSample: T | undefined;
  let lastError: unknown;

  for (;;) {
    const elapsed = Date.now() - start;
    try {
      const value = await sample();
      lastSample = value;
      opts.onSample?.(value, elapsed);
      if (predicate(value)) return value;
    } catch (err) {
      lastError = err;
    }

    if (Date.now() - start >= timeoutMs) {
      throw new TimeoutError(opts.description, Date.now() - start, lastSample ?? lastError);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
