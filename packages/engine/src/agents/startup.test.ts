import { buildStartup, readStartup, writeStartup } from './startup.js';
import type { FileIO } from './scene-manager.js';
import type { CampaignConfig } from '@machine-violet/shared/types/config.js';
import { campaignPaths } from '../tools/filesystem/index.js';
import { norm } from '../utils/paths.js';

describe('private accepted startup', () => {
  it.each(['The Watchmaker', 'The ' + 'Extraordinarily Long Character Name '.repeat(3), '時計師'])('retains approved portrait at canonical path for %s', async character => {
    const { io, config } = fixture();
    config.players[0].character = character;
    const absolute = norm(campaignPaths('/campaign').characterPortrait(character));
    io.exists = async path => path === absolute;
    const envelope = await buildStartup('/campaign', io, config, '');
    expect(envelope.portraits).toEqual([{ character, path: absolute.slice('/campaign/'.length) }]);
  });
  function fixture() {
    const files: Record<string, string> = {};
    const io = {
      readFile: async (path: string) => { if (!(path in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files[path]; },
      writeFile: async (path: string, text: string) => { files[path] = text; },
      exists: async (path: string) => path.endsWith('characters/ada-portrait.png'),
      campaignKnowledge: async () => ({ snapshot: async () => 'accepted canonical seed', outline: async () => [{ uid: 'pc1', name: 'Ada', parent: 'characters' }, { uid: 'loc1', name: 'Seed Harbour', parent: 'locations' }] }),
    } as unknown as FileIO;
    const config = { name: 'Accepted', createdAt: '2026-10-05', players: [{ name: 'Player', character: 'Ada' }], setup_handoff: 'Private player intent', opening_scene: 'Begin at the harbour', campaign_detail: 'Secret selected seed branch', fork_selections: { fate: 'rescue' } } as CampaignConfig;
    return { files, io, config };
  }
  it('retains the actual handoff, accepted branch, canonical identity, boundaries and approved portrait', async () => {
    const { io, config } = fixture();
    const envelope = await buildStartup('/campaign', io, config, 'No spiders');
    expect(envelope.setupHandoff).toBe('Private player intent');
    expect(envelope.accepted.campaign_detail).toBe('Secret selected seed branch');
    expect(envelope.accepted.fork_selections).toEqual({ fate: 'rescue' });
    expect(envelope.handles[1]).toEqual({ uid: 'loc1', name: 'Seed Harbour', parent: 'locations' });
    expect(envelope.contentBoundaries).toBe('No spiders');
    expect(envelope.portraits).toEqual([{ character: 'Ada', path: 'characters/ada-portrait.png' }]);
    config.setup_handoff = 'mutated';
    expect(envelope.accepted.setup_handoff).toBe('Private player intent');
  });
  it('resumes a durable startup identity and delivered opening', async () => {
    const { io, config } = fixture();
    const envelope = await buildStartup('/campaign', io, config, '');
    envelope.taskStatus.opening = 'delivered';
    await writeStartup('/campaign', io, envelope);
    expect(await readStartup('/campaign', io)).toEqual(envelope);
  });
  it('fails closed on a malformed existing journal', async () => {
    const { files, io } = fixture();
    files['/campaign/state/startup.json'] = '{';
    await expect(readStartup('/campaign', io)).rejects.toThrow();
  });
  it('does not restart accepted setup on a journal permission or I/O failure', async () => {
    const { io } = fixture();
    io.readFile = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    await expect(readStartup('/campaign', io)).rejects.toThrow('denied');
  });
});
