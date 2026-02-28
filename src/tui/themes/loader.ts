/**
 * Theme asset loader.
 * Sync read + cache pattern, same as loadPrompt().
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { ThemeAsset, PlayerPaneFrame } from "./types.js";
import { parseThemeAsset, parsePlayerPaneFrame } from "./parser.js";

const cache = new Map<string, ThemeAsset>();
const playerFrameCache = new Map<string, PlayerPaneFrame>();

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

/**
 * Load a built-in player pane frame by name.
 * @param name - Frame name without .player-frame extension (e.g. "default")
 */
export function loadBuiltinPlayerFrame(name: string): PlayerPaneFrame {
  const cached = playerFrameCache.get(name);
  if (cached) return cached;

  const filePath = join(assetsDir(), `${name}.player-frame`);
  const content = readFileSync(filePath, "utf-8");
  const frame = parsePlayerPaneFrame(content);
  playerFrameCache.set(name, frame);
  return frame;
}

/** List available built-in theme names. */
export function listBuiltinThemes(): string[] {
  const dir = assetsDir();
  return readdirSync(dir)
    .filter((f) => f.endsWith(".theme"))
    .map((f) => f.replace(/\.theme$/, ""));
}

/** Clear all theme caches. For testing only. */
export function resetThemeCache(): void {
  cache.clear();
  playerFrameCache.clear();
}
