/**
 * Facet builder — mechanical (no AI) index of entity front matter.
 *
 * Reads each entity .md file in every category directory, parses
 * **Key:** Value front matter lines, and writes a facets.json per category.
 */

import type { FileIO } from "../agents/scene-manager.js";
import type { EntityFacet, CategoryFacets } from "@machine-violet/shared/types/facets.js";
import { processingPaths } from "./processing-paths.js";

/** Same pattern used in entity-parser.ts and frontmatter.ts — inlined to avoid cross-boundary import. */
const FRONT_MATTER_PATTERN = /^\*\*([^*]+):\*\*\s*(.*)$/;

/**
 * Parse front matter from an entity markdown file into key-value pairs.
 * Keys are lowercased with spaces replaced by underscores.
 */
function extractFields(markdown: string): { name: string; fields: Record<string, string> } {
  const lines = markdown.split("\n");
  let i = 0;
  let name = "";

  // Skip leading blank lines
  while (i < lines.length && lines[i].trim() === "") i++;

  // Extract name from H1 heading
  if (i < lines.length && lines[i].startsWith("# ")) {
    name = lines[i].slice(2).trim();
    i++;
  }

  // Skip blank line after heading
  while (i < lines.length && lines[i].trim() === "") i++;

  // Parse **Key:** Value lines
  const fields: Record<string, string> = {};
  while (i < lines.length) {
    const match = lines[i].match(FRONT_MATTER_PATTERN);
    if (match) {
      const key = match[1].trim().toLowerCase().replace(/\s+/g, "_");
      fields[key] = match[2].trim();
      i++;
    } else {
      break;
    }
  }

  return { name, fields };
}

/**
 * Build facet indexes for all entity categories in a processed collection.
 *
 * @returns Map of category name → CategoryFacets (also writes facets.json files).
 */
export async function buildFacets(
  io: FileIO,
  homeDir: string,
  collectionSlug: string,
): Promise<Map<string, CategoryFacets>> {
  const paths = processingPaths(homeDir, collectionSlug);
  const result = new Map<string, CategoryFacets>();

  if (!(await io.exists(paths.entitiesDir))) return result;

  const categories = (await io.listDir(paths.entitiesDir)).sort();

  for (const cat of categories) {
    const catDir = paths.entityCategoryDir(cat);
    if (!(await io.exists(catDir))) continue;

    const files = await io.listDir(catDir);
    const mdFiles = files.filter((f) => f.endsWith(".md")).sort();
    if (mdFiles.length === 0) continue;

    const fieldKeySet = new Set<string>();
    const entities: EntityFacet[] = [];

    for (const file of mdFiles) {
      const filePath = paths.entityFile(cat, file.replace(/\.md$/, ""));
      const content = await io.readFile(filePath);
      const { name, fields } = extractFields(content);

      const slug = file.replace(/\.md$/, "");

      for (const key of Object.keys(fields)) {
        fieldKeySet.add(key);
      }

      entities.push({
        slug,
        name: name || slug,
        fields,
      });
    }

    const facets: CategoryFacets = {
      category: cat,
      fieldKeys: [...fieldKeySet].sort(),
      entities,
    };

    result.set(cat, facets);

    // Write facets.json
    const facetsPath = paths.facets(cat);
    await io.writeFile(facetsPath, JSON.stringify(facets, null, 2));
  }

  return result;
}
