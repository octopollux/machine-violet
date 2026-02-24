import type { FileIO } from "../../agents/scene-manager.js";
import { extractWikilinks } from "../filesystem/wikilinks.js";
import { resolveRelativePath } from "../filesystem/validation.js";
import { walkCampaignFiles } from "./walk-campaign.js";

export interface EntityReference {
  file: string;    // relative path of the file containing the link
  display: string; // link display text
  line: number;    // 1-indexed line number
}

export interface FindReferencesResult {
  target: string;
  references: EntityReference[];
  totalFiles: number;
}

/**
 * Find all wikilinks across the campaign that resolve to a given entity file.
 *
 * @param root      Campaign root directory (absolute path)
 * @param fileIO    File I/O abstraction
 * @param targetPath  Entity path relative to campaign root (e.g. "characters/kael.md")
 */
export async function findReferences(
  root: string,
  fileIO: FileIO,
  targetPath: string,
): Promise<FindReferencesResult> {
  const campaignFiles = await walkCampaignFiles(root, fileIO);
  const references: EntityReference[] = [];

  for (const file of campaignFiles) {
    const links = extractWikilinks(file.content);
    for (const link of links) {
      const resolved = resolveRelativePath(file.relativePath, link.target);
      if (resolved === targetPath) {
        references.push({
          file: file.relativePath,
          display: link.display,
          line: link.line,
        });
      }
    }
  }

  return {
    target: targetPath,
    references,
    totalFiles: campaignFiles.length,
  };
}
