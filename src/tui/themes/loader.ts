/**
 * Theme asset loader.
 * Sync read + cache pattern, same as loadPrompt().
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { assetDir } from "../../utils/paths.js";
import type { ThemeAsset, PlayerPaneFrame, ThemeDefinition } from "./types.js";
import {
  parseSections,
  parseThemeAsset,
  parsePlayerPaneFrame,
  extractThemeConfig,
  type ParsedSections,
} from "./parser.js";
import { DEFAULT_DEFINITION, resetBuiltinDefinitionsCache } from "./builtin-definitions.js";

const cache = new Map<string, ThemeAsset>();
const playerFrameCache = new Map<string, PlayerPaneFrame>();
const parsedSectionsCache = new Map<string, ParsedSections>();
const definitionCache = new Map<string, ThemeDefinition>();

/** Directory containing built-in .theme files. */
function assetsDir(): string {
  return assetDir("themes");
}

/**
 * Load and cache parsed sections for a built-in theme file.
 * Shared by loadBuiltinTheme and loadThemeDefinition to avoid double-reading.
 */
function loadParsedSections(name: string): ParsedSections {
  const cached = parsedSectionsCache.get(name);
  if (cached) return cached;

  const filePath = join(assetsDir(), `${name}.theme`);
  const content = readFileSync(filePath, "utf-8");
  const parsed = parseSections(content);
  parsedSectionsCache.set(name, parsed);
  return parsed;
}

/**
 * Load a built-in theme by name.
 * @param name - Theme name without .theme extension (e.g. "gothic")
 */
export function loadBuiltinTheme(name: string): ThemeAsset {
  const cached = cache.get(name);
  if (cached) return cached;

  const parsed = loadParsedSections(name);
  const asset = parseThemeAsset(parsed);
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

/**
 * Load a ThemeDefinition from a built-in .theme file.
 * Reads [colors] + [variant_*] config sections and merges onto DEFAULT_DEFINITION.
 * @param name - Theme name without .theme extension
 */
export function loadThemeDefinition(name: string): ThemeDefinition {
  const cached = definitionCache.get(name);
  if (cached) return cached;

  const parsed = loadParsedSections(name);
  const fileConfig = extractThemeConfig(parsed.metadata, parsed.sections);

  const definition: ThemeDefinition = {
    ...DEFAULT_DEFINITION,
    assetName: name,
    swatchConfig: {
      ...DEFAULT_DEFINITION.swatchConfig,
      ...fileConfig.swatchConfig,
    },
    colorMap: {
      ...DEFAULT_DEFINITION.colorMap,
      ...fileConfig.colorMap,
    },
  };

  if (fileConfig.gradient !== undefined) {
    if (fileConfig.gradient === null) {
      // Explicitly no gradient — omit the key
      delete definition.gradient;
    } else {
      definition.gradient = fileConfig.gradient;
    }
  }

  if (fileConfig.playerFrameName) {
    definition.playerFrameName = fileConfig.playerFrameName;
  }

  if (fileConfig.variants) {
    definition.variants = fileConfig.variants;
  }

  definitionCache.set(name, definition);
  return definition;
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
  parsedSectionsCache.clear();
  definitionCache.clear();
  resetBuiltinDefinitionsCache();
}
