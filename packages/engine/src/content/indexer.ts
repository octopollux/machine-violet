/**
 * Stage 4: Indexer — build TOC (index.md) and cheat sheet (cheat-sheet.md).
 *
 * The TOC is purely mechanical — list all entities grouped by category,
 * sorted alphabetically. No AI needed.
 *
 * The cheat sheet is a single Haiku oneShot — reads the entity listing
 * and produces a 1-2 page DM quick reference.
 */

import type { FileIO } from "../agents/scene-manager.js";
import type { LLMProvider } from "../providers/types.js";
import { getModel } from "../config/models.js";
import { oneShot } from "../agents/subagent.js";
import { processingPaths } from "./processing-paths.js";
import { loadContentPrompt } from "./prompts/load-content-prompt.js";
import { buildFacets } from "./facet-builder.js";

/** Display labels for known content types. Unknown types get auto-capitalized. */
const KNOWN_LABELS: Record<string, string> = {
  monsters: "Monsters & Creatures",
  spells: "Spells",
  rules: "Rules & Mechanics",
  chargen: "Character Creation",
  equipment: "Equipment & Items",
  tables: "Tables",
  lore: "Lore",
  locations: "Locations",
  generic: "Other",
};

function categoryLabel(dir: string): string {
  return KNOWN_LABELS[dir] ?? dir.charAt(0).toUpperCase() + dir.slice(1).replace(/-/g, " ");
}

export interface IndexResult {
  /** Number of entities indexed. */
  totalEntities: number;
  /** Categories that have entities. */
  categories: string[];
}

/**
 * Build index.md — mechanical TOC of all entities by category.
 * Discovers categories dynamically from the entities directory.
 */
export async function buildIndex(
  io: FileIO,
  homeDir: string,
  collectionSlug: string,
): Promise<{ content: string; result: IndexResult }> {
  const paths = processingPaths(homeDir, collectionSlug);
  const lines: string[] = ["# Content Index", ""];
  let totalEntities = 0;
  const activeCategories: string[] = [];

  // Discover categories from filesystem
  const subdirs = (await io.exists(paths.entitiesDir))
    ? (await io.listDir(paths.entitiesDir)).sort()
    : [];

  for (const cat of subdirs) {
    const dir = paths.entityCategoryDir(cat);
    if (!(await io.exists(dir))) continue;

    const files = await io.listDir(dir);
    const mdFiles = files.filter((f) => f.endsWith(".md")).sort();
    if (mdFiles.length === 0) continue;

    activeCategories.push(cat);
    lines.push(`## ${categoryLabel(cat)}`);
    lines.push("");

    for (const file of mdFiles) {
      const name = file.replace(/\.md$/, "").replace(/-/g, " ");
      const displayName = name.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      lines.push(`- [[${displayName}]]`);
      totalEntities++;
    }

    lines.push("");
  }

  if (totalEntities === 0) {
    lines.push("*No entities found.*");
    lines.push("");
  }

  return {
    content: lines.join("\n"),
    result: { totalEntities, categories: activeCategories },
  };
}

/**
 * Generate cheat-sheet.md via Haiku oneShot.
 */
export async function buildCheatSheet(
  provider: LLMProvider,
  indexContent: string,
): Promise<string> {
  const systemPrompt = loadContentPrompt("indexer");

  const result = await oneShot(
    provider,
    getModel("small"),
    systemPrompt,
    `Here is the entity index for a sourcebook:\n\n${indexContent}\n\nGenerate a DM cheat sheet.`,
    4096,
    "cheat-sheet-gen",
  );

  return result.text;
}

/**
 * Run the full index stage: write index.md and cheat-sheet.md.
 */
export async function runIndexer(
  provider: LLMProvider,
  io: FileIO,
  homeDir: string,
  collectionSlug: string,
): Promise<IndexResult> {
  const paths = processingPaths(homeDir, collectionSlug);

  // Build mechanical index
  const { content: indexContent, result } = await buildIndex(io, homeDir, collectionSlug);
  await io.mkdir(paths.base);
  await io.writeFile(paths.index, indexContent);

  // Generate cheat sheet if we have entities
  if (result.totalEntities > 0) {
    const cheatSheet = await buildCheatSheet(provider, indexContent);
    await io.writeFile(paths.cheatSheet, cheatSheet);
  }

  // Build faceted indexes per category
  await buildFacets(io, homeDir, collectionSlug);

  return result;
}
