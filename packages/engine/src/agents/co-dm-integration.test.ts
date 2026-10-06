import { GameEngine } from './game-engine.js';
import { SceneManager } from './scene-manager.js';
import type { FileIO, SceneState } from './scene-manager.js';
import type { GameState } from './game-state.js';
import type { EngineCallbacks } from './game-engine.js';
import type { ChatParams, ChatResult, LLMProvider } from '../providers/types.js';
import type { CoDmCoordinator, CoDmExchange } from './co-dm-coordinator.js';
import { createClocksState } from '../tools/clocks/index.js';
import { createCombatState, createDefaultConfig } from '../tools/combat/index.js';
import { createDecksState } from '../tools/cards/index.js';
import { createObjectivesState } from '../tools/objectives/index.js';
import { resetPromptCache } from '../prompts/load-prompt.js';
import { loadModelConfig } from '../config/models.js';
import { norm } from '../utils/paths.js';
import { StatePersister } from '../context/state-persistence.js';
import * as campaignSearch from './subagents/search-campaign.js';
import { getCampaignKnowledge } from '../knowledge/store.js';
import { EntityStore } from '../entities/store.js';

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 };
const response = (text: string): ChatResult => ({ text, toolCalls: [], usage, stopReason: 'end', assistantContent: [{ type: 'text', text }] });
function tool(name: string, input: Record<string, unknown>): ChatResult {
  return { text: '', usage, stopReason: 'tool_use', toolCalls: [{ id: 'call-one', name, input }],
    assistantContent: [{ type: 'tool_use', id: 'call-one', name, input }] };
}
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function provider(run: (params: ChatParams) => Promise<ChatResult>, wholeDelta = false): LLMProvider {
  return {
    providerId: 'co-dm-integration-script', getCapabilities: () => ({ imageGeneration: false }),
    chat: vi.fn(run), stream: vi.fn(async (params, onDelta) => {
      const result = await run(params);
      if (wholeDelta) onDelta(result.text);
      else for (const char of result.text.split('')) onDelta(char);
      return result;
    }), healthCheck: async () => ({ status: 'valid', message: 'offline script' }),
  };
}

function fixture(dmResponses: ChatResult[], coDm: LLMProvider, files: Record<string, string> = {}, wholeDelta = false) {
  const writes: string[] = [];
  const fileIO: FileIO = {
    readFile: async path => files[norm(path)] ?? '',
    writeFile: async (path, value) => { files[norm(path)] = value; writes.push(norm(path)); },
    appendFile: async (path, value) => { files[norm(path)] = (files[norm(path)] ?? '') + value; },
    exists: async path => norm(path) in files, mkdir: async () => {}, listDir: async () => [],
  };
  const state: GameState = {
    maps: {}, clocks: createClocksState(), combat: createCombatState(), combatConfig: createDefaultConfig(),
    decks: createDecksState(), objectives: createObjectivesState(), campaignRoot: '/co-dm-integration', homeDir: '/test-home',
    activePlayerIndex: 0, displayResources: {}, resourceValues: {},
    config: {
      name: 'Isolated experiment', dm_personality: { name: 'plain', prompt_fragment: 'Describe the world.' },
      players: [{ name: 'Player', character: 'Aldric', type: 'human' }], combat: createDefaultConfig(),
      context: { retention_exchanges: 5, max_conversation_tokens: 8000, tool_result_stub_after: 2 },
      recovery: { auto_commit_interval: 300, max_commits: 100, enable_git: false },
      choices: { campaign_default: 'never', player_overrides: {} }, image_generation: 'off',
    },
  };
  const savedResources = files["/co-dm-integration/state/resources.json"];
  if (savedResources) { const loaded = JSON.parse(savedResources) as { resourceValues: GameState["resourceValues"]; displayResources: GameState["displayResources"] }; state.resourceValues = loaded.resourceValues; state.displayResources = loaded.displayResources; }
  const scene: SceneState = { sceneNumber: 1, slug: 'test', transcript: [], precis: '', openThreads: '', npcIntents: '',
    playerReads: [], sessionNumber: 1, sessionRecapPending: false };
  const publicDeltas: string[] = [];
  const publicComplete: string[] = [];
  const errors: Error[] = [];
  const tui: unknown[] = [];
  const callbacks: EngineCallbacks = {
    onNarrativeDelta: text => { publicDeltas.push(text); }, onNarrativeComplete: text => { publicComplete.push(text); },
    onStateChange: () => {}, onTuiCommand: command => { tui.push(command); }, onToolStart: () => {}, onToolEnd: () => {},
    onExchangeDropped: () => {}, onUsageUpdate: () => {}, onError: error => { errors.push(error); },
    onTurnStart: () => {}, onTurnEnd: () => {},
  };
  let index = 0;
  const dm = provider(async () => {
    const result = dmResponses[index++];
    if (!result) throw new Error('Unexpected foreground continuation');
    return result;
  }, wholeDelta);
  const engine = new GameEngine({ provider: dm, gameState: state, scene, sessionState: {}, fileIO, callbacks,
    tierProviders: { large: { provider: dm, model: 'gpt-6.1-sol' }, medium: { provider: dm, model: 'gpt-6-luna' }, small: { provider: dm, model: 'gpt-6-luna' } },
    coDm: { provider: coDm, model: 'gpt-6.1-sol' },
  });
  return { engine, dm, files, fileIO, state, scene, writes, publicDeltas, publicComplete, errors, tui, callbacks };
}

function latestBatch(params: ChatParams): CoDmExchange[] {
  const last = params.messages.at(-1);
  if (!last || typeof last.content !== 'string') throw new Error('Expected serialized co-DM batch');
  return JSON.parse(last.content).completeExchanges as CoDmExchange[];
}

beforeEach(() => { resetPromptCache(); loadModelConfig({ reset: true }); });
afterEach(() => { vi.restoreAllMocks(); });

describe('real GameEngine continuing co-DM integration', () => {
  it('rechecks resource publication after persistence while preserving independent fields', async () => {
    const coDmRelease = signal(); const foregroundStarted = signal(); const foregroundRelease = signal();
    const writeStarted = signal(); const writeRelease = signal(); const foregroundPublished = signal();
    let coDmCalls = 0;
    const coDm = provider(async () => {
      if (coDmCalls++ === 0) {
        await coDmRelease.promise;
        return tool('set_resource_values', { character: 'Aldric', values: { Coin: '3', 'HOLDING BREATH': 'yes' } });
      }
      return response('');
    });
    const f = fixture([response('First.'), tool('set_resource_values', { character: 'Aldric', values: { Coin: '9' } }), response('Second.')], coDm);
    const originalStream = f.dm.stream;
    let foregroundCalls = 0;
    f.dm.stream = async (params, onDelta) => {
      if (foregroundCalls++ === 1) { foregroundStarted.resolve(); await foregroundRelease.promise; }
      if (!originalStream) throw new Error('scripted stream unavailable');
      return originalStream(params, onDelta);
    };
    const originalWrite = f.fileIO.writeFile;
    let heldWrite = false;
    f.fileIO.writeFile = async (path, content) => {
      if (!heldWrite && norm(path).endsWith('/state/resources.json')) { heldWrite = true; writeStarted.resolve(); await writeRelease.promise; }
      await originalWrite(path, content);
    };
    const originalPush = f.tui.push.bind(f.tui);
    f.tui.push = (...commands: unknown[]) => {
      const count = originalPush(...commands);
      if (commands.some(command => (command as { values?: { Coin?: string } }).values?.Coin === '9')) foregroundPublished.resolve();
      return count;
    };
    await f.engine.processInput('Aldric', 'First action.');
    const foreground = f.engine.processInput('Aldric', 'Second action.');
    await foregroundStarted.promise;
    coDmRelease.resolve();
    await writeStarted.promise;
    foregroundRelease.resolve();
    await foregroundPublished.promise;
    writeRelease.resolve();
    await foreground;
    await f.engine.settleCoDm();
    const commands = f.tui as { type: string; values?: Record<string, string> }[];
    const foregroundIndex = commands.findIndex(command => command.values?.Coin === '9');
    expect(commands.slice(foregroundIndex + 1).some(command => command.values?.Coin === '3')).toBe(false);
    expect(commands.slice(foregroundIndex + 1).some(command => command.values?.['HOLDING BREATH'] === 'yes')).toBe(true);
    expect(f.state.resourceValues.Aldric).toEqual({ Coin: '9', 'HOLDING BREATH': 'yes' });
    expect((await new StatePersister(f.state.campaignRoot, f.fileIO).loadAll()).resources?.resourceValues.Aldric).toEqual(f.state.resourceValues.Aldric);
  });

  it('waits for prior co-DM canonical commits before search_campaign reads', async () => {
    const started = signal(); const release = signal();
    let calls = 0;
    const coDm = provider(async () => {
      if (calls++ === 0) { started.resolve(); await release.promise; return tool('remember', { operations: [{ op: 'upsert', collection: 'Lore', name: 'Fresh evidence', body: 'Maintenance committed.' }] }); }
      return response('');
    });
    const f = fixture([response('The evidence is established.')], coDm);
    const search = vi.spyOn(campaignSearch, 'searchCampaign').mockImplementation(async () => {
      const store = await getCampaignKnowledge(f.state.campaignRoot, f.fileIO);
      return { text: JSON.stringify(await store.read('Fresh evidence')), usage };
    });
    await f.engine.processInput('Aldric', 'Inspect.');
    await started.promise;
    const read = f.engine.handleAsyncTool('search_campaign', { query: 'Fresh evidence' });
    expect(search).not.toHaveBeenCalled();
    release.resolve();
    const result = await read;
    expect(search).toHaveBeenCalledTimes(1);
    expect(result?.content).toContain('Maintenance committed.');
    expect(f.engine.getCoDmState()?.pending).toEqual([]);
  });

  it('rejects an older asynchronous theme after newer foreground styling', async () => {
    const stylistStarted = signal(); const stylistRelease = signal();
    let calls = 0;
    const coDm = provider(async () => calls++ === 0 ? tool('style_scene', { description: 'Older atmosphere', save_to_location: true, location: 'Room' }) : response(''));
    const f = fixture([response('The room is quiet.')], coDm);
    const store = await getCampaignKnowledge(f.state.campaignRoot, f.fileIO);
    await store.mutate([{ op: 'upsert', collection: 'Locations', name: 'Room', fields: { type: 'location', key_color: '#333333' } }]);
    f.dm.chat = vi.fn(async () => { stylistStarted.resolve(); await stylistRelease.promise; return response('{"theme":"clean","key_color":"#111111"}'); });
    await f.engine.processInput('Aldric', 'Wait.');
    await stylistStarted.promise;
    const newer = await f.engine.handleAsyncTool('style_scene', { key_color: '#999999', save_to_location: true, location: 'Room' });
    expect(newer?._tui).toMatchObject({ type: 'set_theme', key_color: '#999999' });
    if (newer?._tui) f.engine.dispatchImmediateTuiCommand(newer._tui as import('./agent-loop.js').TuiCommand);
    stylistRelease.resolve();
    await f.engine.settleCoDm();
    expect((f.tui as { key_color?: string }[]).some(command => command.key_color === '#111111')).toBe(false);
    expect((await store.read('Room')).fields.key_color).toBe('#999999');
    expect((await new StatePersister(f.state.campaignRoot, f.fileIO).loadAll()).ui?.keyColor).toBe('#999999');
    const continuing = JSON.stringify(f.engine.getCoDmState()?.messages);
    expect(continuing).toContain('Foreground presentation superseded this asynchronous update');
  });

  it('rechecks location theme intent after its existence read before canonical mutation', async () => {
    const readStarted = signal(); const readRelease = signal();
    let calls = 0;
    const coDm = provider(async () => calls++ === 0 ? tool('style_scene', { key_color: '#111111', save_to_location: true, location: 'Room' }) : response(''));
    const f = fixture([response('The room is quiet.')], coDm);
    const store = await getCampaignKnowledge(f.state.campaignRoot, f.fileIO);
    await store.mutate([{ op: 'upsert', collection: 'Locations', name: 'Room', fields: { type: 'location', key_color: '#333333' } }]);
    const originalExists = EntityStore.prototype.exists;
    let heldRead = false;
    vi.spyOn(EntityStore.prototype, 'exists').mockImplementation(async function (type, id) {
      const result = await originalExists.call(this, type, id);
      if (!heldRead && type === 'location' && id === 'Room') { heldRead = true; readStarted.resolve(); await readRelease.promise; }
      return result;
    });
    await f.engine.processInput('Aldric', 'Wait.');
    await readStarted.promise;
    const newer = await f.engine.handleAsyncTool('style_scene', { key_color: '#999999', save_to_location: true, location: 'Room' });
    if (newer?._tui) f.engine.dispatchImmediateTuiCommand(newer._tui as import('./agent-loop.js').TuiCommand);
    readRelease.resolve();
    await f.engine.settleCoDm();
    expect((await store.read('Room')).fields.key_color).toBe('#999999');
    expect((await new StatePersister(f.state.campaignRoot, f.fileIO).loadAll()).ui?.keyColor).toBe('#999999');
    expect((f.tui as { key_color?: string }[]).some(command => command.key_color === '#111111')).toBe(false);
    expect(JSON.stringify(f.engine.getCoDmState()?.messages)).toContain('Foreground presentation superseded this asynchronous update');
  });

  it.each([false, true])('resets continuing scene memory durably after session-end advancement (recap fails: %s)', async recapFails => {
    const coDm = provider(async () => response(''));
    const f = fixture([response('Old scene.<co_dm>old-scene hidden intent</co_dm>')], coDm);
    await f.engine.processInput('Aldric', 'Old action.');
    await f.engine.settleCoDm();
    const originalPrefix = f.engine.getCoDmState()?.frozenContext;
    expect(JSON.stringify(f.engine.getCoDmState()?.messages)).toContain('old-scene hidden intent');
    vi.spyOn(SceneManager.prototype, 'sessionEnd').mockImplementation(async function () {
      this.getScene().sceneNumber++;
      this.getScene().slug = '';
      this.getScene().transcript = [];
      this.getScene().precis = 'A fresh successor scene anchor';
      this.getScene().knowledgeSnapshot = undefined;
      this.getScene().knowledgeSnapshotScene = undefined;
      f.engine.seedConversation([]);
      if (recapFails) throw new Error('recap directory unavailable after scene advance');
      return { campaignLogEntry: 'Session closed.', changelogEntries: [], alarmsFired: [], usage };
    });
    await f.engine.endSession('Session curtain');
    expect(f.engine.getCoDmState()?.messages.length).toBeGreaterThan(0);
    expect(f.engine.getCoDmState()?.frozenContext).not.toBe(originalPrefix);
    expect(f.engine.getCoDmState()?.pending).toEqual([]);
    expect(f.errors).toHaveLength(recapFails ? 1 : 0);
    let request: ChatParams | undefined;
    const reloadedCoDm = provider(async params => { request = { ...params, messages: structuredClone(params.messages) }; return response(''); });
    const restored = fixture([response('New scene.')], reloadedCoDm, f.files);
    Object.assign(restored.scene, f.scene);
    await restored.engine.processInput('Aldric', 'A new action.');
    await restored.engine.settleCoDm();
    expect(request?.messages).toHaveLength(3);
    expect(JSON.stringify(request?.messages)).toContain('old-scene hidden intent');
    expect(latestBatch(request as ChatParams)[0]?.sceneNumber).toBe(2);
  });

  it.each([false, true])('streams private framing causally and persists public text without another DM request (whole delta: %s)', async wholeDelta => {
    const batches: CoDmExchange[][] = [];
    const coDm = provider(async params => { batches.push(latestBatch(params)); return response(''); });
    const f = fixture([response('Before 🦉.<co_dm>SECRET network</co_dm> After.'), response('The visitor waits.')], coDm, {}, wholeDelta);
    await f.engine.processInput('Aldric', 'Open the door.');
    await f.engine.settleDeferredWork();
    expect(f.errors).toEqual([]);
    expect(f.publicDeltas.join('')).toBe('Before 🦉. After.');
    expect(f.publicComplete).toEqual(['Before 🦉. After.']);
    expect(f.dm.stream).toHaveBeenCalledTimes(1);
    expect(f.dm.chat).not.toHaveBeenCalled();
    expect(batches).toHaveLength(1);
    expect(batches[0]?.[0]?.events[0]).toEqual({ kind: 'player', payload: { characterName: 'Aldric', text: 'Open the door.' } });
    expect(batches[0]?.[0]?.events.filter(event => event.kind === 'annotation')).toEqual([{ kind: 'annotation', payload: 'SECRET network' }]);
    expect(batches[0]?.[0]?.events.slice(1)).toEqual([
      { kind: 'narration', payload: 'Before 🦉.' }, { kind: 'annotation', payload: 'SECRET network' },
      { kind: 'narration', payload: ' After.' },
    ]);
    // The DM's canonical conversation is private (like tool-note context).
    // Public transcript/display log and player callbacks have the stripping boundary.
    const publicFiles = Object.entries(f.files).filter(([path]) => path.endsWith('/state/display-log.md') || path.endsWith('/transcript.md'));
    expect(publicFiles.length).toBeGreaterThan(0);
    for (const [path, content] of publicFiles) {
      expect(content, path).not.toContain('SECRET network');
      expect(content, path).not.toContain('<co_dm>');
    }
    expect(f.files['/co-dm-integration/state/conversation.json']).toContain('<co_dm>SECRET network</co_dm>');
    await f.engine.processInput('Aldric', 'Speak to the visitor.');
    await f.engine.settleDeferredWork();
    const nextRequest = vi.mocked(f.dm.stream).mock.calls[1]?.[0];
    expect(JSON.stringify(nextRequest?.messages)).toContain('<co_dm>SECRET network</co_dm>');
    expect(f.publicDeltas.join('')).not.toContain('SECRET network');
    expect(f.publicComplete.join('')).not.toContain('SECRET network');
    expect(f.scene.transcript.map(entry => entry.text).join('')).not.toContain('SECRET network');
    expect(f.files['/co-dm-integration/state/display-log.md']).not.toContain('SECRET network');
  });

  it('observes immediate committed private notes in tool order before the closing narration', async () => {
    const batches: CoDmExchange[][] = [];
    const coDm = provider(async params => { batches.push(latestBatch(params)); return response(''); });
    const f = fixture([tool('dm_notes', { action: 'write', notes: 'SECRET: visitor is Bob.' }), response('The visitor arrives.')], coDm);
    await f.engine.processInput('Aldric', 'Wait.');
    await f.engine.settleDeferredWork();
    expect(f.errors).toEqual([]);
    const events = batches[0]?.[0]?.events ?? [];
    expect(events[0]?.kind).toBe('player');
    const noteIndex = events.findIndex(event => event.kind === 'tool' && JSON.stringify(event.payload).includes('SECRET: visitor is Bob.'));
    expect(noteIndex).toBeGreaterThan(0);
    expect(events.findIndex(event => event.kind === 'narration')).toBeGreaterThan(noteIndex);
    expect(f.publicComplete.join('')).not.toContain('SECRET');
    expect(f.scene.transcript.map(entry => entry.text).join('')).not.toContain('SECRET');
  });

  it('keeps feedback pending after failed DM context persistence and acknowledges after a durable retry', async () => {
    let runs = 0;
    const coDm = provider(async () => response(runs++ === 0 ? 'PRIVATE correction' : ''));
    const f = fixture([response('First.'), response('Second.'), response('Third.')], coDm);
    await f.engine.processInput('Aldric', 'First action.');
    await f.engine.settleCoDm();
    expect(f.engine.getCoDmState()?.mailbox.map(item => item.text)).toEqual(['PRIVATE correction']);
    const originalWrite = f.fileIO.writeFile;
    f.fileIO.writeFile = async (path, content) => {
      if (norm(path).endsWith('/state/conversation.json') && content.includes('Second.')) throw new Error('DM context disk failure');
      await originalWrite(path, content);
    };
    await f.engine.processInput('Aldric', 'Second action.');
    await f.engine.settleCoDm();
    expect(f.errors.some(error => error.message.includes('DM context disk failure'))).toBe(true);
    expect(f.engine.getCoDmState()?.mailbox.map(item => item.text)).toEqual(['PRIVATE correction']);
    f.fileIO.writeFile = originalWrite;
    await f.engine.processInput('Aldric', 'Third action.');
    await f.engine.settleDeferredWork();
    expect(f.engine.getCoDmState()?.mailbox).toEqual([]);
    expect(f.files['/co-dm-integration/state/conversation.json']).toContain('Third.');
    expect(f.files['/co-dm-integration/state/conversation.json']).not.toContain('PRIVATE correction');
    const requests = vi.mocked(f.dm.stream).mock.calls;
    expect(JSON.stringify(requests[1]?.[0].messages)).toContain('PRIVATE correction');
    expect(JSON.stringify(requests[2]?.[0].messages)).toContain('PRIVATE correction');
    expect(f.publicDeltas.join('')).not.toContain('PRIVATE correction');
    expect(f.scene.transcript.map(entry => entry.text).join('')).not.toContain('PRIVATE correction');
  });

  it('allows the next ordinary turn while maintenance is busy and blocks scene refresh until closing work commits', async () => {
    const started = signal(); const release = signal();
    let calls = 0;
    const coDm = provider(async () => { if (calls++ === 0) { started.resolve(); await release.promise; } return response(''); });
    const transition = vi.spyOn(SceneManager.prototype, 'sceneTransition').mockImplementation(async function () {
      this.getScene().sceneNumber++;
      return { campaignLogEntry: '', changelogEntries: [], alarmsFired: [], usage };
    });
    const f = fixture([response('First.'), response('Second.')], coDm);
    await f.engine.processInput('Aldric', 'First action.');
    await started.promise;
    expect(f.engine.getState()).toBe('waiting_input');
    await f.engine.processInput('Aldric', 'Second action.');
    expect(f.engine.getState()).toBe('waiting_input');
    expect(f.engine.getCoDmState()?.pending).toHaveLength(2);
    const closing = f.engine.transitionScene('Next place');
    expect(f.engine.getState()).toBe('scene_transition');
    expect(transition).not.toHaveBeenCalled();
    release.resolve();
    await closing;
    expect(transition).toHaveBeenCalledTimes(1);
    expect(f.engine.getCoDmState()).toMatchObject({ cursor: 2, pending: [] });
  });

  it('rejects an abandoned provider tool result before applying presentation or feedback', async () => {
    const started = signal(); const release = signal();
    let calls = 0;
    const coDm = provider(async params => {
      if (calls++ === 0) {
        started.resolve(); await release.promise;
        return tool('set_resource_values', { character: 'Aldric', values: { Scar: 'abandoned scar' } });
      }
      expect(JSON.stringify(params.messages)).toContain('Abandoned co-DM epoch');
      return response('abandoned feedback');
    });
    const f = fixture([response('First.')], coDm);
    await f.engine.processInput('Aldric', 'Act.');
    await started.promise;
    // Deterministic epoch seam: actual worker/tool handler remains unmocked.
    const coordinator = (f.engine as unknown as { coDm: CoDmCoordinator }).coDm;
    await coordinator.invalidate('restored snapshot');
    release.resolve();
    await coordinator.settleAll();
    expect(f.engine.getCoDmState()).toMatchObject({ epoch: 2, cursor: 0, mailbox: [], pending: [] });
    expect(JSON.stringify(f.tui)).not.toContain('abandoned scar');
    expect(f.state.resourceValues.Aldric).toBeUndefined();
  });

  it('consumes a new completed exchange after restoring the durable co-DM state', async () => {
    const batches: CoDmExchange[][] = [];
    const coDm = provider(async params => { batches.push(latestBatch(params)); return response(''); });
    const first = fixture([response('Before reload.')], coDm);
    await first.engine.processInput('Aldric', 'First action.');
    await first.engine.settleDeferredWork();
    const restored = fixture([response('After reload.')], coDm, structuredClone(first.files));
    await restored.engine.processInput('Aldric', 'New action after reload.');
    await restored.engine.settleDeferredWork();
    expect(restored.errors).toEqual([]);
    expect(batches).toHaveLength(2);
    expect(batches[1]?.[0]?.events[0]?.payload).toEqual({ characterName: 'Aldric', text: 'New action after reload.' });
    expect(batches[1]?.[0]?.id).not.toBe(batches[0]?.[0]?.id);
    expect(restored.engine.getCoDmState()?.cursor).toBe(2);
    const requests = vi.mocked(coDm.chat).mock.calls;
    expect(JSON.stringify(requests[1]?.[0].messages)).toContain('First action.');
    expect(JSON.stringify(requests[1]?.[0].messages)).toContain('New action after reload.');
  });

  it('persists resource maintenance that finishes after foreground turn persistence for a fresh loader', async () => {
    const started = signal(); const release = signal();
    let calls = 0;
    const coDm = provider(async () => {
      if (calls++ === 0) {
        started.resolve(); await release.promise;
        return tool('set_resource_values', { character: 'Aldric', values: { Coin: '3', 'HOLDING BREATH': 'yes' } });
      }
      return response('');
    });
    const f = fixture([response('The purchase is complete.')], coDm);
    await f.engine.processInput('Aldric', 'Buy it.');
    await started.promise;
    expect(f.engine.getState()).toBe('waiting_input');
    release.resolve();
    await f.engine.settleDeferredWork();
    expect(f.state.resourceValues.Aldric).toEqual({ Coin: '3', 'HOLDING BREATH': 'yes' });
    const loaded = await new StatePersister(f.state.campaignRoot, f.fileIO).loadAll();
    expect(loaded.resources?.resourceValues.Aldric).toEqual({ Coin: '3', 'HOLDING BREATH': 'yes' });
  });

  it.each(['public-snapshot', 'enqueue'])('recovers completed turn journal after %s failure, then consumes the next turn', async fault => {
    const batches: CoDmExchange[][] = [];
    const coDm = provider(async params => { batches.push(latestBatch(params)); return response(''); });
    const first = fixture([response('Recovered public.<co_dm>SECRET recovered bind</co_dm>')], coDm);
    const originalWrite = first.fileIO.writeFile;
    first.fileIO.writeFile = async (path, content) => {
      if (fault === 'public-snapshot' && norm(path).endsWith('/state/conversation.json') && content.includes('Recovered public.')) throw new Error('completion persistence interrupted');
      if (fault === 'enqueue' && norm(path).endsWith('/state/co-dm-experiment.json') && JSON.parse(content).pending.length) throw new Error('completion persistence interrupted');
      await originalWrite(path, content);
    };
    await first.engine.processInput('Aldric', 'Interrupted action.');
    expect(first.errors.some(error => error.message.includes('completion persistence interrupted'))).toBe(true);
    const journal = first.files['/co-dm-integration/state/co-dm-completion.json'];
    expect(journal).toContain('SECRET recovered bind');
    expect(batches).toEqual([]);
    const restored = fixture([response('Next public.')], coDm, structuredClone(first.files));
    await restored.engine.processInput('Aldric', 'Action after recovery.');
    await restored.engine.settleDeferredWork();
    expect(restored.errors).toEqual([]);
    const exchanges = batches.flat();
    expect(exchanges.map(item => item.events[0]?.payload)).toEqual([
      { characterName: 'Aldric', text: 'Interrupted action.' }, { characterName: 'Aldric', text: 'Action after recovery.' },
    ]);
    expect(new Set(exchanges.map(item => item.id)).size).toBe(2);
    expect(restored.engine.getCoDmState()?.cursor).toBe(2);
    expect(restored.files['/co-dm-integration/state/co-dm-completion.json']).toBe('null');
    const publicFiles = Object.entries(restored.files).filter(([path]) => path.endsWith('/state/display-log.md') || path.endsWith('/transcript.md'));
    expect(publicFiles.length).toBeGreaterThan(0);
    for (const [, content] of publicFiles) { expect(content).toContain('Recovered public.'); expect(content).not.toContain('SECRET recovered bind'); }
  });

  it('persists late modeline and theme updates while preserving restored unrelated presentation', async () => {
    const started = signal(); const release = signal(); let calls = 0;
    const coDm = provider(async () => {
      const turn = calls++;
      if (turn === 0) { started.resolve(); await release.promise; return tool('update_modeline', { character: 'Aldric', text: 'HOLDING BREATH' }); }
      if (turn === 1) return tool('style_scene', { key_color: '#8844aa', variant: 'combat' });
      return response('');
    });
    const files = { '/co-dm-integration/state/ui.json': JSON.stringify({ styleName: 'noir', variant: 'exploration', modelines: { Other: 'CUSTOM OTHER' }, keyColor: '#112233' }) };
    const f = fixture([response('A breath held.')], coDm, files);
    await f.engine.processInput('Aldric', 'Hold my breath.');
    await started.promise;
    release.resolve();
    await f.engine.settleDeferredWork();
    const loaded = await new StatePersister(f.state.campaignRoot, f.fileIO).loadAll();
    expect(loaded.ui).toMatchObject({ styleName: 'noir', variant: 'combat', keyColor: '#8844aa', modelines: { Other: 'CUSTOM OTHER', Aldric: 'HOLDING BREATH' } });
  });
});


describe('production co-DM recovery and activity', () => {
  it('replays persisted provider intent after cursor crash without regenerating or duplicating history', async () => {
    let calls = 0;
    const original = provider(async () => calls++ === 0 ? tool('remember', { operations: [{ op: 'upsert', collection: 'Lore', name: 'Receipt', history: 'Accepted event once' }] }) : response(JSON.stringify({ feedback: '', continuity: 'Receipt event committed' })));
    const first = fixture([response('An event occurs.')], original);
    const write = first.fileIO.writeFile;
    first.fileIO.writeFile = async (path, text) => {
      if (norm(path).endsWith('/state/co-dm-experiment.json') && JSON.parse(text).cursor === 1) throw new Error('cursor interrupted');
      await write(path, text);
    };
    await first.engine.processInput('Aldric', 'Act.');
    await expect(first.engine.settleCoDm()).rejects.toThrow('cursor interrupted');
    const canonical = await getCampaignKnowledge(first.state.campaignRoot, first.fileIO);
    expect((await canonical.read('Receipt')).logs).toHaveLength(1);
    const regenerated = provider(async () => tool('remember', { operations: [{ op: 'upsert', collection: 'Lore', name: 'Receipt', history: 'Rephrased duplicate event' }] }));
    const restored = fixture([], regenerated, structuredClone(first.files));
    restored.fileIO.campaignKnowledge = first.fileIO.campaignKnowledge;
    await restored.engine.settleCoDm();
    expect(regenerated.chat).not.toHaveBeenCalled();
    expect((await canonical.read('Receipt')).logs).toHaveLength(1);
    expect(restored.engine.getCoDmState()).toMatchObject({ cursor: 1, pending: [] });
  });
  it('emits shared tool activity with correlation and never ends a DM turn on maintenance completion', async () => {
    const started = signal(); const release = signal(); let calls = 0;
    const coDm = provider(async () => {
      if (calls++ === 0) { started.resolve(); await release.promise; return tool('update_modeline', { character: 'Aldric', text: 'LOOKING AROUND' }); }
      return response('');
    });
    const f = fixture([response('The scene opens.')], coDm);
    f.callbacks.onToolStart = vi.fn(); f.callbacks.onToolEnd = vi.fn(); f.callbacks.onTurnEnd = vi.fn();
    await f.engine.processInput('Aldric', 'Look.'); await started.promise;
    const completedTurns = vi.mocked(f.callbacks.onTurnEnd).mock.calls.length;
    release.resolve(); await f.engine.settleCoDm();
    const start = vi.mocked(f.callbacks.onToolStart).mock.calls.find(call => call[0] === 'update_modeline');
    const end = vi.mocked(f.callbacks.onToolEnd).mock.calls.find(call => call[0] === 'update_modeline');
    expect(start?.[1]).toMatchObject({ role: 'co-dm', callId: expect.any(String) });
    expect(end?.[2]).toEqual(start?.[1]);
    expect(vi.mocked(f.callbacks.onTurnEnd).mock.calls.length).toBe(completedTurns);
  });
});


describe('co-DM authoritative objective tracker', () => {
  it('lists current objectives then creates without self-invalidating its causal revision', async () => {
    let calls = 0;
    const coDm = provider(async () => {
      if (calls++ === 0) return tool('manage_objectives', { action: 'list' });
      if (calls === 2) return tool('manage_objectives', { action: 'create', title: 'Deliver the letter', description: 'Accepted delivery to the harbor.' });
      return response('');
    });
    const f = fixture([response('You accept the delivery.')], coDm);
    await f.engine.processInput('Aldric', 'I agree to deliver the letter');
    await f.engine.settleCoDm();
    expect(Object.values(f.state.objectives.objectives)).toEqual([expect.objectContaining({ title: 'Deliver the letter' })]);
  });

  it('rejects a delayed objective update after newer foreground intent', async () => {
    const started = signal(); const release = signal(); let calls = 0;
    const coDm = provider(async () => {
      if (calls++ === 0) { started.resolve(); await release.promise; return tool('manage_objectives', { action: 'update', id: 'obj-1', description: 'Stale maintenance description' }); }
      return response('');
    });
    const f = fixture([response('The party accepts the rescue.')], coDm);
    f.engine.getRegistry().dispatch(f.state, 'manage_objectives', { action: 'create', title: 'Rescue', description: 'Accepted rescue' });
    await f.engine.processInput('Aldric', 'Accept the rescue'); await started.promise;
    f.engine.getRegistry().dispatch(f.state, 'manage_objectives', { action: 'update', id: 'obj-1', description: 'Newer explicit DM correction' });
    release.resolve(); await f.engine.settleCoDm();
    expect(f.state.objectives.objectives['obj-1'].description).toBe('Newer explicit DM correction');
    expect(JSON.parse(f.files['/co-dm-integration/state/objectives.json']).objectives['obj-1'].description).toBe('Newer explicit DM correction');
  });
  it('replays an accepted provider response after cursor failure without duplicating an objective', async () => {
    let calls = 0;
    const coDm = provider(async () => calls++ === 0 ? tool('manage_objectives', { action: 'create', title: 'Accepted rescue', description: 'Player agreed to rescue the scout.' }) : response(''));
    const f = fixture([response('You agree to rescue the scout.')], coDm);
    const write = f.fileIO.writeFile; let failCursor = true;
    f.fileIO.writeFile = async (path, content) => {
      if (norm(path).endsWith('/state/co-dm-experiment.json') && JSON.parse(content).cursor > 0 && failCursor) { failCursor = false; throw new Error('cursor interrupted'); }
      await write(path, content);
    };
    await f.engine.processInput('Aldric', 'I agree');
    await expect(f.engine.settleCoDm()).rejects.toThrow('cursor interrupted');
    const accepted = JSON.parse(f.files['/co-dm-integration/state/objectives.json']);
    expect(Object.keys(accepted.objectives)).toHaveLength(1);
    expect(Object.keys(accepted.operationReceipts)).toHaveLength(1);
    const recovered = fixture([], provider(async () => response('')), { ...f.files });
    Object.assign(recovered.state.objectives, accepted);
    await recovered.engine.settleCoDm();
    expect(Object.keys(recovered.state.objectives.objectives)).toHaveLength(1);
    expect(recovered.state.objectives.next_id).toBe(2);
  });
});


describe('native in-band co-DM recovery', () => {
  it('recovers accepted tool prefix before provider continuation after an in-band crash', async () => {
    const original = provider(async params => {
      if (!params.dispatchTool) throw new Error('native dispatch missing');
      await params.dispatchTool({ id: 'native-one', name: 'remember', input: { operations: [{ op: 'upsert', collection: 'Lore', name: 'Native receipt', history: 'Accepted native event once' }] } });
      throw new Error('native provider interrupted after effect');
    });
    const first = fixture([response('A native event occurs.')], original);
    await first.engine.processInput('Aldric', 'Act.');
    await expect(first.engine.settleCoDm()).rejects.toThrow('native provider interrupted');
    const canonical = await getCampaignKnowledge(first.state.campaignRoot, first.fileIO);
    expect((await canonical.read('Native receipt')).logs).toHaveLength(1);
    let continuation: ChatParams | undefined;
    const resumed = provider(async params => { continuation = params; return response(JSON.stringify({ feedback: '', continuity: 'Native accepted event committed' })); });
    const restored = fixture([], resumed, structuredClone(first.files));
    restored.fileIO.campaignKnowledge = first.fileIO.campaignKnowledge;
    await restored.engine.settleCoDm();
    expect(JSON.stringify(continuation?.messages)).toContain('native-one');
    expect(JSON.stringify(continuation?.messages)).toContain('tool_result');
    expect((await canonical.read('Native receipt')).logs).toHaveLength(1);
    expect(restored.engine.getCoDmState()?.cursor).toBe(1);
  });
});


describe('production opening stochastic recovery', () => {
  it('resumes an interrupted opening after a durable deck draw without drawing or accepting it twice', async () => {
    const f = fixture([tool('deck', { deck: 'opening', operation: 'draw', count: 1 })], provider(async () => response('')));
    f.engine.getRegistry().dispatch(f.state, 'deck', { deck: 'opening', operation: 'create', template: 'standard52' });
    await f.engine.getPersister()?.flush();
    const opts = { skipTranscript: true, inputKind: 'bootstrap' as const, exchangeId: 'startup:crash:opening' };
    await f.engine.processInput('Aldric', '[Session begins]', opts);
    expect(f.errors).toHaveLength(1);
    expect(await f.engine.hasCompletedExchange(opts.exchangeId)).toBe(false);
    const acceptedDecks = JSON.parse(f.files['/co-dm-integration/state/decks.json']);
    expect(acceptedDecks.decks.opening.drawPile).toHaveLength(51);
    expect(Object.keys(acceptedDecks.operationReceipts)).toHaveLength(1);
    const recovered = fixture([response('The card lies on the table.')], provider(async () => response('')), { ...f.files });
    Object.assign(recovered.state.decks, acceptedDecks);
    await recovered.engine.processInput('Aldric', '[Session begins]', opts);
    await recovered.engine.settleCoDm();
    expect(recovered.errors).toEqual([]);
    expect(recovered.state.decks.decks.opening.drawPile).toHaveLength(51);
    expect(Object.keys(recovered.state.decks.operationReceipts ?? {})).toHaveLength(1);
    expect(await recovered.engine.hasCompletedExchange(opts.exchangeId)).toBe(true);
    expect(recovered.dm.stream).toHaveBeenCalledTimes(1);
  });
});


describe('canonical and reloaded causal protection', () => {
  it('rejects older canonical patches after a newer direct foreground correction', async () => {
    const started = signal(); const release = signal(); let calls = 0;
    const coDm = provider(async () => { if (calls++ === 0) { started.resolve(); await release.promise; return tool('remember', { operations: [{ op: 'patch', uid: 'Courier', fields: { location: 'old room' }, body: 'old biography' }] }); } return response(''); });
    const f = fixture([response('The courier waits.')], coDm);
    const canonical = await getCampaignKnowledge(f.state.campaignRoot, f.fileIO);
    await canonical.mutate([{ op: 'upsert', collection: 'Characters', name: 'Courier', fields: { location: 'initial room' }, body: 'initial biography' }]);
    await f.engine.processInput('Aldric', 'Observe.'); await started.promise;
    await f.engine.handleAsyncTool('remember', { operations: [{ op: 'patch', uid: 'Courier', fields: { location: 'new room' }, body: 'new corrected biography' }] });
    release.resolve(); await f.engine.settleCoDm();
    expect((await canonical.read('Courier')).fields.location).toBe('new room');
    expect((await canonical.read('Courier')).body).toBe('new corrected biography');
    expect(JSON.stringify(f.engine.getCoDmState()?.messages)).toContain('Canonical state changed');
  });
  it.each(['read', 'write'] as const)('does not adopt an unseen foreground revision after maintenance %s', async boundary => {
    let calls = 0;
    const coDm = provider(async () => {
      if (calls++ === 0) return boundary === 'read'
        ? tool('knowledge', { action: 'read', handle: 'Courier' })
        : tool('remember', { operations: [{ op: 'patch', uid: 'Courier', fields: { location: 'maintenance room' } }] });
      if (calls === 2) return tool('remember', { operations: [{ op: 'patch', uid: 'Courier', fields: { location: 'stale overwrite' } }] });
      return response('');
    });
    const f = fixture([response('The courier waits.')], coDm);
    const store = await getCampaignKnowledge(f.state.campaignRoot, f.fileIO);
    await store.mutate([{ op: 'upsert', collection: 'Characters', name: 'Courier', fields: { location: 'initial room' } }]);
    const mutate = store.mutate.bind(store);
    let interleaved = false;
    if (boundary === 'read') {
      const read = store.read.bind(store);
      vi.spyOn(store, 'read').mockImplementation(async (handle, options) => {
        const result = await read(handle, options);
        if (!interleaved && handle === 'Courier') { interleaved = true; await mutate([{ op: 'patch', uid: 'Courier', fields: { location: 'new foreground room' } }]); }
        return result;
      });
    } else vi.spyOn(store, 'mutate').mockImplementation(async (operations, options) => {
      const result = await mutate(operations, options);
      if (!interleaved && options?.source === 'co-dm') { interleaved = true; await mutate([{ op: 'patch', uid: 'Courier', fields: { location: 'new foreground room' } }]); }
      return result;
    });
    await f.engine.processInput('Aldric', 'Observe.'); await f.engine.settleCoDm();
    expect(interleaved).toBe(true);
    expect((await store.read('Courier')).fields.location).toBe('new foreground room');
  });
  it('restores causal presentation revisions before pending maintenance resumes', async () => {
    const oldExchange = { id: 'old', sceneNumber: 1, knowledgeRevision: 0, presentationRevisions: {}, events: [{ kind: 'narration', payload: 'Old purchase.' }] };
    const files = {
      '/co-dm-integration/state/resources.json': JSON.stringify({ displayResources: { Aldric: ['Coin'] }, resourceValues: { Aldric: { Coin: '9' } }, presentationRevisions: { 'set_resource_values:Aldric:Coin': 2 } }),
      '/co-dm-integration/state/co-dm-experiment.json': JSON.stringify({ version: 1, epoch: 1, cursor: 0, frozenContext: 'frozen', messages: [], pending: [oldExchange], acceptedExchangeIds: ['old'], mailbox: [], deliveredFeedbackIds: [] }),
    };
    let calls = 0;
    const coDm = provider(async () => calls++ === 0 ? tool('set_resource_values', { character: 'Aldric', values: { Coin: '3', 'HOLDING BREATH': 'yes' } }) : response(''));
    const f = fixture([], coDm, files); await f.engine.settleCoDm();
    expect(f.state.resourceValues.Aldric).toEqual({ Coin: '9', 'HOLDING BREATH': 'yes' });
    const persisted = await new StatePersister(f.state.campaignRoot, f.fileIO).loadAll();
    expect(persisted.resources?.resourceValues.Aldric).toEqual({ Coin: '9', 'HOLDING BREATH': 'yes' });
    expect(persisted.resources?.presentationRevisions?.['set_resource_values:Aldric:Coin']).toBe(2);
  });
});


it('uses the actual player_profile contract while deduplicating repeated accepted notes', async () => {
  let calls = 0;
  const coDm = provider(async () => calls++ < 2 ? tool('player_profile', { player: 'Player', action: 'append', section: 'Content Boundaries', text: 'Avoid spiders.' }) : response(''));
  const f = fixture([response('Boundaries are accepted.')], coDm);
  await f.engine.processInput('Aldric', 'No spiders please.'); await f.engine.settleCoDm();
  const profiles = Object.entries(f.files).filter(([path]) => path.includes('players/') && path.endsWith('.md'));
  expect(profiles).toHaveLength(1); expect(profiles[0][1].match(/Avoid spiders\./g)).toHaveLength(1);
  expect(JSON.stringify(f.engine.getCoDmState()?.messages)).not.toContain('unknown_field');
});


it('correlates two concurrent co-DM calls with the same tool name independently', async () => {
  let calls = 0;
  const coDm = provider(async () => {
    if (calls++ > 0) return response('');
    return { text: '', usage, stopReason: 'tool_use', toolCalls: [{ id: 'same-name-one', name: 'update_modeline', input: { character: 'Aldric', text: 'first' } }, { id: 'same-name-two', name: 'update_modeline', input: { character: 'Aldric', text: 'second' } }], assistantContent: [{ type: 'tool_use', id: 'same-name-one', name: 'update_modeline', input: { character: 'Aldric', text: 'first' } }, { type: 'tool_use', id: 'same-name-two', name: 'update_modeline', input: { character: 'Aldric', text: 'second' } }] };
  });
  const f = fixture([response('The scene opens.')], coDm); f.callbacks.onToolStart = vi.fn(); f.callbacks.onToolEnd = vi.fn();
  await f.engine.processInput('Aldric', 'Look.'); await f.engine.settleCoDm();
  const starts = vi.mocked(f.callbacks.onToolStart).mock.calls.filter(call => call[1]?.role === 'co-dm').map(call => call[1]?.callId);
  const ends = vi.mocked(f.callbacks.onToolEnd).mock.calls.filter(call => call[2]?.role === 'co-dm').map(call => call[2]?.callId);
  expect(new Set(starts).size).toBe(2); expect(ends.sort()).toEqual(starts.sort());
});
