import type { FileIO } from "../../agents/scene-manager.js";
import { extractWikilinks } from "../filesystem/wikilinks.js";
import { resolveRelativePath } from "../filesystem/validation.js";
import { getCampaignKnowledge } from "../../knowledge/store.js";
import { computeRelativePath } from "./relative-path.js";

export interface RenameResult {
  oldPath: string;
  newPath: string;
  filesUpdated: string[];  // relative paths of files whose links were rewritten
  linksUpdated: number;    // total link rewrites
  dryRun: boolean;
}

/**
 * Rewrite wikilinks in content that resolve to oldEntityPath,
 * pointing them to newEntityPath instead.
 *
 * Exported for use by merge-entities.
 */
export function rewriteLinks(
  content: string,
  fileRelativePath: string,
  oldEntityPath: string,
  newEntityPath: string,
): { content: string; count: number } {
  const links = extractWikilinks(content);
  let updated = content;
  let count = 0;

  // Process links in reverse order to preserve string positions
  const matchingLinks = links.filter((link) => {
    const resolved = resolveRelativePath(fileRelativePath, link.target);
    return resolved === oldEntityPath;
  });

  // Sort by position in file (reverse) to allow safe string replacement
  // We need to find each link occurrence and replace its target
  for (const link of matchingLinks.reverse()) {
    const newTarget = computeRelativePath(fileRelativePath, newEntityPath);
    const oldLinkText = `[${link.display}](${link.target})`;
    const newLinkText = `[${link.display}](${newTarget})`;

    // Find the exact occurrence on the correct line
    const lines = updated.split("\n");
    const lineIdx = link.line - 1;
    if (lineIdx < lines.length) {
      const lineContent = lines[lineIdx];
      const replaced = lineContent.replace(oldLinkText, newLinkText);
      if (replaced !== lineContent) {
        lines[lineIdx] = replaced;
        updated = lines.join("\n");
        count++;
      }
    }
  }

  return { content: updated, count };
}

/**
 * Rename an entity file and update all wikilinks pointing to it.
 */
export async function renameEntity(
  root: string,
  fileIO: FileIO,
  oldPath: string,
  newPath: string,
  dryRun: boolean,
): Promise<RenameResult> {
  const store=await getCampaignKnowledge(root,fileIO);
  const uid=await store.resolve(oldPath);if(!uid) throw new Error(`Unknown knowledge identity: ${oldPath}`);
  const occupied=await store.resolve(newPath);if(occupied && occupied!==uid) throw new Error(`Destination identity already exists: ${newPath}`);
  const parts=newPath.replace(/^knowledge:/,"").split("/");
  const name=(parts.at(-1)==="index.md" ? parts.at(-2) : parts.at(-1))?.replace(/\.md$/,"").replace(/-/g," ") ?? newPath;
  if(!dryRun) await store.mutate([{op:"patch",uid,name,history:`Renamed to ${name}`},{op:"remove_fields",uid,keys:["placeholder"]}],{source:"rename"});
  return {oldPath:`knowledge:${uid}`,newPath:`knowledge:${uid}`,filesUpdated:[],linksUpdated:0,dryRun};
}
