import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { assetDir } from "../utils/paths.js";
import type { WorldFile } from "@machine-violet/shared/types/world.js";

/** Minimal structural validation — enough to reject corrupt files. */
function isValidWorldFile(data: unknown): data is WorldFile {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    obj.format === "machine-violet-world" &&
    obj.version === 1 &&
    typeof obj.name === "string" &&
    typeof obj.summary === "string" &&
    Array.isArray(obj.genres) &&
    obj.genres.every((g: unknown) => typeof g === "string")
  );
}

/** Summary shown in the setup prompt (no detail/suboptions). */
export interface WorldSummary {
  name: string;
  summary: string;
  genres: string[];
  description?: string;
  /** Slug derived from filename (e.g., "the-shattered-crown"). */
  slug: string;
  /** Whether this world has a detail block (so the setup agent knows it can load more). */
  hasDetail: boolean;
  /** Whether this world has suboptions. */
  hasSuboptions: boolean;
}

interface LoadedWorld {
  slug: string;
  world: WorldFile;
}

/**
 * Scan a directory for .mvworld files. Returns loaded worlds.
 * @param dir Directory to scan.
 * @param strict If true, throws on parse/validation errors (for bundled seeds).
 *               If false, logs a warning and skips bad files (for user worlds).
 */
function scanDir(dir: string, strict: boolean): LoadedWorld[] {
  if (!existsSync(dir)) return [];

  const results: LoadedWorld[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".mvworld"));
  } catch {
    return [];
  }

  for (const file of entries) {
    const slug = file.replace(/\.mvworld$/, "");
    const filePath = join(dir, file);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const data: unknown = JSON.parse(raw);
      if (!isValidWorldFile(data)) {
        if (strict) {
          throw new Error(`Invalid world file: ${filePath} (failed schema validation)`);
        }
        continue;
      }
      results.push({ slug, world: data });
    } catch (e) {
      if (strict) throw e;
      // User worlds: skip silently (or log in future)
    }
  }
  return results;
}

/**
 * Load all available worlds: bundled seeds + user worlds.
 * Bundled seeds are validated strictly (errors throw).
 * User worlds are validated leniently (bad files skipped).
 */
export function loadAllWorlds(userWorldsDir?: string): LoadedWorld[] {
  const bundled = scanDir(assetDir("worlds"), true);
  const user = userWorldsDir ? scanDir(userWorldsDir, false) : [];

  // User worlds can override bundled by slug
  const bySlug = new Map<string, LoadedWorld>();
  for (const w of bundled) bySlug.set(w.slug, w);
  for (const w of user) bySlug.set(w.slug, w);
  return [...bySlug.values()];
}

/** Build summary list for the setup prompt (lightweight, no detail blocks). */
export function worldSummaries(worlds: LoadedWorld[]): WorldSummary[] {
  return worlds.map(({ slug, world }) => ({
    name: world.name,
    summary: world.summary,
    genres: world.genres,
    description: world.description,
    slug,
    hasDetail: !!world.detail,
    hasSuboptions: !!world.suboptions?.length,
  }));
}

/** Load a specific world by slug. Returns undefined if not found. */
export function loadWorldBySlug(slug: string, userWorldsDir?: string): WorldFile | undefined {
  // Check user worlds first (override), then bundled
  if (userWorldsDir) {
    const userPath = join(userWorldsDir, `${slug}.mvworld`);
    if (existsSync(userPath)) {
      try {
        const data: unknown = JSON.parse(readFileSync(userPath, "utf-8"));
        if (isValidWorldFile(data)) return data;
      } catch { /* fall through to bundled */ }
    }
  }

  const bundledPath = join(assetDir("worlds"), `${slug}.mvworld`);
  if (existsSync(bundledPath)) {
    const data: unknown = JSON.parse(readFileSync(bundledPath, "utf-8"));
    if (isValidWorldFile(data)) return data;
  }

  return undefined;
}
