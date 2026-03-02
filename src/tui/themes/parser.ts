/**
 * Parser for .theme and .player-frame asset files.
 * INI-like format with [section] headers and literal ASCII art content.
 * Supports HTML-style comments (<!-- ... -->) and [colors]/[variant_*] config sections.
 */

import {
  type ThemeAsset,
  type ThemeComponent,
  type ComponentName,
  type PlayerPaneFrame,
  type PlayerPaneComponentName,
  type SwatchConfig,
  type ThemeColorMap,
  type GradientConfig,
  type StyleVariant,
  type VariantOverride,
  REQUIRED_COMPONENTS,
  PLAYER_PANE_COMPONENTS,
  PLAYER_PANE_EDGE_COMPONENTS,
} from "./types.js";

/** Compute display width of a string (approximate — counts chars, skips ANSI). */
function displayWidth(s: string): number {
  // Strip ANSI escape sequences
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Parsed metadata and raw sections from an INI-like asset file. */
export interface ParsedSections {
  metadata: Record<string, string>;
  sections: Map<string, string[]>;
}

/** Color/gradient/variant config extracted from a .theme file. */
export interface ThemeFileConfig {
  swatchConfig?: Partial<SwatchConfig>;
  colorMap?: Partial<ThemeColorMap>;
  gradient?: GradientConfig | null;
  playerFrameName?: string;
  variants?: Partial<Record<StyleVariant, VariantOverride>>;
}

/**
 * Parse the INI-like structure shared by .theme and .player-frame files.
 * Returns raw metadata key/value pairs and section name → row content.
 * HTML comments (<!-- ... -->) are stripped before processing.
 */
export function parseSections(content: string): ParsedSections {
  const lines = content.replace(/\r\n/g, "\n").split("\n");

  const metadata: Record<string, string> = {};
  const sections = new Map<string, string[]>();
  let currentSection: string | null = null;
  let currentRows: string[] = [];
  let inComment = false;

  for (const line of lines) {
    // Comment handling
    if (inComment) {
      if (line.includes("-->")) {
        inComment = false;
      }
      continue;
    }
    if (line.includes("<!--")) {
      if (!line.includes("-->")) {
        inComment = true;
      }
      // Single-line comment (contains both <!-- and -->) or opening line: skip
      continue;
    }

    // Metadata line
    if (line.startsWith("@")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(1, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      metadata[key] = value;
      continue;
    }

    // Section header
    const sectionMatch = line.match(/^\[([a-z_]+)\]$/);
    if (sectionMatch) {
      if (currentSection !== null) {
        sections.set(currentSection, currentRows);
      }
      currentSection = sectionMatch[1];
      currentRows = [];
      continue;
    }

    // Content line (only if inside a section)
    if (currentSection !== null) {
      currentRows.push(line);
    }
  }

  // Save last section
  if (currentSection !== null) {
    sections.set(currentSection, currentRows);
  }

  return { metadata, sections };
}

/**
 * Parse key: value lines from a config section's raw rows.
 * Skips blank lines and lines without a colon.
 */
export function parseConfigLines(lines: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

/** Color map keys in .theme files → ThemeColorMap property names. */
const COLOR_MAP_KEYS: Record<string, keyof ThemeColorMap> = {
  border: "border",
  corner: "corner",
  separator: "separator",
  title: "title",
  turn_indicator: "turnIndicator",
  side_frame: "sideFrame",
};

/**
 * Parse a single config section (colors or variant) into swatch/colorMap/gradient parts.
 */
function parseColorSection(kv: Record<string, string>): {
  swatchConfig?: Partial<SwatchConfig>;
  colorMap?: Partial<ThemeColorMap>;
  gradient?: GradientConfig | null;
} {
  let swatchConfig: Partial<SwatchConfig> | undefined;
  let colorMap: Partial<ThemeColorMap> | undefined;
  let gradient: GradientConfig | null | undefined;

  if (kv["preset"]) {
    swatchConfig = { ...swatchConfig, preset: kv["preset"] };
  }
  if (kv["harmony"]) {
    swatchConfig = { ...swatchConfig, harmony: kv["harmony"] as SwatchConfig["harmony"] };
  }

  if (kv["gradient"] !== undefined) {
    gradient = kv["gradient"] === "none" ? null : { preset: kv["gradient"] };
  }

  for (const [fileKey, mapKey] of Object.entries(COLOR_MAP_KEYS)) {
    if (kv[fileKey] !== undefined) {
      const n = parseInt(kv[fileKey], 10);
      if (!isNaN(n)) {
        colorMap = { ...colorMap, [mapKey]: n };
      }
    }
  }

  return {
    ...(swatchConfig ? { swatchConfig } : {}),
    ...(colorMap ? { colorMap } : {}),
    ...(gradient !== undefined ? { gradient } : {}),
  };
}

/**
 * Extract theme color/gradient/variant config from parsed sections.
 * Reads [colors] for base config and [variant_*] for per-variant overrides.
 * Also reads @player_frame metadata.
 */
export function extractThemeConfig(
  metadata: Record<string, string>,
  sections: Map<string, string[]>,
): ThemeFileConfig {
  const result: ThemeFileConfig = {};

  // @player_frame metadata
  if (metadata["player_frame"]) {
    result.playerFrameName = metadata["player_frame"];
  }

  // [colors] section → base swatch + color map + gradient
  const colorsRows = sections.get("colors");
  if (colorsRows) {
    const kv = parseConfigLines(colorsRows);
    const parsed = parseColorSection(kv);
    if (parsed.swatchConfig) result.swatchConfig = parsed.swatchConfig;
    if (parsed.colorMap) result.colorMap = parsed.colorMap;
    if (parsed.gradient !== undefined) result.gradient = parsed.gradient;
  }

  // [variant_*] sections → per-variant overrides
  for (const [sectionName, rows] of sections) {
    const variantMatch = sectionName.match(/^variant_(.+)$/);
    if (!variantMatch) continue;
    const variantName = variantMatch[1] as StyleVariant;
    const kv = parseConfigLines(rows);
    const parsed = parseColorSection(kv);
    const override: VariantOverride = {};
    if (parsed.swatchConfig) override.swatchConfig = parsed.swatchConfig;
    if (parsed.colorMap) override.colorMap = parsed.colorMap;
    if (parsed.gradient !== undefined) override.gradient = parsed.gradient;
    if (Object.keys(override).length > 0) {
      result.variants = { ...result.variants, [variantName]: override };
    }
  }

  return result;
}

/**
 * Build a ThemeComponent from raw rows: trim trailing empties, validate height, pad widths.
 */
function buildComponent(
  name: string,
  compName: string,
  rows: string[],
  expectedHeight: number | null,
): ThemeComponent {
  // Strip trailing empty rows
  const trimmedRows = [...rows];
  while (trimmedRows.length > 0 && trimmedRows[trimmedRows.length - 1].trim() === "") {
    trimmedRows.pop();
  }

  // Validate row count if height constraint is given
  if (expectedHeight !== null && trimmedRows.length !== expectedHeight) {
    throw new Error(
      `Theme "${name}" component [${compName}] has ${trimmedRows.length} row(s), expected ${expectedHeight}`,
    );
  }

  // Pad rows to equal width
  const maxWidth = Math.max(...trimmedRows.map(displayWidth), 0);
  const paddedRows = trimmedRows.map((row) => {
    const pad = maxWidth - displayWidth(row);
    return pad > 0 ? row + " ".repeat(pad) : row;
  });

  return {
    rows: paddedRows,
    width: maxWidth,
    height: paddedRows.length,
  };
}

/** Config section names that should not be treated as visual components. */
const CONFIG_SECTIONS = new Set(["colors"]);
const CONFIG_SECTION_PREFIX = "variant_";

function isConfigSection(name: string): boolean {
  return CONFIG_SECTIONS.has(name) || name.startsWith(CONFIG_SECTION_PREFIX);
}

/**
 * Build a ThemeAsset from pre-parsed sections.
 * Config sections ([colors], [variant_*]) are skipped — only art sections are processed.
 */
function buildThemeAsset(parsed: ParsedSections): ThemeAsset {
  const { metadata, sections } = parsed;

  const name = metadata["name"] ?? "";
  const genreTags = metadata["genre_tags"]
    ? metadata["genre_tags"].split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  let height = 1;
  if (metadata["height"]) {
    height = parseInt(metadata["height"], 10);
    if (isNaN(height) || height < 1) {
      throw new Error(`Invalid @height: ${metadata["height"]}`);
    }
  }

  if (!name) {
    throw new Error("Theme file missing @name metadata");
  }

  // Only corners are height-constrained to @height.
  // Edges tile to fill (composer uses rows[r] ?? "" / i % height),
  // separators use rows[r] ?? "" fallback, and turn_separator is freeform.
  const heightConstrained = new Set<string>([
    "corner_tl",
    "corner_tr",
    "corner_bl",
    "corner_br",
  ]);

  const result: Partial<Record<ComponentName, ThemeComponent>> = {};

  for (const compName of REQUIRED_COMPONENTS) {
    const rows = sections.get(compName);
    if (!rows) {
      throw new Error(`Theme "${name}" missing required component: [${compName}]`);
    }

    const expectedHeight = heightConstrained.has(compName) ? height : null;
    result[compName] = buildComponent(name, compName, rows, expectedHeight);
  }

  return {
    name,
    genreTags,
    height,
    components: result as Record<ComponentName, ThemeComponent>,
  };
}

/**
 * Parse a .theme file content into a ThemeAsset.
 * Validates that all required components are present and row counts match @height.
 * Accepts either raw content string or pre-parsed ParsedSections.
 */
export function parseThemeAsset(input: string | ParsedSections): ThemeAsset {
  const parsed = typeof input === "string" ? parseSections(input) : input;

  // Filter out config sections so they don't interfere with component parsing
  const artSections = new Map<string, string[]>();
  for (const [name, rows] of parsed.sections) {
    if (!isConfigSection(name)) {
      artSections.set(name, rows);
    }
  }

  return buildThemeAsset({ metadata: parsed.metadata, sections: artSections });
}

/**
 * Parse a .player-frame file content into a PlayerPaneFrame.
 * Corner components are required (any height). Edge components are optional —
 * when absent or empty they default to a single space (renders as blank).
 */
export function parsePlayerPaneFrame(content: string): PlayerPaneFrame {
  const { metadata, sections } = parseSections(content);

  const name = metadata["name"] ?? "";
  if (!name) {
    throw new Error("Player frame file missing @name metadata");
  }

  const result: Partial<Record<PlayerPaneComponentName, ThemeComponent>> = {};

  for (const compName of PLAYER_PANE_COMPONENTS) {
    const rows = sections.get(compName);
    const isEdge = PLAYER_PANE_EDGE_COMPONENTS.has(compName);

    // Check if section is absent or effectively empty
    const isEmpty = !rows || rows.every((r) => r.trim() === "");

    if (isEmpty && isEdge) {
      // Optional edge defaults to a single space (renders as blank)
      result[compName] = { rows: [" "], width: 1, height: 1 };
      continue;
    }

    if (!rows) {
      throw new Error(`Player frame "${name}" missing required component: [${compName}]`);
    }

    // No height constraint — corners can be multi-row, edges are not size-checked
    result[compName] = buildComponent(name, compName, rows, null);
  }

  return {
    name,
    components: result as Record<PlayerPaneComponentName, ThemeComponent>,
  };
}
