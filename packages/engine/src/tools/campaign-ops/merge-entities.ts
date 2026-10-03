import type { FileIO } from "../../agents/scene-manager.js";
import { getCampaignKnowledge } from "../../knowledge/store.js";
export interface MergeResult {
  winnerPath: string;
  loserPath: string;
  keysAdded: string[]; // front matter keys filled from loser
  filesUpdated: string[];
  linksUpdated: number;
  dryRun: boolean;
}
/** Consolidate identities atomically; references and old handles stay canonical. */
export async function mergeEntities(root: string, fileIO: FileIO, winnerPath: string, loserPath: string, dryRun: boolean): Promise<MergeResult> {
  const store = await getCampaignKnowledge(root, fileIO);
  const winner = await store.read(winnerPath);
  const loser = await store.read(loserPath);
  const keysAdded = Object.keys(loser.fields).filter(key => !(key in winner.fields));
  if (!dryRun)
    await store.mutate([{ op: "consolidate", uid: loser.uid, target: winner.uid }], { source: "merge" });
  return { winnerPath: `knowledge:${winner.uid}`, loserPath: `knowledge:${loser.uid}`, keysAdded, filesUpdated: [], linksUpdated: 0, dryRun };
}
