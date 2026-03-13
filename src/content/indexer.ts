/**
 * Stage 4: Indexer — build TOC (index.md) and cheat sheet (cheat-sheet.md).
 *
 * The TOC is purely mechanical — list all entities grouped by category,
 * sorted alphabetically. No AI needed.
 *
 * The cheat sheet is a single Haiku oneShot — reads the entity listing
 * and produces a 1-2 page DM quick reference.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { FileIO } from "../agents/scene-manager.js";
import { getModel } from "../config/models.js";
import { oneShot } from "../agents/subagent.js";
import { processingPaths } from "./processing-paths.js";
import { loadContentPrompt } from "./prompts/load-content-prompt.js";
import type { EntityCategory } from "./processing-types.js";

const ALL_CATEGORIES: EntityCategory[] = [
  "characters", "factions", "locations", "lore", "rules",
];

const CATEGORY_LABELS: Record<EntityCategory, string> = {
  characters: "Characters & Creatures",
  factions: "Factions",
  locations: "Locations",
  lore: "Lore & Items",
  rules: "Rules & Mechanics",
};

export interface IndexResult {
  /** Number of entities indexed. */
  totalEntities: number;
  /** Categories that have entities. */
  categories: EntityCategory[];
}

/**
 * Build index.md — mechanical TOC of all entities by category.
 * Returns the index content and metadata.
 */
export async function buildIndex(
  io: FileIO,
  homeDir: string,
  collectionSlug: string,
): Promise<{ content: string; result: IndexResult }> {
  const paths = processingPaths(homeDir, collectionSlug);
  const lines: string[] = ["# Content Index", ""];
  let totalEntities = 0;
  const activeCategories: EntityCategory[] = [];

  for (const cat of ALL_CATEGORIES) {
    const dir = paths.entityCategoryDir(cat);
    if (!(await io.exists(dir))) continue;

    const files = await io.listDir(dir);
    const mdFiles = files.filter((f) => f.endsWith(".md")).sort();
    if (mdFiles.length === 0) continue;

    activeCategories.push(cat);
    lines.push(`## ${CATEGORY_LABELS[cat]}`);
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
  client: Anthropic,
  indexContent: string,
): Promise<string> {
  const systemPrompt = loadContentPrompt("indexer");

  const result = await oneShot(
    client,
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
  client: Anthropic,
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
    const cheatSheet = await buildCheatSheet(client, indexContent);
    await io.writeFile(paths.cheatSheet, cheatSheet);
  }

  return result;
}
