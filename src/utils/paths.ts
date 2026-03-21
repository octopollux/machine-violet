import { dirname, join } from "node:path";
import { defaultConfigDir } from "../tools/filesystem/platform.js";

/** Normalize a path to use forward slashes (cross-platform). */
export function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

/** True when running inside a compiled standalone executable (Bun or Node SEA). */
export function isCompiled(): boolean {
  // Node SEA detection
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sea = require("node:sea");
    if (sea.isSea()) return true;
  } catch { /* not in SEA — continue */ }

  // Legacy Bun detection
  const meta = import.meta.dirname;
  return meta.includes("$bunfs") || meta.includes("~BUN");
}

/**
 * Resolve the directory for a named asset category.
 *
 * Compiled binary layout (next to the exe):
 *   prompts/  themes/  systems/
 *
 * Dev layout (repo root):
 *   src/prompts/  src/tui/themes/assets/  systems/
 */
const _cache = new Map<string, string>();
const DEV_ASSET_DIRS: Record<string, string> = {
  prompts: "src/prompts",
  themes: "src/tui/themes/assets",
  systems: "systems",
};

export function assetDir(category: "prompts" | "themes" | "systems"): string {
  const cached = _cache.get(category);
  if (cached) return cached;

  let dir: string;
  if (isCompiled()) {
    dir = join(dirname(process.execPath), category);
  } else {
    // src/utils/paths.ts → repo root is ../..
    const repoRoot = norm(dirname(dirname(import.meta.dirname)));
    dir = join(repoRoot, DEV_ASSET_DIRS[category]);
  }

  _cache.set(category, dir);
  return dir;
}

/**
 * Resolve the directory for user config files (.env, api-keys.json, config.json).
 *
 * Compiled: platform-conventional config dir (e.g. %APPDATA%\MachineViolet).
 * Dev: process.cwd() (repo root, where .env already lives).
 */
let _configDir: string | undefined;

export function configDir(): string {
  if (_configDir) return _configDir;
  _configDir = isCompiled() ? defaultConfigDir() : process.cwd();
  return _configDir;
}

/** Reset the configDir cache (for tests). */
export function resetConfigDir(): void {
  _configDir = undefined;
}
