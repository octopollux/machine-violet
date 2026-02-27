/**
 * Parser for .theme asset files.
 * INI-like format with [section] headers and literal ASCII art content.
 */

import {
  type ThemeAsset,
  type ThemeComponent,
  type ComponentName,
  REQUIRED_COMPONENTS,
} from "./types.js";

/** Compute display width of a string (approximate — counts chars, skips ANSI). */
function displayWidth(s: string): number {
  // Strip ANSI escape sequences
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * Parse a .theme file content into a ThemeAsset.
 * Validates that all required components are present and row counts match @height.
 */
export function parseThemeAsset(content: string): ThemeAsset {
  // Normalize line endings
  const lines = content.replace(/\r\n/g, "\n").split("\n");

  // --- Parse metadata ---
  let name = "";
  let genreTags: string[] = [];
  let height = 1;

  const components = new Map<string, string[]>();
  let currentSection: string | null = null;
  let currentRows: string[] = [];

  for (const line of lines) {
    // Metadata line
    if (line.startsWith("@")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(1, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();

      switch (key) {
        case "name":
          name = value;
          break;
        case "genre_tags":
          genreTags = value.split(",").map((s) => s.trim()).filter(Boolean);
          break;
        case "height":
          height = parseInt(value, 10);
          if (isNaN(height) || height < 1) {
            throw new Error(`Invalid @height: ${value}`);
          }
          break;
      }
      continue;
    }

    // Section header
    const sectionMatch = line.match(/^\[([a-z_]+)\]$/);
    if (sectionMatch) {
      // Save previous section
      if (currentSection !== null) {
        components.set(currentSection, currentRows);
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
    components.set(currentSection, currentRows);
  }

  if (!name) {
    throw new Error("Theme file missing @name metadata");
  }

  // --- Build ThemeComponent records ---
  const result: Partial<Record<ComponentName, ThemeComponent>> = {};

  // Components that are NOT height-constrained
  const heightExempt = new Set<string>(["turn_separator"]);

  for (const compName of REQUIRED_COMPONENTS) {
    const rows = components.get(compName);
    if (!rows) {
      throw new Error(`Theme "${name}" missing required component: [${compName}]`);
    }

    // Strip trailing empty rows
    const trimmedRows = [...rows];
    while (trimmedRows.length > 0 && trimmedRows[trimmedRows.length - 1].trim() === "") {
      trimmedRows.pop();
    }

    // Validate row count against @height (except for exempt components)
    if (!heightExempt.has(compName)) {
      if (trimmedRows.length !== height) {
        throw new Error(
          `Theme "${name}" component [${compName}] has ${trimmedRows.length} row(s), expected ${height}`,
        );
      }
    }

    // Pad rows to equal width
    const maxWidth = Math.max(...trimmedRows.map(displayWidth), 0);
    const paddedRows = trimmedRows.map((row) => {
      const pad = maxWidth - displayWidth(row);
      return pad > 0 ? row + " ".repeat(pad) : row;
    });

    result[compName] = {
      rows: paddedRows,
      width: maxWidth,
      height: paddedRows.length,
    };
  }

  return {
    name,
    genreTags,
    height,
    components: result as Record<ComponentName, ThemeComponent>,
  };
}
