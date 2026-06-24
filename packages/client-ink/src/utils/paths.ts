import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defaultConfigDir } from "./platform.js";

/** Normalize a path to use forward slashes (cross-platform). */
function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

/** True when running inside a compiled standalone executable (Node SEA). */
function isCompiled(): boolean {
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
 * Resolve the directory for user config artifacts — anything the client
 * persists between runs that isn't campaign data. Today that includes
 * `client-settings.json` plus the engine-side files the launcher reads from
 * the same dir (`.env`, `connections.json`, `machine-settings.json`, etc.).
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

