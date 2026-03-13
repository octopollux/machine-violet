/**
 * Path builders for the content processing pipeline output.
 *
 * All processed output goes to ~/.machine-violet/ingest/processed/<collection-slug>/.
 * Parallels ingestPaths() from job-manager.ts.
 */

import { join } from "node:path";
import type { EntityCategory } from "./processing-types.js";

/**
 * Build paths for processed output of a collection.
 *
 * @param homeDir - Application home directory (e.g. ~/.machine-violet).
 * @param collectionSlug - Slugified collection name (e.g. "d-d-5e").
 */
export function processingPaths(homeDir: string, collectionSlug: string) {
  const base = join(homeDir, "ingest", "processed", collectionSlug);
  return {
    /** Root of processed output for this collection. */
    base,
    /** Pipeline state file. */
    pipelineState: join(base, "pipeline.json"),
    /** Stage 1 output — content catalog. */
    catalog: join(base, "catalog.json"),
    /** Stage 2 output — draft entities root. */
    draftsDir: join(base, "drafts"),
    /** Stage 2 output — draft entity file. */
    draftFile: (category: EntityCategory, slug: string) =>
      join(base, "drafts", category, `${slug}.md`),
    /** Stage 2 output — draft category directory. */
    draftCategoryDir: (category: EntityCategory) =>
      join(base, "drafts", category),
    /** Stage 3 output — merged entities root. */
    entitiesDir: join(base, "entities"),
    /** Stage 3 output — merged entity file. */
    entityFile: (category: EntityCategory, slug: string) =>
      join(base, "entities", category, `${slug}.md`),
    /** Stage 3 output — entity category directory. */
    entityCategoryDir: (category: EntityCategory) =>
      join(base, "entities", category),
    /** Stage 4 output — index. */
    index: join(base, "index.md"),
    /** Stage 4 output — cheat sheet. */
    cheatSheet: join(base, "cheat-sheet.md"),
    /** Stage 5 output — rule card. */
    ruleCard: join(base, "rule-card.md"),
  };
}
