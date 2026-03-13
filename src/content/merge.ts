/**
 * Stage 3: Merge — reconcile draft entities with existing entity files.
 *
 * Three outcomes per entity:
 * - **New:** draft has no existing counterpart → copy to entities/
 * - **Skip:** draft matches existing exactly → do nothing
 * - **Conflict:** draft differs from existing → Haiku oneShot merge
 *
 * Conflict merges are sequential (not batch) because each merge may
 * need context from prior merges.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { FileIO } from "../agents/scene-manager.js";
import { getModel } from "../config/models.js";
import { oneShot } from "../agents/subagent.js";
import { processingPaths } from "./processing-paths.js";
import { loadContentPrompt } from "./prompts/load-content-prompt.js";
import type { EntityCategory } from "./processing-types.js";

const ALL_CATEGORIES: EntityCategory[] = [
  "characters", "locations", "lore", "rules", "factions",
];

export interface MergeResult {
  /** Entities copied as new (no prior version). */
  created: number;
  /** Entities skipped (identical to existing). */
  skipped: number;
  /** Entities merged via AI (conflicting versions). */
  merged: number;
  /** Entities that failed to merge. */
  errors: number;
}

/**
 * Discover all draft entity files, grouped by category and slug.
 */
export async function listDraftEntities(
  io: FileIO,
  homeDir: string,
  collectionSlug: string,
): Promise<Array<{ category: EntityCategory; slug: string }>> {
  const paths = processingPaths(homeDir, collectionSlug);
  const results: Array<{ category: EntityCategory; slug: string }> = [];

  for (const cat of ALL_CATEGORIES) {
    const dir = paths.draftCategoryDir(cat);
    if (!(await io.exists(dir))) continue;

    const files = await io.listDir(dir);
    for (const f of files) {
      if (f.endsWith(".md")) {
        results.push({ category: cat, slug: f.replace(/\.md$/, "") });
      }
    }
  }

  return results;
}

/**
 * Run the merge stage. Compares each draft against existing entities.
 */
export async function runMerge(
  client: Anthropic,
  io: FileIO,
  homeDir: string,
  collectionSlug: string,
): Promise<MergeResult> {
  const paths = processingPaths(homeDir, collectionSlug);
  const drafts = await listDraftEntities(io, homeDir, collectionSlug);
  const result: MergeResult = { created: 0, skipped: 0, merged: 0, errors: 0 };

  for (const { category, slug } of drafts) {
    const draftPath = paths.draftFile(category, slug);
    const entityPath = paths.entityFile(category, slug);

    const draftContent = await io.readFile(draftPath);

    // Check if entity already exists
    if (!(await io.exists(entityPath))) {
      // New entity — copy directly
      await io.mkdir(paths.entityCategoryDir(category));
      await io.writeFile(entityPath, draftContent);
      result.created++;
      continue;
    }

    const existingContent = await io.readFile(entityPath);

    // Exact match — skip
    if (draftContent.trim() === existingContent.trim()) {
      result.skipped++;
      continue;
    }

    // Conflict — merge via AI
    try {
      const mergedContent = await mergeConflict(
        client,
        existingContent,
        draftContent,
      );
      await io.writeFile(entityPath, mergedContent);
      result.merged++;
    } catch {
      result.errors++;
    }
  }

  return result;
}

/**
 * Merge two conflicting entity versions via Haiku oneShot.
 */
async function mergeConflict(
  client: Anthropic,
  existing: string,
  draft: string,
): Promise<string> {
  const systemPrompt = loadContentPrompt("merge-compare");
  const userMessage = `## Existing Version\n\n${existing}\n\n## New Version\n\n${draft}`;

  const result = await oneShot(
    client,
    getModel("small"),
    systemPrompt,
    userMessage,
    4096,
    "entity-merge",
  );

  return result.text;
}
