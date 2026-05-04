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
 *
 * `.git/` is skipped during the campaign walk: the object database is
 * heavy and rarely needed for triage — the working tree files already
 * tell the "what's the current state" story. A total in-memory cap
 * guards against pathological cases (very large logs / scene transcripts).
 */

import { join, basename } from "node:path";
import { norm } from "../utils/paths.js";
import { zipBinaryFiles, type BinaryFileMap } from "../utils/archive.js";
import { type ArchiveFileIO, readCampaignName } from "../config/campaign-archive.js";

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
/** Directory names skipped during the recursive walk (heavy / not useful for triage). */
const SKIP_DIRS = new Set([".git"]);
/** Hard cap on uncompressed bundle bytes. fflate does an in-memory zipSync,
 *  so the cap protects against OOM and keeps the resulting `.mvdiag` small
 *  enough to upload to a support channel (Discord free tier is ~25 MB). */
const MAX_UNCOMPRESSED_BYTES = 25 * 1024 * 1024;

/** Sanitize a name for use as a filename component. */
function sanitizeFilename(name: string): string {
  let safe = basename(name);
  // eslint-disable-next-line no-control-regex
  safe = safe.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  safe = safe.replace(/^\.+/, "").replace(/[ .]+$/g, "");
  return safe || "campaign";
}

/**
 * Recursive walk that mirrors `walkAllBinary` from campaign-archive.ts but
 * adds two diagnostics-specific behaviors:
 *  - skip directory names in `SKIP_DIRS` (notably `.git/`)
 *  - throw `"size_exceeded"` when running totals cross `MAX_UNCOMPRESSED_BYTES`
 *
 * Kept local rather than parameterized into the shared walker so the
 * archive code path stays simple.
 */
async function walkForDiagnostics(
  io: ArchiveFileIO,
  root: string,
  prefix: string,
  acc: { totalBytes: number },
): Promise<{ relativePath: string; content: Uint8Array }[]> {
  const results: { relativePath: string; content: Uint8Array }[] = [];
  let entries: string[];
  try {
    entries = await io.listDir(root);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = norm(join(root, entry));
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (await io.isDirectory(abs)) {
      const children = await walkForDiagnostics(io, abs, rel, acc);
      results.push(...children);
    } else {
      try {
        const content = await io.readBinary(abs);
        acc.totalBytes += content.length;
        if (acc.totalBytes > MAX_UNCOMPRESSED_BYTES) {
          throw new Error("size_exceeded");
        }
        results.push({ relativePath: rel, content });
      } catch (e) {
        if (e instanceof Error && e.message === "size_exceeded") throw e;
        // Skip unreadable files — they shouldn't break the bundle.
      }
    }
  }
  return results;
}

/**
 * Build a manifest describing the bundle origin. Helps whoever reads the
 * archive later (typically the developer triaging a bug) understand what
 * machine produced it and when. Absolute paths are deliberately omitted —
 * they leak the user's home directory layout (and on Windows, the
 * username).
 */
function buildManifest(args: {
  campaignName: string;
  campaignSlug: string;
}): string {
  const manifest = {
    collectedAt: new Date().toISOString(),
    campaignName: args.campaignName,
    campaignSlug: args.campaignSlug,
    platform: process.platform,
    nodeVersion: process.version,
  };
  return JSON.stringify(manifest, null, 2);
}

/**
 * Collect a diagnostics bundle. Includes:
 *  - The current campaign folder (under `campaign/`) — captures per-campaign
 *    `.debug/`, state, config, characters. The campaign's `.git/` is skipped.
 *  - The top-level `.debug/` folder (under `.debug/`) — engine.jsonl,
 *    server.log, top-level context dumps.
 *  - A `manifest.json` at the root of the archive.
 *
 * The bundle is written to `<homeDir>/diagnostics/<campaignSlug>-<ts>.mvdiag`.
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
    const acc = { totalBytes: 0 };

    // 1. Walk the campaign folder (skips .git).
    const campaignFiles = await walkForDiagnostics(io, norm(campaignRoot), "", acc);
    for (const f of campaignFiles) {
      fileMap[`campaign/${f.relativePath}`] = f.content;
    }

    // 2. Walk the top-level .debug folder (may not exist in test envs).
    const debugRoot = norm(join(homeDir, DEBUG_DIR));
    if (await io.exists(debugRoot)) {
      const debugFiles = await walkForDiagnostics(io, debugRoot, "", acc);
      for (const f of debugFiles) {
        fileMap[`${DEBUG_DIR}/${f.relativePath}`] = f.content;
      }
    }

    // Empty bundle is a configuration error worth surfacing.
    if (Object.keys(fileMap).length === 0) {
      return { ok: false, error: "Nothing to collect — campaign and .debug folders are empty or unreadable." };
    }

    // 3. Add manifest. Only safe-to-share metadata — no absolute paths.
    const campaignName = await readCampaignName(norm(campaignRoot), io);
    fileMap["manifest.json"] = new TextEncoder().encode(buildManifest({
      campaignName,
      campaignSlug: basename(norm(campaignRoot)),
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
    if (e instanceof Error && e.message === "size_exceeded") {
      const mb = Math.round(MAX_UNCOMPRESSED_BYTES / (1024 * 1024));
      return { ok: false, error: `Diagnostics bundle exceeds the ${mb} MB cap — share the campaign folder directly instead.` };
    }
    return { ok: false, error: e instanceof Error ? e.message : "Diagnostics collection failed." };
  }
}
