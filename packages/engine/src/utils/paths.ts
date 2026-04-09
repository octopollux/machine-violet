import { dirname, join } from "node:path";
import { defaultConfigDir } from "../tools/filesystem/platform.js";

/** Normalize a path to use forward slashes (cross-platform). */
export function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

/** True when running inside a compiled standalone executable (Node SEA). */
export function isCompiled(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sea = require("node:sea");
    if (sea.isSea()) return true;
  } catch { /* not in SEA */ }

  return false;
}

/**
 * Resolve the directory for a named asset category.
 *
 * Compiled binary layout (next to the exe):
 *   prompts/  themes/  systems/  worlds/  config/
 *
 * Dev layout (packages/engine package root):
 *   src/prompts/           — prompts live inside this package
 *   src/config/            — shipped JSON config (known-models.json)
 *   ../../systems/         — systems/ is at the monorepo root
 *   ../../worlds/          — .mvworld seed files at the monorepo root
 *   ../../src/tui/themes/assets/ — themes are in the monolith TUI (engine doesn't use this)
 */
const _cache = new Map<string, string>();

// Paths relative to the *package* root (packages/engine/)
const DEV_ASSET_DIRS: Record<string, string> = {
  prompts: "src/prompts",
  themes: "../../src/tui/themes/assets",
  systems: "../../systems",
  worlds: "../../worlds",
  config: "src/config",
};

export function assetDir(category: "prompts" | "themes" | "systems" | "worlds" | "config"): string {
  const cached = _cache.get(category);
  if (cached) return cached;

  let dir: string;
  if (isCompiled()) {
    dir = join(dirname(process.execPath), category);
  } else {
    // packages/engine/src/utils/paths.ts → package root is ../..
    const pkgRoot = norm(dirname(dirname(import.meta.dirname)));
    dir = join(pkgRoot, DEV_ASSET_DIRS[category]);
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

/**
 * Resolve a relative path within a campaign root, rejecting traversal.
 * Normalizes backslashes to forward slashes and strips leading slashes.
 * Throws if any path component is `..`.
 */
export function resolveCampaignPath(campaignRoot: string, relative: string): string {
  const normalized = relative.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..")) {
    throw new Error("Path traversal not allowed");
  }
  const root = norm(campaignRoot).replace(/\/+$/, "");
  return parts.length === 0 ? root : root + "/" + parts.join("/");
}
