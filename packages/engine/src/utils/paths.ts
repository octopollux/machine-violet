import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
 *   prompts/  themes/  systems/  worlds/  config/  assets/
 *
 * Dev layout (packages/engine package root):
 *   src/prompts/           — prompts live inside this package
 *   src/config/            — shipped JSON config (known-models.json)
 *   src/assets/            — bundled data assets (e.g. names/names.json)
 *   ../../systems/         — systems/ is at the monorepo root
 *   ../../worlds/          — .mvworld seed files at the monorepo root
 *   ../../personalities/   — .mvdm DM personality files at the monorepo root
 *   ../client-ink/src/tui/themes/assets/ — themes live in the TUI package
 */
const _cache = new Map<string, string>();

// Paths relative to the *package* root (packages/engine/)
const DEV_ASSET_DIRS: Record<string, string> = {
  prompts: "src/prompts",
  themes: "../client-ink/src/tui/themes/assets",
  systems: "../../systems",
  worlds: "../../worlds",
  personalities: "../../personalities",
  config: "src/config",
  assets: "src/assets",
};

export function assetDir(category: "prompts" | "themes" | "systems" | "worlds" | "personalities" | "config" | "assets"): string {
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
 * Resolve the directory for user config artifacts — anything the engine
 * persists between runs that isn't campaign data. Today that includes
 * `.env`, `connections.json`, `machine-settings.json`, `discord-settings.json`,
 * ChatGPT OAuth token storage, and (via client-ink) `client-settings.json`.
 *
 * Compiled: platform-conventional config dir (e.g. %APPDATA%\MachineViolet).
 * Dev: walk up from cwd looking for an ancestor containing `connections.json`
 * so a worktree picks up the parent repo's saved config. Falls back to cwd
 * (first-time setup writes there; move the file up once if you want it
 * shared across worktrees).
 */
let _configDir: string | undefined;

export function configDir(): string {
  if (_configDir) return _configDir;
  _configDir = isCompiled() ? defaultConfigDir() : findConfigDirUpward(process.cwd());
  return _configDir;
}

// Bounded so a stray cwd outside any project doesn't walk all the way to /.
// 12 comfortably covers nested worktrees in this repo's `.claude/worktrees/<name>` layout
// with headroom; matches the cap used by the test harness's launcher-cwd resolver.
const MAX_PARENT_TRAVERSALS = 12;

function findConfigDirUpward(start: string): string {
  let dir = resolve(start);
  for (let i = 0; i < MAX_PARENT_TRAVERSALS; i++) {
    if (existsSync(join(dir, "connections.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
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
