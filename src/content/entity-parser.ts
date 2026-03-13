/**
 * Entity parser — parse Haiku extractor output into DraftEntity objects.
 *
 * Haiku outputs entities separated by `--- ENTITY ---` delimiters.
 * Each entity has header fields (Name, Category, Slug) followed by
 * **Key:** Value front matter and body content.
 *
 * Format:
 * ```
 * --- ENTITY ---
 * Name: Goblin
 * Category: characters
 * Slug: goblin
 *
 * **Type:** Monster
 * **CR:** 1/4
 *
 * Body text here...
 * ```
 */

import type { DraftEntity, EntityCategory } from "./processing-types.js";

const ENTITY_DELIMITER = /^---\s*ENTITY\s*---\s*$/m;
const HEADER_PATTERN = /^([A-Za-z]+):\s*(.+)$/;
const FRONT_MATTER_PATTERN = /^\*\*([^*]+):\*\*\s*(.*)$/;

const VALID_CATEGORIES = new Set<EntityCategory>([
  "characters",
  "locations",
  "lore",
  "rules",
  "factions",
]);

/**
 * Parse raw Haiku output into DraftEntity objects.
 *
 * @param raw - Raw text output containing entities separated by `--- ENTITY ---`.
 * @param sourceSection - Optional source section title for provenance.
 * @returns Array of parsed entities. Malformed entities are silently skipped.
 */
export function parseEntities(raw: string, sourceSection?: string): DraftEntity[] {
  const blocks = raw.split(ENTITY_DELIMITER).filter((b) => b.trim().length > 0);
  const entities: DraftEntity[] = [];

  for (const block of blocks) {
    const entity = parseOneEntity(block.trim(), sourceSection);
    if (entity) entities.push(entity);
  }

  return entities;
}

/**
 * Parse a single entity block into a DraftEntity.
 * Returns null if the block is malformed (missing required headers).
 */
function parseOneEntity(block: string, sourceSection?: string): DraftEntity | null {
  const lines = block.split("\n");
  let i = 0;

  // Parse headers (Name, Category, Slug)
  const headers: Record<string, string> = {};
  while (i < lines.length) {
    const match = lines[i].match(HEADER_PATTERN);
    if (match) {
      headers[match[1].toLowerCase()] = match[2].trim();
      i++;
    } else if (lines[i].trim() === "") {
      i++;
      break;
    } else {
      break;
    }
  }

  // Validate required headers
  const name = headers["name"];
  const categoryRaw = headers["category"];
  const slug = headers["slug"];

  if (!name || !slug) return null;

  // Normalize category — default to "lore" if missing or invalid
  const category = (VALID_CATEGORIES.has(categoryRaw as EntityCategory)
    ? categoryRaw
    : "lore") as EntityCategory;

  // Parse front matter (**Key:** Value lines)
  const frontMatter: Record<string, string> = {};
  while (i < lines.length) {
    const match = lines[i].match(FRONT_MATTER_PATTERN);
    if (match) {
      const key = match[1].trim().toLowerCase().replace(/\s+/g, "_");
      frontMatter[key] = match[2].trim();
      i++;
    } else {
      break;
    }
  }

  // Everything remaining is body
  const body = lines.slice(i).join("\n").trim();

  return {
    name,
    category,
    slug,
    frontMatter,
    body,
    sourceSection,
  };
}
