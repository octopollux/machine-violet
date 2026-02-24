import type { FileIO } from "../../agents/scene-manager.js";
import { norm } from "../../utils/paths.js";

export interface CampaignFile {
  relativePath: string; // e.g. "characters/kael.md"
  content: string;
}

/**
 * Walk all .md files in a campaign directory tree.
 *
 * Walks: characters/, locations/ (with subdirs + index.md), factions/, lore/,
 * campaign/log.md, campaign/scenes/star/transcript.md, campaign/scenes/star/dm-notes.md,
 * campaign/session-recaps/*.md, players/.
 */
export async function walkCampaignFiles(
  root: string,
  fileIO: FileIO,
): Promise<CampaignFile[]> {
  const files: CampaignFile[] = [];
  const normalizedRoot = norm(root);

  // Walk a flat directory of .md files
  async function walkFlat(dir: string, relPrefix: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fileIO.listDir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.endsWith(".md")) {
        const abs = normalizedRoot + "/" + relPrefix + "/" + entry;
        try {
          const content = await fileIO.readFile(abs);
          files.push({ relativePath: relPrefix + "/" + entry, content });
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  // Walk a directory that may contain subdirs with index.md (like locations/)
  async function walkWithSubdirs(dir: string, relPrefix: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fileIO.listDir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.endsWith(".md")) {
        const abs = normalizedRoot + "/" + relPrefix + "/" + entry;
        try {
          const content = await fileIO.readFile(abs);
          files.push({ relativePath: relPrefix + "/" + entry, content });
        } catch {
          // Skip unreadable
        }
      } else if (!entry.includes(".")) {
        // Likely a subdirectory — recurse
        await walkWithSubdirs(
          normalizedRoot + "/" + relPrefix + "/" + entry,
          relPrefix + "/" + entry,
        );
      }
    }
  }

  // Top-level entity dirs (flat .md files)
  for (const dir of ["characters", "factions", "lore", "players"]) {
    await walkFlat(normalizedRoot + "/" + dir, dir);
  }

  // Locations (with subdirs containing index.md)
  await walkWithSubdirs(normalizedRoot + "/locations", "locations");

  // Campaign log
  try {
    const logPath = normalizedRoot + "/campaign/log.md";
    const content = await fileIO.readFile(logPath);
    files.push({ relativePath: "campaign/log.md", content });
  } catch {
    // Missing log is fine
  }

  // Scene transcripts and dm-notes
  let sceneDirs: string[];
  try {
    sceneDirs = await fileIO.listDir(normalizedRoot + "/campaign/scenes");
  } catch {
    sceneDirs = [];
  }
  for (const sceneDir of sceneDirs) {
    if (sceneDir.includes(".")) continue; // skip files
    const sceneBase = "campaign/scenes/" + sceneDir;
    for (const file of ["transcript.md", "dm-notes.md"]) {
      try {
        const abs = normalizedRoot + "/" + sceneBase + "/" + file;
        const content = await fileIO.readFile(abs);
        files.push({ relativePath: sceneBase + "/" + file, content });
      } catch {
        // Missing is fine
      }
    }
  }

  // Session recaps
  await walkFlat(normalizedRoot + "/campaign/session-recaps", "campaign/session-recaps");

  return files;
}
