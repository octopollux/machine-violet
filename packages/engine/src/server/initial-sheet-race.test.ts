import { buildInitialSheet } from './setup-session.js';
import { getCampaignKnowledge } from '../knowledge/store.js';
import { serializeEntity } from '../tools/filesystem/frontmatter.js';
import { promoteCharacter } from '../agents/subagents/character-promotion.js';
import type { FileIO } from '../agents/scene-manager.js';
import type { TierProvider } from '../providers/types.js';
vi.mock('../agents/subagents/character-promotion.js', () => ({ promoteCharacter: vi.fn() }));

it('accepts delayed initial mechanics while preserving concurrent granular biography and canonical naming', async () => {
  const io = { readFile: async () => 'Test rules' } as unknown as FileIO;
  const store = await getCampaignKnowledge('/sheet-race', io);
  const created = await store.mutate([{ op: 'upsert', collection: 'Characters', name: 'Ada', fields: { biography: 'Original biography', custom: 'Keep me' }, body: 'Accepted character stub' }]);
  const uid = created.identities[0].uid;
  let release!: () => void; let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  vi.mocked(promoteCharacter).mockImplementationOnce(async () => {
    started(); await gate;
    return { text: '', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }, updatedSheet: serializeEntity('Ada', { biography: 'Original biography', custom: 'Keep me', hp: 12 }, '## Mechanics\nHP: 12', []), changelogEntry: 'Initial sheet' };
  });
  const onUsage = vi.fn();
  const job = buildInitialSheet('/sheet-race', { characterName: 'Ada', system: 'test', characterDetails: 'Scout' }, io, '/home', { provider: {}, model: 'small-test' } as TierProvider, onUsage);
  await entered;
  await store.mutate([{ op: 'patch', uid, name: 'Ada the Scout', fields: { biography: 'New established biography' }, body: 'Concurrent DM biography correction' }]);
  const mutate = store.mutate.bind(store); let injected = false;
  vi.spyOn(store, 'mutate').mockImplementation(async (operations, options) => {
    if (options?.source === 'setup-sheet' && !injected) { injected = true; await mutate([{ op: 'patch', uid, body: 'Still newer biography at atomic commit' }]); }
    return mutate(operations, options);
  });
  release(); await job;
  const accepted = await store.read(uid);
  expect(accepted.name).toBe('Ada the Scout');
  expect(accepted.fields.biography).toBe('New established biography');
  expect(accepted.fields.custom).toBe('Keep me');
  expect(accepted.fields.hp).toBe('12');
  expect(accepted.fields.sheet_status).toBe('complete');
  expect(accepted.body).toContain('HP: 12');
  expect(accepted.body).toContain('Still newer biography at atomic commit');
  expect(injected).toBe(true);
  expect(onUsage).toHaveBeenCalledTimes(1);
  await buildInitialSheet('/sheet-race', { characterName: uid, system: 'test', characterDetails: 'Scout' }, io, '/home', { provider: {}, model: 'small-test' } as TierProvider, onUsage);
  expect(onUsage).toHaveBeenCalledTimes(1);
  await store.close();
});
