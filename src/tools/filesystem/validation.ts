import type { MapData } from "../../types/maps.js";
import type { ClocksState } from "../../types/clocks.js";
import { extractWikilinks } from "./wikilinks.js";
import { parseFrontMatter } from "./frontmatter.js";
import { norm } from "../../utils/paths.js";

export interface ValidationError {
  file: string;
  message: string;
  severity: "error" | "warning";
}

// --- Wikilink Integrity ---

/**
 * Check all wikilinks in a set of files against a set of known file paths.
 * Returns errors for dead links (links pointing to non-existent files).
 */
export function validateWikilinks(
  files: { path: string; content: string }[],
  existingPaths: Set<string>,
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const file of files) {
    const links = extractWikilinks(file.content);
    for (const link of links) {
      // Resolve relative path from the file's directory
      const resolved = resolveRelativePath(file.path, link.target);
      if (!existingPaths.has(resolved)) {
        errors.push({
          file: file.path,
          message: `Dead link: [${link.display}](${link.target}) at line ${link.line} → ${resolved}`,
          severity: "warning", // Dead links are valid by design but worth flagging
        });
      }
    }
  }

  return errors;
}

// --- Entity File Format ---

/**
 * Validate entity file format: must have a title and at least a Type field.
 */
export function validateEntityFile(
  path: string,
  content: string,
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (content.trim().length === 0) {
    errors.push({ file: path, message: "Empty file", severity: "error" });
    return errors;
  }

  const { frontMatter } = parseFrontMatter(content);

  if (!frontMatter._title) {
    errors.push({
      file: path,
      message: "Missing H1 title (# Title)",
      severity: "error",
    });
  }

  if (!frontMatter.type) {
    errors.push({
      file: path,
      message: "Missing **Type:** field in front matter",
      severity: "warning",
    });
  }

  return errors;
}

// --- JSON Format ---

/**
 * Validate that a string is valid JSON.
 */
export function validateJson(
  path: string,
  content: string,
): ValidationError[] {
  try {
    JSON.parse(content);
    return [];
  } catch (e) {
    return [
      {
        file: path,
        message: `Invalid JSON: ${(e as Error).message}`,
        severity: "error",
      },
    ];
  }
}

// --- Map Consistency ---

/**
 * Validate map data: entities on the map should have corresponding character files.
 * Also checks that entity positions are within bounds.
 */
export function validateMap(
  mapPath: string,
  map: MapData,
  existingCharacterFiles: Set<string>,
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const [coord, entities] of Object.entries(map.entities)) {
    // Check bounds
    const [x, y] = coord.split(",").map(Number);
    if (x < 0 || x >= map.bounds.width || y < 0 || y >= map.bounds.height) {
      errors.push({
        file: mapPath,
        message: `Entity at ${coord} is out of bounds (map is ${map.bounds.width}x${map.bounds.height})`,
        severity: "error",
      });
    }

    // Check entity files exist (PCs and named NPCs)
    for (const entity of entities) {
      if (entity.id.startsWith("PC:")) {
        const charName = entity.id.slice(3).toLowerCase();
        if (!existingCharacterFiles.has(charName)) {
          errors.push({
            file: mapPath,
            message: `PC entity "${entity.id}" at ${coord} has no character file (expected "${charName}")`,
            severity: "warning",
          });
        }
      }
    }
  }

  return errors;
}

// --- Clock Integrity ---

/**
 * Validate clock state: alarms should fire in the future,
 * calendar time should be non-negative.
 */
export function validateClocks(
  clocks: ClocksState,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const file = "clocks";

  if (clocks.calendar.current < 0) {
    errors.push({
      file,
      message: `Calendar time is negative: ${clocks.calendar.current}`,
      severity: "error",
    });
  }

  for (const alarm of clocks.calendar.alarms) {
    if (alarm.fires_at <= clocks.calendar.current) {
      errors.push({
        file,
        message: `Calendar alarm "${alarm.id}" (${alarm.message}) fires_at ${alarm.fires_at} is at or before current time ${clocks.calendar.current}`,
        severity: "warning",
      });
    }
  }

  if (clocks.combat.active && clocks.combat.current < 0) {
    errors.push({
      file,
      message: `Combat round counter is negative: ${clocks.combat.current}`,
      severity: "error",
    });
  }

  for (const alarm of clocks.combat.alarms) {
    if (alarm.fires_at <= clocks.combat.current) {
      errors.push({
        file,
        message: `Combat alarm "${alarm.id}" (${alarm.message}) fires_at ${alarm.fires_at} is at or before current round ${clocks.combat.current}`,
        severity: "warning",
      });
    }
  }

  return errors;
}

// --- Helpers ---

/**
 * Resolve a relative path from a file's directory.
 * Handles "../" navigation. Uses forward slashes for consistency.
 */
export function resolveRelativePath(
  fromFile: string,
  relativePath: string,
): string {
  const normalized = norm(fromFile);
  const parts = normalized.split("/");
  parts.pop(); // Remove filename, keep directory

  const relParts = norm(relativePath).split("/");
  for (const part of relParts) {
    if (part === "..") {
      parts.pop();
    } else if (part !== ".") {
      parts.push(part);
    }
  }

  return parts.join("/");
}
