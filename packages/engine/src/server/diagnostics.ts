/**
 * Diagnostic bundle collection.
 *
 * Zips the active campaign folder together with the top-level `.debug/`
 * folder (engine.jsonl, server.log, context dumps) into a single archive
 * for triage. The campaign's own per-campaign `.debug/` is captured as
 * part of the campaign walk.
 *
 * Output: `<homeDir>/diagnostics/<campaignSlug>-<timestamp>.mvdiag`
 * (a zip file with a Machine Violet-specific extension for easy
 * recognition in support inboxes — any zip tool can still read it).
 */

import { join, basename } from "node:path";
import { norm } from "../utils/paths.js";
import { zipBinaryFiles, type BinaryFileMap } from "../utils/archive.js";
import { walkAllBinary, type ArchiveFileIO } from "../config/campaign-archive.js";

export interface DiagnosticsResult {
  ok: boolean;
  /** Absolute path to the zip on success. */
  path?: string;
  /** Human-readable error on failure. */
  error?: string;
}

const DIAGNOSTICS_DIR = "diagnostics";
const DEBUG_DIR = ".debug";
const BUNDLE_EXT = "mvdiag";

/** Sanitize a name for use as a filename component. */
function sanitizeFilename(name: string): string {
  let safe = basename(name);
  // eslint-disable-next-line no-control-regex
  safe = safe.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  safe = safe.replace(/^\.+/, "").replace(/[ .]+$/g, "");
  return safe || "campaign";
}

/** Read `config.json` to extract the campaign name; fall back to dir basename. */
async function readCampaignName(campaignRoot: string, io: ArchiveFileIO): Promise<string> {
  try {
    const raw = await io.readFile(norm(join(campaignRoot, "config.json")));
    const config = JSON.parse(raw);
    if (typeof config.name === "string" && config.name) return config.name;
  } catch { /* fall through */ }
  return basename(campaignRoot);
}

/**
 * Build a manifest describing the bundle origin. Helps whoever reads the
 * archive later (typically the developer triaging a bug) understand what
 * machine produced it and when.
 */
function buildManifest(args: {
  campaignName: string;
  campaignRoot: string;
  homeDir: string;
}): string {
  const manifest = {
    collectedAt: new Date().toISOString(),
    campaignName: args.campaignName,
    campaignRoot: args.campaignRoot,
    homeDir: args.homeDir,
    platform: process.platform,
    nodeVersion: process.version,
  };
  return JSON.stringify(manifest, null, 2);
}

/**
 * Collect a diagnostics bundle. Includes:
 *  - The current campaign folder (under `campaign/`) — captures per-campaign
 *    `.debug/`, state, config, characters, and the git history if enabled.
 *  - The top-level `.debug/` folder (under `.debug/`) — engine.jsonl,
 *    server.log, top-level context dumps.
 *  - A `manifest.json` at the root of the archive.
 *
 * The bundle is written to `<homeDir>/diagnostics/<campaignSlug>-<ts>.zip`.
 * If a file with that exact name already exists, the timestamp ensures
 * uniqueness; on collision (sub-second), an extra suffix is appended.
 */
export async function collectDiagnostics(
  campaignRoot: string,
  homeDir: string,
  io: ArchiveFileIO,
): Promise<DiagnosticsResult> {
  try {
    const fileMap: BinaryFileMap = {};

    // 1. Walk the campaign folder.
    const campaignFiles = await walkAllBinary(io, norm(campaignRoot), "");
    for (const f of campaignFiles) {
      fileMap[`campaign/${f.relativePath}`] = f.content;
    }

    // 2. Walk the top-level .debug folder (may not exist in test envs).
    const debugRoot = norm(join(homeDir, DEBUG_DIR));
    if (await io.exists(debugRoot)) {
      const debugFiles = await walkAllBinary(io, debugRoot, "");
      for (const f of debugFiles) {
        fileMap[`${DEBUG_DIR}/${f.relativePath}`] = f.content;
      }
    }

    // Empty bundle is a configuration error worth surfacing.
    if (Object.keys(fileMap).length === 0) {
      return { ok: false, error: "Nothing to collect — campaign and .debug folders are empty or unreadable." };
    }

    // 3. Add manifest.
    const campaignName = await readCampaignName(norm(campaignRoot), io);
    fileMap["manifest.json"] = new TextEncoder().encode(buildManifest({
      campaignName,
      campaignRoot: norm(campaignRoot),
      homeDir: norm(homeDir),
    }));

    // 4. Zip.
    const zipped = zipBinaryFiles(fileMap);
    if (!zipped) {
      return { ok: false, error: "Failed to create zip archive." };
    }

    // 5. Choose output path.
    const outDir = norm(join(homeDir, DIAGNOSTICS_DIR));
    await io.mkdir(outDir);

    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = sanitizeFilename(campaignName);
    let zipPath = norm(join(outDir, `${safeName}-${ts}.${BUNDLE_EXT}`));

    // Sub-second collision guard.
    let counter = 2;
    while (await io.exists(zipPath)) {
      zipPath = norm(join(outDir, `${safeName}-${ts}-${counter}.${BUNDLE_EXT}`));
      counter++;
    }

    await io.writeBinary(zipPath, zipped);
    return { ok: true, path: zipPath };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Diagnostics collection failed." };
  }
}
