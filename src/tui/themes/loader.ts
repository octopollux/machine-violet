/**
 * Theme asset loader.
 * Sync read + cache pattern, same as loadPrompt().
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { ThemeAsset } from "./types.js";
import { parseThemeAsset } from "./parser.js";

const cache = new Map<string, ThemeAsset>();

/** Directory containing built-in .theme files. */
function assetsDir(): string {
  return join(import.meta.dirname, "assets");
}

/**
 * Load a built-in theme by name.
 * @param name - Theme name without .theme extension (e.g. "gothic")
 */
export function loadBuiltinTheme(name: string): ThemeAsset {
  const cached = cache.get(name);
  if (cached) return cached;

  const filePath = join(assetsDir(), `${name}.theme`);
  const content = readFileSync(filePath, "utf-8");
  const asset = parseThemeAsset(content);
  cache.set(name, asset);
  return asset;
}

/**
 * Load a custom theme from an absolute file path.
 * @param path - Absolute path to a .theme file
 */
export function loadCustomTheme(path: string): ThemeAsset {
  const cached = cache.get(path);
  if (cached) return cached;

  const content = readFileSync(path, "utf-8");
  const asset = parseThemeAsset(content);
  cache.set(path, asset);
  return asset;
}

/** List available built-in theme names. */
export function listBuiltinThemes(): string[] {
  const dir = assetsDir();
  return readdirSync(dir)
    .filter((f) => f.endsWith(".theme"))
    .map((f) => f.replace(/\.theme$/, ""));
}

/** Clear the theme cache. For testing only. */
export function resetThemeCache(): void {
  cache.clear();
}
