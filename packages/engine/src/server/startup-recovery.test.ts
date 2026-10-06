import { SessionManager } from './session-manager.js';
import type { GameEngine } from '../agents/game-engine.js';
import type { FileIO } from '../agents/scene-manager.js';
import type { GameState } from '@machine-violet/shared/types/engine.js';
import type { CampaignConfig } from '@machine-violet/shared/types/config.js';
import type { EntityTree } from '@machine-violet/shared/types/entities.js';
import { writeStartup, readStartup, type StartupEnvelope } from '../agents/startup.js';
vi.mock('../tools/filesystem/entity-tree.js', () => ({ renderEntityTree: () => '', buildEntityTree: vi.fn() }));

function fixture(complete: boolean) {
  const files: Record<string, string> = {};
  const io = { readFile: async (path: string) => { if (!(path in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files[path]; }, writeFile: async (path: string, text: string) => { files[path] = text; } } as unknown as FileIO;
  const config = { name: 'Test', players: [{ name: 'Player', character: 'Ada', type: 'human' }] } as CampaignConfig;
  const gs = { config, campaignRoot: '/campaign', homeDir: '/home', activePlayerIndex: 0, displayResources: {}, resourceValues: {} } as GameState;
  let receipt = false;
  const engine = { getSceneManager: () => ({ getFileIO: () => io, getSessionState: () => ({}) }), getTier: () => ({}), setStartupMechanicsBarrier: vi.fn(), bootstrapStartup: vi.fn(async () => {}), hasCompletedExchange: vi.fn(async () => receipt), processInput: vi.fn(async () => { receipt = complete; }), setUIState: vi.fn(), getPersister: () => undefined } as unknown as GameEngine;
  const manager = new SessionManager('/campaigns');
  Object.assign(manager, { engine, gameState: gs });
  const journal: StartupEnvelope = { version: 1, id: 'startup:accepted', accepted: config, handles: [], setupHandoff: 'Private', openingDirective: 'Begin', contentBoundaries: '', portraits: [], taskStatus: { scaffold: 'ready', mechanics: 'ready', opening: 'pending' } };
  const run = () => (manager as unknown as { startNewGame(engine: GameEngine, config: CampaignConfig, gs: GameState, tree: EntityTree): Promise<void> }).startNewGame(engine, config, gs, {} as EntityTree);
  return { io, engine, journal, run, accept: () => { receipt = true; } };
}

describe('opening completion receipt', () => {
  it('keeps failed or empty foreground completion retryable', async () => {
    const f = fixture(false); await writeStartup('/campaign', f.io, f.journal);
    await expect(f.run()).rejects.toThrow('opening did not complete');
    expect((await readStartup('/campaign', f.io))?.taskStatus.opening).toBe('in_progress');
  });
  it('does not regenerate an accepted opening after its final startup write was interrupted', async () => {
    const f = fixture(true); f.accept(); f.journal.taskStatus.opening = 'in_progress'; await writeStartup('/campaign', f.io, f.journal);
    await f.run(); expect(f.engine.processInput).not.toHaveBeenCalled();
  });
  it('requires the engine receipt even when a startup marker claims delivery', async () => {
    const f = fixture(true); f.journal.taskStatus.opening = 'delivered'; await writeStartup('/campaign', f.io, f.journal);
    await f.run(); expect(f.engine.processInput).toHaveBeenCalledWith('Ada', expect.any(String), { skipTranscript: true, inputKind: 'bootstrap', exchangeId: 'startup:accepted:opening' });
    expect((await readStartup('/campaign', f.io))?.taskStatus.opening).toBe('delivered');
  });
});
