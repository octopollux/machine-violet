import type { FileIO } from "../../agents/scene-manager.js";
import { norm } from "../../utils/paths.js";

export interface CampaignFile {
  relativePath: string; // e.g. "campaign/scenes/001-gate/transcript.md"
  content: string;
}

/** Walk narrative Markdown, rule cards and the campaign JSON log. */
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

  // Metadata is inspected via SQLite; this walker covers narrative and rules only.
  await walkFlat(normalizedRoot + "/rules", "rules");

  // Campaign log (JSON format — expand entries into searchable text)
  try {
    const logPath = normalizedRoot + "/campaign/log.json";
    const raw = await fileIO.readFile(logPath);
    // Provide the raw JSON as content — wikilink scanner handles text matching
    files.push({ relativePath: "campaign/log.json", content: raw });
  } catch {
    // A fresh campaign may not have a log yet.
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
