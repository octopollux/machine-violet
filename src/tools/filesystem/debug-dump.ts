import { join } from "node:path";
import type { FileIO } from "../../agents/scene-manager.js";
import type { SerializedExchange } from "../../context/conversation.js";

export interface DebugDumpData {
  error: Error;
  engineState: string;
  sceneNumber: number;
  sceneSlug: string;
  sessionNumber: number;
  precis: string;
  transcript: string[];
  conversation: SerializedExchange[];
}

/**
 * Write a debug dump file after an unhandled exception.
 * Saved to {campaignRoot}/.debug/crash-{timestamp}.txt.
 * Returns the file path on success, or null if the dump itself fails.
 */
export async function writeDebugDump(
  campaignRoot: string,
  fileIO: FileIO,
  data: DebugDumpData,
): Promise<string | null> {
  try {
    const debugDir = join(campaignRoot, ".debug");
    await fileIO.mkdir(debugDir);

    // Ensure .debug/ is excluded from isomorphic-git snapshots
    await ensureGitignore(campaignRoot, fileIO, ".debug/");

    const ts = new Date();
    const stamp = ts.toISOString().replace(/[:.]/g, "-");
    const filename = `crash-${stamp}.txt`;
    const filepath = join(debugDir, filename);

    const sections: string[] = [];

    sections.push("=== DEBUG DUMP ===");
    sections.push(`Timestamp: ${ts.toISOString()}`);
    sections.push(`Engine State: ${data.engineState}`);
    sections.push(`Scene: ${data.sceneNumber} (${data.sceneSlug})`);
    sections.push(`Session: ${data.sessionNumber}`);
    sections.push("");

    sections.push("=== ERROR ===");
    sections.push(data.error.stack ?? data.error.message);
    sections.push("");

    if (data.precis) {
      sections.push("=== PRECIS ===");
      sections.push(data.precis);
      sections.push("");
    }

    sections.push("=== SCENE TRANSCRIPT ===");
    for (const block of data.transcript) {
      sections.push(block);
    }
    sections.push("");

    sections.push("=== CONVERSATION ===");
    sections.push(JSON.stringify(data.conversation, null, 2));

    await fileIO.writeFile(filepath, sections.join("\n"));
    return filepath;
  } catch {
    return null;
  }
}

async function ensureGitignore(
  campaignRoot: string,
  fileIO: FileIO,
  entry: string,
): Promise<void> {
  const gitignorePath = join(campaignRoot, ".gitignore");
  try {
    const content = await fileIO.readFile(gitignorePath);
    if (!content.includes(entry)) {
      await fileIO.appendFile(gitignorePath, `\n${entry}\n`);
    }
  } catch {
    await fileIO.writeFile(gitignorePath, `${entry}\n`);
  }
}
