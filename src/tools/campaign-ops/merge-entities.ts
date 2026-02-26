import type { FileIO } from "../../agents/scene-manager.js";
import { parseFrontMatter, serializeEntity } from "../filesystem/frontmatter.js";
import { norm } from "../../utils/paths.js";
import { rewriteLinks } from "./rename-entity.js";
import { walkCampaignFiles } from "./walk-campaign.js";

export interface MergeResult {
  winnerPath: string;
  loserPath: string;
  keysAdded: string[];    // front matter keys filled from loser
  filesUpdated: string[];
  linksUpdated: number;
  dryRun: boolean;
}

/**
 * Merge two entity files into one, then repoint all wikilinks from loser → winner.
 *
 * Winner keeps its data; loser's front matter fills gaps.
 * If loser has body content not already in winner, it's appended with a separator.
 * Changelogs are concatenated (winner first, then loser).
 */
export async function mergeEntities(
  root: string,
  fileIO: FileIO,
  winnerPath: string,
  loserPath: string,
  dryRun: boolean,
): Promise<MergeResult> {
  const normalizedRoot = norm(root);
  const absWinner = normalizedRoot + "/" + winnerPath;
  const absLoser = normalizedRoot + "/" + loserPath;

  // Read and parse both files
  const winnerRaw = await fileIO.readFile(absWinner);
  const loserRaw = await fileIO.readFile(absLoser);

  const winner = parseFrontMatter(winnerRaw);
  const loser = parseFrontMatter(loserRaw);

  // Merge front matter: loser keys fill gaps in winner
  const keysAdded: string[] = [];
  for (const [key, value] of Object.entries(loser.frontMatter)) {
    if (key.startsWith("_")) continue; // skip internal keys like _title
    if (!(key in winner.frontMatter) || winner.frontMatter[key] === undefined) {
      winner.frontMatter[key] = value;
      keysAdded.push(key);
    }
  }

  // Merge body: append loser body if it has content not in winner
  let mergedBody = winner.body;
  if (loser.body && loser.body.trim() && loser.body.trim() !== winner.body.trim()) {
    if (mergedBody) {
      mergedBody += "\n\n---\n\n" + loser.body;
    } else {
      mergedBody = loser.body;
    }
  }

  // Concatenate changelogs (winner first, then loser)
  const mergedChangelog = [...winner.changelog, ...loser.changelog];

  // Serialize merged entity
  const title = winner.frontMatter._title ?? loser.frontMatter._title ?? "Untitled";
  const mergedContent = serializeEntity(
    title as string,
    winner.frontMatter,
    mergedBody,
    mergedChangelog,
  );

  // Rewrite links: repoint loser links → winner
  const campaignFiles = await walkCampaignFiles(root, fileIO);
  const filesUpdated: string[] = [];
  let totalLinksUpdated = 0;
  const fileWrites: Array<{ absPath: string; content: string }> = [];

  for (const file of campaignFiles) {
    const { content: updatedContent, count } = rewriteLinks(
      file.content,
      file.relativePath,
      loserPath,
      winnerPath,
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
    // Write merged winner
    await fileIO.writeFile(absWinner, mergedContent);

    // Write all updated link files
    for (const { absPath, content } of fileWrites) {
      await fileIO.writeFile(absPath, content);
    }

    // Delete loser
    if (fileIO.deleteFile) {
      await fileIO.deleteFile(absLoser);
    }
  }

  return {
    winnerPath,
    loserPath,
    keysAdded,
    filesUpdated,
    linksUpdated: totalLinksUpdated,
    dryRun,
  };
}
