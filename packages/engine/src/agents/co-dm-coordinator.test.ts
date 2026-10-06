import { CoDmCoordinator, selectCurrentCoDmFields } from './co-dm-coordinator.js';
import type { CoDmDurableState, CoDmExchange, CoDmFence } from './co-dm-coordinator.js';

function signal<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const exchange = (id: string): CoDmExchange => ({ id, sceneNumber: 1, events: [
  { kind: 'player', payload: `action ${id}` },
  { kind: 'tool', payload: { ok: false, attempted: 'spend', coin: 3 } },
  { kind: 'narration', payload: `prose ${id}` },
] });

describe('continuing co-DM coordinator', () => {
  it('serializes workers and batches every pending complete exchange in order', async () => {
    const started = signal();
    const release = signal();
    const batches: CoDmExchange[][] = [];
    const persisted: CoDmDurableState[] = [];
    const queue = new CoDmCoordinator({
      persist: async state => { persisted.push(state); },
      worker: async batch => {
        batches.push(batch);
        if (batches.length === 1) { started.resolve(); await release.promise; }
        return { feedback: 'useful correction' };
      },
    });
    await queue.initialize('frozen tree');
    await queue.enqueue(exchange('one'));
    await started.promise;
    await queue.enqueue(exchange('two'));
    await queue.enqueue(exchange('three'));
    await queue.enqueue(exchange('four'));
    expect(batches).toHaveLength(1);
    release.resolve();
    await queue.drain();
    expect(batches.map(batch => batch.map(item => item.id))).toEqual([['one'], ['two', 'three', 'four']]);
    expect(batches[1]!.flatMap(item => item.events)).toEqual([
      ...exchange('two').events, ...exchange('three').events, ...exchange('four').events,
    ]);
    expect(queue.getState()).toMatchObject({ cursor: 4, pending: [], frozenContext: 'frozen tree' });
    expect(persisted.at(-1)?.cursor).toBe(4);
    const feedback = queue.peekFeedback();
    expect(feedback.map(item => item.id)).toEqual(['1:1', '1:4']);
    await queue.acknowledgeFeedback(feedback.map(item => item.id));
    expect(queue.peekFeedback()).toEqual([]);
    await queue.drain();
    expect(batches).toHaveLength(2); // Writes and feedback delivery never self-wake.
  });

  it('replays durable pending exchanges once and preserves continuing context', async () => {
    const source = new CoDmCoordinator({ persist: async () => {}, worker: async () => ({}) });
    const state = source.getState();
    state.frozenContext = 'scene snapshot';
    state.messages = [{ role: 'user', content: [{ type: 'text', text: 'old exchange' }] }];
    state.pending = [exchange('pending')];
    state.acceptedExchangeIds = ['pending'];
    const worker = vi.fn(async (_batch, snapshot: CoDmDurableState) => ({ messages: snapshot.messages }));
    const restored = new CoDmCoordinator({ initialState: state, persist: async () => {}, worker });
    await restored.initialize('new snapshot should not replace frozen prefix');
    await restored.drain();
    await restored.enqueue(exchange('pending'));
    await restored.drain();
    expect(worker).toHaveBeenCalledTimes(1);
    expect(restored.getState()).toMatchObject({ cursor: 1, pending: [], frozenContext: 'scene snapshot', messages: state.messages });
  });

  it('retains pending input and cursor on failure, then retries explicitly', async () => {
    let fail = true;
    const queue = new CoDmCoordinator({ persist: async () => {}, worker: async () => {
      if (fail) throw new Error('provider interrupted');
      return {};
    } });
    await queue.enqueue(exchange('one'));
    await expect(queue.drain()).rejects.toThrow('provider interrupted');
    expect(queue.getState()).toMatchObject({ cursor: 0, pending: [exchange('one')] });
    fail = false;
    queue.retry();
    await queue.drain();
    expect(queue.getState()).toMatchObject({ cursor: 1, pending: [] });
  });

  it('fences abandoned results, feedback, and guarded effects while new history proceeds', async () => {
    const started = signal();
    const release = signal();
    const oldDone = signal();
    let oldFence!: CoDmFence;
    const applied: string[] = [];
    const queue = new CoDmCoordinator({ persist: async () => {}, worker: async (batch, _state, fence) => {
      if (batch[0]!.id === 'old') {
        oldFence = fence;
        started.resolve();
        await release.promise;
        expect(() => fence.assertCurrent()).toThrow('Abandoned');
        oldDone.resolve();
        return { feedback: 'abandoned scar' };
      }
      fence.assertCurrent();
      applied.push('new');
      return { feedback: 'new correction' };
    } });
    await queue.enqueue(exchange('old'));
    await started.promise;
    await queue.invalidate('restored tree');
    expect(oldFence.isCurrent()).toBe(false);
    await queue.enqueue(exchange('new'));
    await queue.drain();
    expect(applied).toEqual(['new']);
    release.resolve();
    await oldDone.promise;
    await queue.drain();
    expect(queue.getState()).toMatchObject({ epoch: 2, cursor: 1, frozenContext: 'restored tree' });
    expect(queue.peekFeedback().map(item => item.text)).toEqual(['new correction']);
  });

  it('holds scene closure at the completed exchange watermark before refreshing prefix', async () => {
    const started = signal();
    const release = signal();
    const queue = new CoDmCoordinator({ persist: async () => {}, worker: async () => {
      started.resolve(); await release.promise; return {};
    } });
    await queue.initialize('old tree');
    await queue.enqueue(exchange('closing'));
    await started.promise;
    const transition = queue.resetScene('new tree');
    expect(queue.getState().frozenContext).toBe('old tree');
    release.resolve();
    await transition;
    expect(queue.getState()).toMatchObject({ cursor: 1, pending: [], frozenContext: 'new tree', messages: [] });
  });

  it('holds rollback quiescence until an abandoned asynchronous worker has actually returned', async () => {
    const started = signal(); const release = signal();
    const queue = new CoDmCoordinator({ persist: async () => {}, worker: async (_batch, _state, fence) => {
      started.resolve(); await release.promise;
      fence.assertCurrent();
      return {};
    } });
    await queue.enqueue(exchange('old'));
    await started.promise;
    await queue.invalidate('restored snapshot');
    // Current epoch drain is intentionally independent of abandoned requests.
    await queue.drain();
    let settled = false;
    const barrier = queue.settleAll().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release.resolve();
    await barrier;
    expect(settled).toBe(true);
    expect(queue.getState()).toMatchObject({ epoch: 2, cursor: 0, pending: [] });
  });

  it('does not expose input to worker before durable enqueue succeeds', async () => {
    const worker = vi.fn(async () => ({}));
    const queue = new CoDmCoordinator({ persist: async () => { throw new Error('disk unavailable'); }, worker });
    await expect(queue.enqueue(exchange('one'))).rejects.toThrow('disk unavailable');
    await expect(queue.drain()).rejects.toThrow('disk unavailable');
    expect(worker).not.toHaveBeenCalled();
    expect(queue.getState().pending).toEqual([]);
  });

  it('replays a completed worker after cursor persistence fails, requiring idempotent external effects', async () => {
    let failCursorSave = true;
    const receipts = new Set<string>();
    let effects = 0;
    const worker = vi.fn(async (batch: CoDmExchange[]) => {
      // This represents the engine's atomic canonical mutation+operation ledger.
      // Coordinator cannot make an external mutation atomic with its own file.
      for (const item of batch) if (!receipts.has(item.id)) {
        receipts.add(item.id); effects++;
      }
      return {};
    });
    const queue = new CoDmCoordinator({ persist: async state => {
      if (state.cursor && failCursorSave) throw new Error('cursor save failed');
    }, worker });
    await queue.enqueue(exchange('one'));
    await expect(queue.drain()).rejects.toThrow('cursor save failed');
    expect(queue.getState()).toMatchObject({ cursor: 0, pending: [exchange('one')] });
    failCursorSave = false;
    queue.retry();
    await queue.drain();
    expect(worker).toHaveBeenCalledTimes(2);
    expect(effects).toBe(1);
    expect(queue.getState()).toMatchObject({ cursor: 1, pending: [] });
  });

  it('keeps engine-acknowledged feedback delivered across reload without waking the worker', async () => {
    const queue = new CoDmCoordinator({ persist: async () => {}, worker: async () => ({ feedback: 'correction' }) });
    await queue.enqueue(exchange('one'));
    await queue.drain();
    const state = queue.getState();
    const worker = vi.fn(async () => ({}));
    const restored = new CoDmCoordinator({ initialState: state, persist: async () => {}, worker });
    const feedback = restored.peekFeedback();
    expect(feedback.map(item => item.text)).toEqual(['correction']);
    // Simulate interruption while persisting the injected DM context: no ack.
    const interrupted = new CoDmCoordinator({ initialState: restored.getState(), persist: async () => {}, worker });
    expect(interrupted.peekFeedback()).toEqual(feedback);
    await restored.acknowledgeFeedback(feedback.map(item => item.id));
    const acknowledged = new CoDmCoordinator({ initialState: restored.getState(), persist: async () => {}, worker });
    expect(acknowledged.peekFeedback()).toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });

  it('rejects stale display fields without discarding unrelated current work', () => {
    expect(selectCurrentCoDmFields(
      { modeline: 'HOLDING BREATH', archive: 'label unchanged', unknown: 'unsafe' },
      { modeline: 1, archive: 1 }, { modeline: 2, archive: 1 },
    )).toEqual({ accepted: { archive: 'label unchanged' }, rejected: ['modeline', 'unknown'] });
  });
});
