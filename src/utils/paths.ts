import { dirname, join } from "node:path";

/** Normalize a path to use forward slashes (cross-platform). */
export function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

/** True when running inside a Bun-compiled standalone executable. */
export function isCompiled(): boolean {
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
