/**
 * Parser for .theme and .player-frame asset files.
 * INI-like format with [section] headers and literal ASCII art content.
 */

import {
  type ThemeAsset,
  type ThemeComponent,
  type ComponentName,
  type PlayerPaneFrame,
  type PlayerPaneComponentName,
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
interface ParsedSections {
  metadata: Record<string, string>;
  sections: Map<string, string[]>;
}

/**
 * Parse the INI-like structure shared by .theme and .player-frame files.
 * Returns raw metadata key/value pairs and section name → row content.
 */
export function parseSections(content: string): ParsedSections {
  const lines = content.replace(/\r\n/g, "\n").split("\n");

  const metadata: Record<string, string> = {};
  const sections = new Map<string, string[]>();
  let currentSection: string | null = null;
  let currentRows: string[] = [];

  for (const line of lines) {
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

/**
 * Parse a .theme file content into a ThemeAsset.
 * Validates that all required components are present and row counts match @height.
 */
export function parseThemeAsset(content: string): ThemeAsset {
  const { metadata, sections } = parseSections(content);

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

  // Components that are NOT height-constrained
  const heightExempt = new Set<string>(["turn_separator"]);

  const result: Partial<Record<ComponentName, ThemeComponent>> = {};

  for (const compName of REQUIRED_COMPONENTS) {
    const rows = sections.get(compName);
    if (!rows) {
      throw new Error(`Theme "${name}" missing required component: [${compName}]`);
    }

    const expectedHeight = heightExempt.has(compName) ? null : height;
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
