/**
 * Per-turn inactivity watchdog for the codex provider.
 *
 * codex is built to run unattended and, on a persistent rate-limit (429), backs
 * off and retries *internally* — emitting no deltas, items, reasoning, tool
 * calls, or `turn/completed`. The provider's `await completion` would then sit
 * for minutes (until the rate window resets), which presents to the player as a
 * frozen game. This watchdog bounds that: if a turn goes completely silent for
 * `timeoutMs`, `onStall` fires and the provider rejects the turn as a clean,
 * retryable error instead of hanging.
 *
 * Two correctness requirements shape the design:
 *  - **Tool-dispatch pause.** While MV runs a tool the codex turn is paused
 *    awaiting our reply, so codex is *correctly* silent — an image render runs
 *    minutes, a subagent tens of seconds. {@link enterToolDispatch} /
 *    {@link exitToolDispatch} suspend the timer for that whole window so a
 *    healthy long tool call is never mistaken for a stall. A depth counter (not
 *    a flag) keeps this correct when codex issues tool calls concurrently.
 *  - **Re-arm on activity.** {@link note} is called on every codex notification
 *    for the turn (and once when the turn starts), so the timer only ever
 *    elapses when codex itself goes dark while it owes us a turn.
 *
 * Not thread-safe in the OS sense, but JS is single-threaded; the depth counter
 * only needs to survive interleaved async tool dispatches, which it does.
 */
export class StallWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dispatchDepth = 0;

  constructor(
    private readonly timeoutMs: number,
    private readonly onStall: () => void,
  ) {}

  /**
   * Record activity — codex emitted something, or the turn just started.
   * (Re)arms the timer unless a tool dispatch currently has it paused.
   */
  note(): void {
    if (this.dispatchDepth > 0) return;
    this.clear();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onStall();
    }, this.timeoutMs);
    // Don't let a pending watchdog keep the process alive on its own.
    this.timer.unref?.();
  }

  /** Begin a tool dispatch: suspend the timer for its (possibly long) duration. */
  enterToolDispatch(): void {
    this.dispatchDepth++;
    this.clear();
  }

  /** End a tool dispatch; re-arm only once the last concurrent dispatch returns. */
  exitToolDispatch(): void {
    this.dispatchDepth = Math.max(0, this.dispatchDepth - 1);
    if (this.dispatchDepth === 0) this.note();
  }

  /** Cancel the timer. Idempotent — safe to call on settle and in cleanup. */
  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
