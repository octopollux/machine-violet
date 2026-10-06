import type { CampaignConfig } from '@machine-violet/shared/types/config.js';
import type { FileIO } from './scene-manager.js';
import { getCampaignKnowledge } from '../knowledge/store.js';
import { norm } from '../utils/paths.js';
import { createHash } from 'node:crypto';

/** Private accepted setup state. Opening directives are plans, never observed fiction. */
export interface StartupEnvelope {
  id: string;
  version: 1;
  accepted: CampaignConfig;
  storeRevision?: string;
  seedProvenance?: { source: 'seed' | 'custom'; worldSlug?: string; selectedForks: Record<string, string> };
  handles: { uid: string; name: string; parent: string | null }[];
  setupHandoff: string;
  openingDirective: string;
  contentBoundaries: string;
  portraits: { character: string; path: string }[];
  initialSheet?: { character: string; system: string; details: string; status: 'pending' | 'ready' };
  taskStatus: { scaffold: 'ready'; mechanics: 'ready' | 'pending'; opening: 'pending' | 'in_progress' | 'delivered' };
}

export const startupPath = (root: string): string => norm(`${root}/state/startup.json`);

/** Preserve newer prose while adding the specialist's changed/new sheet sections. */
export function rebaseSheetBody(base: string, generated: string, current: string): string {
  if (current === base) return generated;
  const sections = (text: string): Map<string, string> => new Map(text.split(/(?=^#{1,6}\s)/m).filter(Boolean).map(part => [part.match(/^#{1,6}\s[^\n]*/)?.[0] ?? 'intro', part]));
  const original = sections(base);
  const result = sections(current);
  for (const [heading, section] of sections(generated)) {
    if (section === original.get(heading)) continue;
    const existing = result.get(heading);
    if (existing === undefined || existing === original.get(heading)) result.set(heading, section);
  }
  // A plain mechanical sheet has no heading to merge. Keep newer prose and
  // append the accepted specialist result so neither side silently disappears.
  if (result.size === 1 && result.has('intro') && !/^#{1,6}\s/m.test(generated)) return `${current.trimEnd()}\n\n${generated}`;
  return [...result.values()].map(section => section.trimEnd()).join('\n\n');
}

export async function readStartup(root: string, io: FileIO): Promise<StartupEnvelope | null> {
  let raw: string;
  try { raw = await io.readFile(startupPath(root)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const envelope = JSON.parse(raw) as StartupEnvelope;
  if (envelope.version !== 1 || !envelope.id || !envelope.taskStatus) throw new Error('Invalid private startup journal');
  return envelope;
}

export async function writeStartup(root: string, io: FileIO, envelope: StartupEnvelope): Promise<void> {
  await (io.writeFileAtomic ?? io.writeFile)(startupPath(root), JSON.stringify(envelope, null, 2));
}

export async function buildStartup(root: string, io: FileIO, config: CampaignConfig, boundaries: string): Promise<StartupEnvelope> {
  const knowledge = await getCampaignKnowledge(root, io);
  const outline = await knowledge.outline();
  const portraits: StartupEnvelope['portraits'] = [];
  for (const player of config.players) {
    const slug = player.character.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const path = norm(`characters/${slug}-portrait.png`);
    if (await io.exists(norm(`${root}/${path}`))) portraits.push({ character: player.character, path });
  }
  return {
    id: `startup:${config.createdAt ?? config.name}`, version: 1,
    accepted: structuredClone(config),
    storeRevision: createHash('sha256').update(await knowledge.snapshot()).digest('hex'),
    seedProvenance: { source: 'custom', selectedForks: { ...config.fork_selections } },
    handles: outline.map(node => ({ uid: node.uid, name: node.name, parent: node.parent })),
    setupHandoff: config.setup_handoff ?? '', openingDirective: config.opening_scene ?? '',
    contentBoundaries: boundaries, portraits,
    taskStatus: { scaffold: 'ready', mechanics: 'ready', opening: 'pending' },
  };
}
