/**
 * Campaign archival, unarchival, and deletion operations.
 *
 * Archive zips a campaign folder into archivedcampaigns/<CampaignName>.zip,
 * verifies integrity at each step, then removes the original folder.
 * Unarchive reverses the process. Delete removes a campaign after confirmation.
 *
 * All file I/O is binary to preserve git objects and other non-UTF-8 data.
 */

import { join, basename } from "node:path";
import { norm } from "../utils/paths.js";
import { zipBinaryFiles, unzipBinaryFiles } from "../utils/archive.js";
import type { BinaryFileMap } from "../utils/archive.js";

// --- I/O abstraction (superset of game FileIO, adds binary + stat + recursive ops) ---

export interface ArchiveFileIO {
  readFile(path: string): Promise<string>;
  readBinary(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  listDir(path: string): Promise<string[]>;
  deleteFile(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  /** Returns file modification time as ISO string, or null if missing. */
  fileMtime(path: string): Promise<string | null>;
  /** Whether the entry is a directory (vs a file). */
  isDirectory(path: string): Promise<boolean>;
}

// --- Types ---

export interface ArchiveResult {
  ok: boolean;
  /** Human-readable error if ok is false. */
  error?: string;
  /** Path to the created zip or restored campaign dir (on success). */
  zipPath?: string;
}

export interface ArchivedCampaignEntry {
  /** Campaign name derived from zip filename (sans .zip). */
  name: string;
  /** Absolute path to the zip file. */
  zipPath: string;
  /** File modification timestamp as ISO string. */
  archivedDate: string;
}

export interface CampaignDeleteInfo {
  campaignName: string;
  characterNames: string[];
  dmTurnCount: number;
}

// --- Helpers ---

const ARCHIVE_DIR = "archivedcampaigns";

/** Resolve the archivedcampaigns directory (sibling to campaigns dir). */
export function archiveDir(campaignsDir: string): string {
  return norm(join(campaignsDir, "..", ARCHIVE_DIR));
}

/**
 * Sanitize a campaign name for use as a filename component.
 * Strips path separators, drive letters, control chars, and reserved characters.
 */
function sanitizeFilename(name: string): string {
  let safe = basename(name);
  // eslint-disable-next-line no-control-regex
  safe = safe.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  safe = safe.replace(/^\.+/, "").replace(/[ .]+$/g, "");
  return safe || "campaign";
}

/**
 * Recursively walk a directory, returning relative paths and binary contents.
 * Reads all files as raw bytes to preserve git objects and other binary data.
 */
export async function walkAllBinary(
  io: ArchiveFileIO,
  root: string,
  prefix: string,
): Promise<{ relativePath: string; content: Uint8Array }[]> {
  const results: { relativePath: string; content: Uint8Array }[] = [];
  let entries: string[];
  try {
    entries = await io.listDir(root);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const abs = norm(join(root, entry));
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (await io.isDirectory(abs)) {
      const children = await walkAllBinary(io, abs, rel);
      results.push(...children);
    } else {
      try {
        const content = await io.readBinary(abs);
        results.push({ relativePath: rel, content });
      } catch {
        // Skip unreadable files
      }
    }
  }
  return results;
}

/**
 * Recursively delete a directory and all its contents.
 */
async function rmRecursive(io: ArchiveFileIO, dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await io.listDir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = norm(join(dir, entry));
    if (await io.isDirectory(abs)) {
      await rmRecursive(io, abs);
    } else {
      await io.deleteFile(abs);
    }
  }
  await io.rmdir(dir);
}

/** Compare two Uint8Arrays for byte-level equality. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// --- Core operations ---

/**
 * Read campaign config.json and extract the campaign name.
 * Falls back to directory name if config is missing/broken.
 */
export async function readCampaignName(
  campaignPath: string,
  io: ArchiveFileIO,
): Promise<string> {
  try {
    const raw = await io.readFile(norm(join(campaignPath, "config.json")));
    const config = JSON.parse(raw);
    if (typeof config.name === "string" && config.name) return config.name;
  } catch { /* fall through */ }
  return basename(campaignPath);
}

/**
 * Extract info for the delete confirmation modal.
 * Reads config.json for name + players, display-log.md for DM turn count.
 */
export async function getCampaignDeleteInfo(
  campaignPath: string,
  io: ArchiveFileIO,
): Promise<CampaignDeleteInfo> {
  let campaignName = basename(campaignPath);
  let characterNames: string[] = [];

  // Read config
  try {
    const raw = await io.readFile(norm(join(campaignPath, "config.json")));
    const config = JSON.parse(raw);
    if (typeof config.name === "string" && config.name) campaignName = config.name;
    if (Array.isArray(config.players)) {
      characterNames = config.players
        .map((p: { character?: string }) => p.character)
        .filter((c: unknown): c is string => typeof c === "string" && c !== "");
    }
  } catch { /* best effort */ }

  // Count DM turns from display-log.md
  // A "DM turn" is a group of consecutive DM lines separated by any non-DM line.
  let dmTurnCount = 0;
  try {
    const log = await io.readFile(norm(join(campaignPath, "state", "display-log.md")));
    let inDmBlock = false;
    for (const line of log.split("\n")) {
      const isDmLine = line !== "" && !line.startsWith("> ") && !line.startsWith("[system] ") && line !== "---";
      if (isDmLine && !inDmBlock) {
        dmTurnCount++;
        inDmBlock = true;
      } else if (!isDmLine) {
        inDmBlock = false;
      }
    }
  } catch { /* no display log — 0 turns */ }

  return { campaignName, characterNames, dmTurnCount };
}

/**
 * Archive a campaign: zip → verify → move → verify → delete source.
 *
 * Steps:
 * 1. Walk all files as binary, record count and total byte size
 * 2. Zip into memory
 * 3. Unzip in memory and verify file count + total size match
 * 4. Write zip to archivedcampaigns/<CampaignName>.zip
 * 5. Read the written zip back and verify byte-level equality
 * 6. Delete the campaign source folder
 */
export async function archiveCampaign(
  campaignPath: string,
  campaignsDir: string,
  io: ArchiveFileIO,
): Promise<ArchiveResult> {
  try {
    const normalizedPath = norm(campaignPath);

    // Step 1: Walk all files as binary
    const files = await walkAllBinary(io, normalizedPath, "");
    const fileCount = files.length;
    if (fileCount === 0) {
      return { ok: false, error: "Campaign folder is empty or unreadable" };
    }
    const totalSize = files.reduce((sum, f) => sum + f.content.length, 0);

    // Build BinaryFileMap
    const fileMap: BinaryFileMap = {};
    for (const f of files) {
      fileMap[f.relativePath] = f.content;
    }

    // Step 2: Zip
    const zipped = zipBinaryFiles(fileMap);
    if (!zipped) {
      return { ok: false, error: "Failed to create zip archive" };
    }

    // Step 3: Verify by round-tripping in memory
    const roundTrip = unzipBinaryFiles(zipped);
    if (!roundTrip) {
      return { ok: false, error: "Zip verification failed: could not unzip in memory" };
    }
    const rtCount = Object.keys(roundTrip).length;
    const rtSize = Object.values(roundTrip).reduce((sum, c) => sum + c.length, 0);
    if (rtCount !== fileCount) {
      return { ok: false, error: `Zip verification failed: file count mismatch (expected ${fileCount}, got ${rtCount})` };
    }
    if (rtSize !== totalSize) {
      return { ok: false, error: `Zip verification failed: total size mismatch (expected ${totalSize}, got ${rtSize})` };
    }

    // Step 4: Write zip to archivedcampaigns/
    const campaignName = await readCampaignName(normalizedPath, io);
    const safeName = sanitizeFilename(campaignName);
    const archDir = archiveDir(campaignsDir);
    await io.mkdir(archDir);

    let zipPath = norm(join(archDir, `${safeName}.zip`));

    // Avoid overwriting an existing archive
    if (await io.exists(zipPath)) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      zipPath = norm(join(archDir, `${safeName} (${ts}).zip`));
    }

    await io.writeBinary(zipPath, zipped);

    // Step 5: Read back and verify byte-level equality
    const readBack = await io.readBinary(zipPath);
    if (!bytesEqual(readBack, zipped)) {
      return { ok: false, error: "Write verification failed: zip file contents mismatch on disk" };
    }

    // Step 6: Delete source
    await rmRecursive(io, normalizedPath);
    return { ok: true, zipPath };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Archive failed" };
  }
}

/**
 * List all archived campaigns (zips in archivedcampaigns/).
 */
export async function listArchivedCampaigns(
  campaignsDir: string,
  io: ArchiveFileIO,
): Promise<ArchivedCampaignEntry[]> {
  const archDir = archiveDir(campaignsDir);
  let entries: string[];
  try {
    entries = await io.listDir(archDir);
  } catch {
    return [];
  }

  const results: ArchivedCampaignEntry[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".zip")) continue;
    const zipPath = norm(join(archDir, entry));
    const name = entry.replace(/\.zip$/, "");
    const mtime = await io.fileMtime(zipPath);
    results.push({
      name,
      zipPath,
      archivedDate: mtime ?? new Date().toISOString(),
    });
  }

  // Sort newest first
  results.sort((a, b) => b.archivedDate.localeCompare(a.archivedDate));
  return results;
}

/**
 * Unarchive a campaign: read zip → unzip → verify → write to campaigns dir.
 * Cleans up partially written files on failure.
 *
 * The campaign slug is derived from the zip filename. If a campaign with that
 * slug already exists, a numeric suffix is appended.
 */
export async function unarchiveCampaign(
  zipPath: string,
  campaignsDir: string,
  io: ArchiveFileIO,
): Promise<ArchiveResult> {
  // Read the zip
  let zipData: Uint8Array;
  try {
    zipData = await io.readBinary(zipPath);
  } catch {
    return { ok: false, error: "Failed to read archive file" };
  }

  // Unzip as binary
  const fileMap = unzipBinaryFiles(zipData);
  if (!fileMap) {
    return { ok: false, error: "Failed to unzip archive (corrupt?)" };
  }
  const fileCount = Object.keys(fileMap).length;
  if (fileCount === 0) {
    return { ok: false, error: "Archive is empty" };
  }

  // Determine campaign directory name from config.json in the archive, or from zip filename
  let campaignName: string | null = null;
  const configBytes = fileMap["config.json"];
  if (configBytes) {
    try {
      const config = JSON.parse(new TextDecoder().decode(configBytes));
      if (typeof config.name === "string" && config.name) campaignName = config.name;
    } catch { /* fall through */ }
  }

  // Slugify for directory name
  const rawName = campaignName ?? basename(zipPath).replace(/\.zip$/, "");
  const slug = rawName.toLowerCase()
    .replace(/^(the|a|an)\s+/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "campaign";

  // Ensure unique directory
  let campaignDir = norm(join(campaignsDir, slug));
  let suffix = 2;
  while (await io.exists(campaignDir)) {
    campaignDir = norm(join(campaignsDir, `${slug}-${suffix}`));
    suffix++;
  }

  // Write all files with cleanup on failure
  try {
    await io.mkdir(campaignDir);
    for (const [relativePath, content] of Object.entries(fileMap)) {
      const absPath = norm(join(campaignDir, relativePath));
      const parts = relativePath.split("/");
      if (parts.length > 1) {
        const parentRel = parts.slice(0, -1).join("/");
        await io.mkdir(norm(join(campaignDir, parentRel)));
      }
      await io.writeBinary(absPath, content);
    }

    // Verify: count files written
    const written = await walkAllBinary(io, campaignDir, "");
    if (written.length !== fileCount) {
      throw new Error(`Unarchive verification failed: wrote ${written.length}/${fileCount} files`);
    }
  } catch (e) {
    // Clean up partial writes
    try { await rmRecursive(io, campaignDir); } catch { /* best-effort */ }
    return { ok: false, error: e instanceof Error ? e.message : "Failed to unarchive campaign" };
  }

  return { ok: true, zipPath: campaignDir };
}

/**
 * Delete a campaign folder (recursive).
 */
export async function deleteCampaign(
  campaignPath: string,
  io: ArchiveFileIO,
): Promise<ArchiveResult> {
  try {
    await rmRecursive(io, norm(campaignPath));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to delete campaign" };
  }
}
