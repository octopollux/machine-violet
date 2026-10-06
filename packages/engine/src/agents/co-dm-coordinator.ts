import type { NormalizedMessage } from '../providers/types.js';

export interface CoDmExchange {
  id: string;
  sceneNumber: number;
  /** Causal presentation revision captured when this observation was committed. */
  knowledgeRevision?: number;
  presentationRevisions?: Record<string, number>;
  events: { kind: 'player' | 'narration' | 'annotation' | 'tool' | 'bootstrap' | 'operator' | 'lifecycle'; payload: unknown }[];
}
export interface CoDmFeedback { id: string; epoch: number; text: string }
export interface CoDmDurableState {
  version: 1;
  epoch: number;
  cursor: number;
  frozenContext: string;
  continuity?: string;
  activeBatchIds?: string[];
  lastFailure?: { kind: "worker"; pendingCount: number };
  messages: NormalizedMessage[];
  pending: CoDmExchange[];
  /** Keep delivery IDs across retries, including exchanges already consumed. */
  acceptedExchangeIds: string[];
  mailbox: CoDmFeedback[];
  deliveredFeedbackIds: string[];
}
export interface CoDmFence {
  epoch: number;
  isCurrent(): boolean;
  assertCurrent(): void;
}
export interface CoDmWorkerResult { continuity?: string; feedback?: string; messages?: NormalizedMessage[] }
export interface CoDmCoordinatorOptions {
  /** Must atomically replace the durable file; never log this private state. */
  persist(state: CoDmDurableState): Promise<void>;
  worker(batch: CoDmExchange[], state: CoDmDurableState, fence: CoDmFence): Promise<CoDmWorkerResult>;
  initialState?: CoDmDurableState;
  /** Observability only: fires after the durable cursor/context commit succeeds. */
  onFailed?(state: CoDmDurableState): void;
  onCommitted?(state: CoDmDurableState, batch: CoDmExchange[]): void;
}

const copy = <T>(value: T): T => structuredClone(value);

/** One continuing lane; only complete foreground exchanges can wake it. */
export class CoDmCoordinator {
  private state: CoDmDurableState;
  private mutations: Promise<void> = Promise.resolve();
  private running: Promise<void> | undefined;
  private failure: unknown;
  private stopped = false;
  private liveEpoch: number;
  private progressWaiters = new Set<() => void>();
  private notifyProgress(): void { for (const wake of this.progressWaiters) wake(); this.progressWaiters.clear(); }
  private activeWorkers = new Set<Promise<void>>();

  constructor(private readonly options: CoDmCoordinatorOptions) {
    this.state = copy(options.initialState ?? {
      version: 1, epoch: 1, cursor: 0, frozenContext: '', messages: [], pending: [],
      acceptedExchangeIds: [], mailbox: [], deliveredFeedbackIds: [],
    });
    this.liveEpoch = this.state.epoch;
  }

  getStatus(): { failed: boolean; stopped: boolean; active: boolean; pending: number } { return { failed: Boolean(this.failure), stopped: this.stopped, active: Boolean(this.running), pending: this.state.pending.length }; }
  getState(): CoDmDurableState { return copy(this.state); }

  private mutate(change: (next: CoDmDurableState) => void): Promise<void> {
    const scheduledEpoch = this.liveEpoch;
    const task = this.mutations.then(async () => {
      const next = copy(this.state);
      change(next);
      await this.options.persist(copy(next));
      this.state = next;
    });
    this.mutations = task.catch(error => {
      if (this.liveEpoch === scheduledEpoch) this.failure = error;
    });
    return task;
  }

  async initialize(prefix: string): Promise<void> {
    await this.mutate(next => {
      if (!next.frozenContext) next.frozenContext = prefix;
    });
    this.wake();
  }

  async enqueue(exchange: CoDmExchange): Promise<void> {
    await this.mutate(next => {
      if (next.acceptedExchangeIds.includes(exchange.id)) return;
      next.acceptedExchangeIds.push(exchange.id);
      next.pending.push(copy(exchange));
    });
    this.wake();
  }

  private wake(): void {
    if (this.stopped || this.running || !this.state.pending.length || this.failure) return;
    const run = this.consume();
    this.running = run;
    this.activeWorkers.add(run);
    void run.catch(error => {
      if (this.running === run) this.failure = error;
      this.notifyProgress();
      if (!this.stopped && this.running === run) {
        void this.mutate(next => { next.lastFailure = { kind: "worker", pendingCount: next.pending.length }; }).then(() => this.options.onFailed?.(this.getState())).catch(() => undefined);
      }
    }).finally(() => {
      this.activeWorkers.delete(run);
      if (this.running === run) this.running = undefined;
      this.wake();
    });
  }

  private async consume(): Promise<void> {
    while (true) {
      await this.mutations;
      const snapshot = this.getState();
      if (!snapshot.pending.length) return;
      const epoch = snapshot.epoch;
      const fence: CoDmFence = {
        epoch,
        isCurrent: () => this.liveEpoch === epoch,
        assertCurrent: () => {
          if (this.liveEpoch !== epoch) throw new Error('Abandoned co-DM epoch');
        },
      };
      // Freeze accepted batch membership before provider effects. Subsequent
      // observations cannot change retry identity after interruption/restart.
      const ids = snapshot.activeBatchIds ?? snapshot.pending.map(exchange => exchange.id);
      if (!snapshot.activeBatchIds) await this.mutate(next => { next.activeBatchIds = ids; });
      const batch = copy(snapshot.pending.filter(exchange => ids.includes(exchange.id)));
      const result = await this.options.worker(batch, snapshot, fence);
      if (!fence.isCurrent()) return;
      await this.mutate(next => {
        if (next.epoch !== epoch || this.liveEpoch !== epoch) return;
        const ids = new Set(batch.map(exchange => exchange.id));
        next.pending = next.pending.filter(exchange => !ids.has(exchange.id));
        next.lastFailure = undefined;
        next.cursor += batch.length;
        next.activeBatchIds = undefined;
        if (result.continuity !== undefined) next.continuity = result.continuity;
        if (result.messages) next.messages = copy(result.messages);
        if (result.feedback) next.mailbox.push({
          id: `${epoch}:${next.cursor}`, epoch, text: result.feedback,
        });
      });
      this.notifyProgress();
      if (fence.isCurrent()) this.options.onCommitted?.(this.getState(), copy(batch));
    }
  }

  /** Finite dependency barrier: subsequent enqueues cannot extend this wait. */
  async through(ids?: readonly string[]): Promise<void> {
    const acceptedMutations = this.mutations;
    await acceptedMutations;
    const capturedIds = ids ?? this.state.pending.map(item => item.id);
    this.wake();
    while (this.state.pending.some(item => capturedIds.includes(item.id))) {
      if (this.stopped) throw new Error("Co-DM lane stopped with recoverable pending work");
      if (this.failure) throw this.failure;
      const active = this.running;
      if (!active) { this.wake(); await Promise.resolve(); continue; }
      await new Promise<void>(resolve => { this.progressWaiters.add(resolve); });
    }
    if (this.failure) throw this.failure;
  }

  async drain(): Promise<void> {
    await this.mutations;
    this.wake();
    while (this.running) {
      await this.running;
      // The runner's finally handler may not yet have cleared its reference.
      await Promise.resolve();
    }
    if (this.failure) throw this.failure;
  }

  /** Lifecycle quiescence also awaits fenced requests from abandoned history. */
  async settleAll(): Promise<void> {
    let failure: unknown;
    try { await this.drain(); } catch (error) { failure = error; }
    while (this.activeWorkers.size) await Promise.allSettled([...this.activeWorkers]);
    await this.mutations;
    if (failure || this.failure) throw failure ?? this.failure;
  }

  /** Normal shutdown fences effects but preserves accepted work for restart. */
  async stop(): Promise<void> {
    this.stopped = true;
    ++this.liveEpoch;
    this.notifyProgress();
    await Promise.allSettled([...this.activeWorkers]);
    await this.mutations;
  }

  /** Retry preserved pending work after a provider/persistence failure. */
  retry(): void { this.failure = undefined; this.wake(); }

  /** Pending private context survives failed turns and interrupted injection. */
  peekFeedback(): CoDmFeedback[] {
    return copy(this.state.mailbox.filter(item => item.epoch === this.liveEpoch
      && !this.state.deliveredFeedbackIds.includes(item.id)));
  }

  /** Ack after the successful DM exchange that consumed volatile feedback is durable. */
  async acknowledgeFeedback(ids: string[]): Promise<void> {
    await this.mutate(next => {
      const delivered = next.mailbox.filter(item => item.epoch === this.liveEpoch && ids.includes(item.id));
      next.deliveredFeedbackIds.push(...delivered.filter(item => !next.deliveredFeedbackIds.includes(item.id))
        .map(item => item.id));
      next.mailbox = next.mailbox.filter(item => !delivered.some(ack => ack.id === item.id));
    });
  }

  async resetScene(prefix: string): Promise<void> {
    await this.drain();
    await this.mutate(next => {
      next.frozenContext = prefix;
      // Keep unresolved directives across scene cuts; valid ledgers cover the
      // old messages, otherwise retain the complete un-compacted history.
      // Worker compaction alone clears messages once its ledger covers them.
    });
  }

  /** Fence immediately, before async persistence or abandoned work completes. */
  async invalidate(prefix = ''): Promise<void> {
    const epoch = ++this.liveEpoch;
    this.notifyProgress();
    this.failure = undefined;
    // Abandoned provider requests may finish later; new history need not wait.
    this.running = undefined;
    await this.mutate(next => {
      next.epoch = epoch;
      next.cursor = 0;
      next.frozenContext = prefix;
      next.messages = [];
      next.continuity = undefined;
      next.pending = [];
      next.activeBatchIds = undefined;
      next.acceptedExchangeIds = [];
      next.mailbox = [];
      next.deliveredFeedbackIds = [];
    });
  }
}

/** Reject individual stale fields while preserving independent valid changes. */
export function selectCurrentCoDmFields<T>(
  proposals: Record<string, T>, expected: Record<string, number>, current: Record<string, number>,
): { accepted: Record<string, T>; rejected: string[] } {
  const accepted: Record<string, T> = {};
  const rejected: string[] = [];
  for (const [field, value] of Object.entries(proposals)) {
    if (expected[field] !== undefined && expected[field] === (current[field] ?? 0)) accepted[field] = value;
    else rejected.push(field);
  }
  return { accepted, rejected };
}
