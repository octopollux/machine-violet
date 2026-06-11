import { recordElapsedSpan } from "../context/index.js";

/**
 * A settle whose wall-clock exceeds this is treated as a real block (background
 * work overran the gap meant to hide it) and recorded as a `barrier_wait` span.
 * Below it, the lanes were already settled and `Promise.all` returned within a
 * microtask — noise we don't log.
 */
const BARRIER_WAIT_EPSILON_MS = 1;

/**
 * Registry of detached background work that must be consistent at barriers.
 *
 * Some per-turn work doesn't gate the player: the scribe persists entity files
 * the DM never reads back; the scene-tracker refreshes threads/intents the DM
 * reads only *next* turn. Running such work inline taxes every turn with latency
 * that human think-time could have hidden. So we detach it onto a **lane** and
 * flush at the points where staleness would actually be observable.
 *
 * - A **lane** is an independently-serialized promise chain. Work enqueued on a
 *   lane runs after that lane's previous work (so e.g. consecutive scribes apply
 *   in order — dedup needs scribe N's tree deltas before scribe N+1 reads), while
 *   different lanes run in parallel. Think-time therefore hides `max()` across
 *   lanes, not their sum.
 * - `settle()` is the **barrier**: it awaits *every* lane. That symmetry is the
 *   point — a newly added lane is automatically covered by every existing
 *   barrier, and a newly added barrier automatically covers every existing lane,
 *   with no per-site wiring. It kills the "forgot a barrier for the new task" bug
 *   class (cf. the `promote_character` barrier the scribe detach only caught in
 *   review). Call `settle` at every point that reads or snapshots the durable
 *   state this work touches: the next turn's context build, scene transition,
 *   session end, rollback.
 *
 * Errors are swallowed at the chain seam, so one failed task never poisons its
 * lane or a later `settle`; tasks own their own error reporting.
 *
 * Self-measuring: a `settle` that actually *blocks* (work overran the hiding
 * gap) is recorded as a `barrier_wait` span, so the flame chart shows the real
 * overrun rate instead of us guessing it. An instant settle — the overwhelming
 * common case, since the player's think-time dwarfs a small-model round-trip —
 * writes nothing.
 */
export class DeferredWork {
  /** Latest tail promise per lane. Keyed by lane name; at most one entry/lane. */
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly now: () => number;

  constructor(opts?: { now?: () => number }) {
    this.now = opts?.now ?? Date.now;
  }

  /**
   * Enqueue `work` on `lane`, serialized after the lane's prior work. Returns
   * immediately; the work runs detached. The `.catch` seam keeps a failed task
   * from poisoning the chain or a later `settle` await — `work` is responsible
   * for reporting its own failure.
   */
  enqueue(lane: string, work: () => Promise<void>): void {
    const prev = this.lanes.get(lane) ?? Promise.resolve();
    this.lanes.set(lane, prev.catch(() => undefined).then(work));
  }

  /**
   * Barrier: await every lane's in-flight work. Never throws. Usually instant —
   * by the time the player acts or a scene ends, background work has long
   * finished; it only blocks when work overran the hiding gap, which is exactly
   * when waiting is correct. A blocking settle is attributed to a `barrier_wait`
   * span named `label` (e.g. the barrier site), nested under the open turn span
   * when there is one.
   */
  async settle(label: string): Promise<void> {
    const pending = [...this.lanes.values()];
    if (pending.length === 0) return;
    const t0 = this.now();
    await Promise.all(pending);
    const t1 = this.now();
    if (t1 - t0 > BARRIER_WAIT_EPSILON_MS) {
      recordElapsedSpan({ kind: "barrier_wait", name: label, t0, t1 });
    }
  }
}
