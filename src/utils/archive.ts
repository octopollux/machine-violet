/**
 * Zip/unzip utility for campaign archival, sharing, and import.
 *
 * Uses `fflate` (pure JS, zero dependencies) for synchronous zip operations.
 * Designed for sub-megabyte payloads — no streaming needed.
 *
 * - `zipFiles(files)` packs a filename→content map into a zip buffer.
 * - `unzipFiles(data)` unpacks a zip buffer into a filename→content map.
 * - `setArchiveIO()` swaps the implementation for tests.
 */

import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";

/** A flat map of relative paths to file contents (UTF-8 strings). */
export type FileMap = Record<string, string>;

export interface ArchiveIO {
  zip(files: FileMap): Uint8Array;
  unzip(data: Uint8Array): FileMap;
}

/**
 * Normalize and validate an archive entry path. Returns the sanitized path,
 * or `null` if the path is unsafe (traversal, absolute, NUL bytes).
 */
export function sanitizePath(raw: string): string | null {
  if (raw.includes("\0")) return null;
  const normalized = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  // Reject Windows drive letters (e.g. "C:/...")
  if (/^[A-Za-z]:/.test(normalized)) return null;
  const parts = normalized.split("/").filter((p) => p && p !== ".");
  if (parts.length === 0) return null;
  if (parts.some((p) => p === "..")) return null;
  return parts.join("/");
}

const defaultArchiveIO: ArchiveIO = {
  zip(files: FileMap): Uint8Array {
    const entries: Record<string, Uint8Array> = {};
    for (const [path, content] of Object.entries(files)) {
      const safe = sanitizePath(path);
      if (safe === null) throw new Error(`Unsafe archive path: ${path}`);
      entries[safe] = strToU8(content);
    }
    return zipSync(entries);
  },

  unzip(data: Uint8Array): FileMap {
    const entries = unzipSync(data);
    const files: FileMap = {};
    for (const [path, content] of Object.entries(entries)) {
      const safe = sanitizePath(path);
      if (safe === null) continue; // silently skip unsafe entries
      files[safe] = strFromU8(content);
    }
    return files;
  },
};

let active: ArchiveIO = defaultArchiveIO;

/**
 * Replace the active ArchiveIO (for tests).
 * Pass `null` to reset to the default fflate implementation.
 */
export function setArchiveIO(io: ArchiveIO | null): void {
  active = io ?? defaultArchiveIO;
}

/**
 * Zip a map of `{ relativePath: utf8Content }` into a Uint8Array.
 * Returns `null` on failure. Never throws.
 */
export function zipFiles(files: FileMap): Uint8Array | null {
  try {
    return active.zip(files);
  } catch {
    return null;
  }
}

/**
 * Unzip a buffer into a map of `{ relativePath: utf8Content }`.
 * Returns `null` on failure (e.g. corrupt data). Never throws.
 */
export function unzipFiles(data: Uint8Array): FileMap | null {
  try {
    return active.unzip(data);
  } catch {
    return null;
  }
}
