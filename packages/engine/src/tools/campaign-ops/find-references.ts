import type { FileIO } from "../../agents/scene-manager.js";
import { getCampaignKnowledge } from "../../knowledge/store.js";
export interface EntityReference {
  file: string; // relative path of the file containing the link
  display: string; // link display text
  line: number; // 1-indexed line number
}
export interface FindReferencesResult {
  target: string;
  references: EntityReference[];
  totalFiles: number;
}
/** Inspect explicit graph edges; prose mentions do not establish dependencies. */
export async function findReferences(root: string, fileIO: FileIO, targetPath: string): Promise<FindReferencesResult> {
  const store = await getCampaignKnowledge(root, fileIO);
  const target = await store.resolve(targetPath);
  if (!target)
    throw new Error(`Unknown knowledge identity: ${targetPath}`);
  const outline = await store.outline();
  const references: EntityReference[] = [];
  for (const node of outline)
    for (const ref of (await store.read(node.uid, { textLimit: 0, logLimit: 0 })).references)
      if (ref.target === target)
        references.push({ file: `knowledge:${ref.source}`, display: ref.label, line: 0 });
  return { target: `knowledge:${target}`, references, totalFiles: outline.length };
}
