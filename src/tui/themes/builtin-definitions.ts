/**
 * Built-in theme definitions.
 * Theme-specific config now lives in .theme files; this module provides
 * the safe fallback default and a lazy cache of loaded definitions.
 */

import type { ThemeDefinition, ThemeColorMap } from "./types.js";
import { listBuiltinThemes } from "./loader.js";
import { loadThemeDefinition } from "./loader.js";

/** Default color map — swatch index assignments for frame parts. */
const DEFAULT_COLOR_MAP: ThemeColorMap = {
  border: 2,
  corner: 3,
  separator: 4,
  title: 5,
  turnIndicator: 6,
  sideFrame: 1,
};

/** Safe fallback definition used when a .theme file has no [colors] section. */
export const DEFAULT_DEFINITION: Omit<ThemeDefinition, "assetName"> = {
  swatchConfig: { preset: "foliage", harmony: "analogous" },
  colorMap: { ...DEFAULT_COLOR_MAP },
};

/** Lazily-populated record of all built-in theme definitions. */
let _builtinDefinitions: Record<string, ThemeDefinition> | null = null;

function ensureBuiltinDefinitions(): Record<string, ThemeDefinition> {
  if (!_builtinDefinitions) {
    _builtinDefinitions = {};
    for (const name of listBuiltinThemes()) {
      try {
        _builtinDefinitions[name] = loadThemeDefinition(name);
      } catch {
        // Skip themes that fail to load (e.g. malformed file)
      }
    }
  }
  return _builtinDefinitions;
}

/**
 * All built-in theme definitions, lazily loaded from .theme files.
 * API-compatible with the previous static Record for app.tsx and tests.
 */
export const BUILTIN_DEFINITIONS: Record<string, ThemeDefinition> = new Proxy(
  {} as Record<string, ThemeDefinition>,
  {
    get(_target, prop, _receiver) {
      if (typeof prop === "symbol") return undefined;
      const defs = ensureBuiltinDefinitions();
      return defs[prop];
    },
    has(_target, prop) {
      if (typeof prop === "symbol") return false;
      const defs = ensureBuiltinDefinitions();
      return prop in defs;
    },
    ownKeys() {
      return Object.keys(ensureBuiltinDefinitions());
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop === "symbol") return undefined;
      const defs = ensureBuiltinDefinitions();
      if (prop in defs) {
        return { configurable: true, enumerable: true, value: defs[prop], writable: false };
      }
      return undefined;
    },
  },
);

/** Get a built-in theme definition by name. */
export function getBuiltinDefinition(name: string): ThemeDefinition | undefined {
  try {
    return loadThemeDefinition(name);
  } catch {
    return undefined;
  }
}

/** List available built-in theme definition names. */
export function listBuiltinDefinitions(): string[] {
  return listBuiltinThemes();
}

/**
 * Reset the lazy definition cache.
 * Called by resetThemeCache() — not for direct use.
 */
export function resetBuiltinDefinitionsCache(): void {
  _builtinDefinitions = null;
}
