import type { FileIO } from "../../agents/scene-manager.js";
import { extractWikilinks } from "../filesystem/wikilinks.js";
import { resolveRelativePath } from "../filesystem/validation.js";
import { norm } from "../../utils/paths.js";
import { computeRelativePath } from "./relative-path.js";
import { walkCampaignFiles } from "./walk-campaign.js";

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
  const normalizedRoot = norm(root);
  const absOld = normalizedRoot + "/" + oldPath;
  const absNew = normalizedRoot + "/" + newPath;

  // Verify old file exists
  if (!(await fileIO.exists(absOld))) {
    throw new Error(`Source file does not exist: ${oldPath}`);
  }

  // Verify new file does not exist
  if (await fileIO.exists(absNew)) {
    throw new Error(`Destination file already exists: ${newPath}`);
  }

  // Walk all campaign files
  const campaignFiles = await walkCampaignFiles(root, fileIO);

  const filesUpdated: string[] = [];
  let totalLinksUpdated = 0;
  const fileWrites: Array<{ absPath: string; content: string }> = [];

  // Rewrite links in each file
  for (const file of campaignFiles) {
    const { content: updatedContent, count } = rewriteLinks(
      file.content,
      file.relativePath,
      oldPath,
      newPath,
    );
    if (count > 0) {
      filesUpdated.push(file.relativePath);
      totalLinksUpdated += count;
      fileWrites.push({
        absPath: normalizedRoot + "/" + file.relativePath,
        content: updatedContent,
      });
    }
  }

  // Perform writes if not dry-run
  if (!dryRun) {
    // Write all updated files
    for (const { absPath, content } of fileWrites) {
      await fileIO.writeFile(absPath, content);
    }

    // Move entity file: read → mkdir if needed → write new → delete old
    const entityContent = await fileIO.readFile(absOld);
    const newDir = absNew.split("/").slice(0, -1).join("/");
    await fileIO.mkdir(newDir);
    await fileIO.writeFile(absNew, entityContent);
    if (fileIO.deleteFile) {
      await fileIO.deleteFile(absOld);
    }
  }

  return {
    oldPath,
    newPath,
    filesUpdated,
    linksUpdated: totalLinksUpdated,
    dryRun,
  };
}
