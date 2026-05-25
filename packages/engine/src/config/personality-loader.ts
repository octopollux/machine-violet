import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { assetDir } from "../utils/paths.js";
import type { DMPersonality } from "@machine-violet/shared/types/config.js";

/**
 * On-disk envelope for a bundled or user DM personality file (.mvdm).
 * The loader strips the envelope and returns the engine-level `DMPersonality`
 * shape, so consumers don't need to know about format/version.
 */
interface DMPersonalityFile {
  format: "machine-violet-dm";
  version: 1;
  name: string;
  description?: string;
  prompt_fragment: string;
  detail?: string;
}

/** Minimal structural validation — enough to reject corrupt files. */
function isValidPersonalityFile(data: unknown): data is DMPersonalityFile {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return (
    obj.format === "machine-violet-dm" &&
    obj.version === 1 &&
    typeof obj.name === "string" &&
    obj.name.length > 0 &&
    typeof obj.prompt_fragment === "string" &&
    obj.prompt_fragment.length > 0 &&
    (obj.description === undefined || typeof obj.description === "string") &&
    (obj.detail === undefined || typeof obj.detail === "string")
  );
}

function toDMPersonality(file: DMPersonalityFile): DMPersonality {
  const out: DMPersonality = {
    name: file.name,
    prompt_fragment: file.prompt_fragment,
  };
  if (file.description !== undefined) out.description = file.description;
  if (file.detail !== undefined) out.detail = file.detail;
  return out;
}

/**
 * Scan a directory for .mvdm files. Returns parsed personalities.
 * @param dir Directory to scan.
 * @param strict If true, throws on parse/validation errors (for bundled seeds).
 *               If false, logs a warning and skips bad files (for user personalities).
 */
function scanDir(dir: string, strict: boolean): DMPersonality[] {
  if (!existsSync(dir)) {
    if (strict) throw new Error(`Bundled personalities directory not found: ${dir}`);
    return [];
  }

  const results: DMPersonality[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".mvdm"));
  } catch (e) {
    if (strict) throw e;
    return [];
  }

  for (const file of entries) {
    const filePath = join(dir, file);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const data: unknown = JSON.parse(raw);
      if (!isValidPersonalityFile(data)) {
        if (strict) {
          throw new Error(`Invalid personality file: ${filePath} (failed schema validation)`);
        }
        console.warn(`[personalities] Skipping user personality ${filePath}: failed schema validation.`);
        continue;
      }
      results.push(toDMPersonality(data));
    } catch (e) {
      if (strict) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[personalities] Skipping user personality ${filePath}: ${msg}`);
    }
  }
  return results;
}

/**
 * Load all available DM personalities: bundled + user.
 * Bundled personalities are validated strictly (errors throw).
 * User personalities are validated leniently (bad files skipped).
 * User entries override bundled by name.
 */
export function loadAllPersonalities(userPersonalitiesDir?: string): DMPersonality[] {
  const bundled = scanDir(assetDir("personalities"), true);
  const user = userPersonalitiesDir ? scanDir(userPersonalitiesDir, false) : [];

  const byName = new Map<string, DMPersonality>();
  for (const p of bundled) byName.set(p.name, p);
  for (const p of user) byName.set(p.name, p);
  return [...byName.values()];
}

/** Look up a personality by display name. Returns undefined if not found. */
export function getPersonality(name: string, userPersonalitiesDir?: string): DMPersonality | undefined {
  return loadAllPersonalities(userPersonalitiesDir).find((p) => p.name === name);
}
