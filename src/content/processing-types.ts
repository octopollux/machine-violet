/**
 * Types for the content processing pipeline.
 *
 * The processing pipeline reads cached extracted page text and produces
 * game-ready entity files. Five stages:
 *   1. Classifier — chunk pages, identify content sections
 *   2. Extractors — per-section entity extraction
 *   3. Merge — reconcile drafts with existing entities
 *   4. Index — TOC + cheat sheet
 *   5. Rule Card — generate if none exists
 */

// --- Pipeline state ---

export type PipelineStage =
  | "classifier"
  | "extractors"
  | "merge"
  | "index"
  | "rule-card"
  | "complete";

export interface PipelineState {
  /** Collection slug this pipeline processes. */
  collectionSlug: string;
  /** Current (or last completed) stage. */
  currentStage: PipelineStage;
  /** ISO 8601 timestamp of last update. */
  updatedAt: string;
  /** Per-stage metadata for resumability. */
  stageData: Partial<Record<PipelineStage, unknown>>;
  /** Batch IDs submitted during classifier/extractor stages. */
  batchIds: string[];
}

// --- Catalog (Stage 1 output) ---

export type ContentType =
  | "monsters"
  | "spells"
  | "rules"
  | "chargen"
  | "equipment"
  | "tables"
  | "lore"
  | "locations"
  | "generic";

export interface CatalogSection {
  /** Content type determines which extractor prompt to use. */
  contentType: ContentType;
  /** Human-readable section title (e.g. "Chapter 5: Equipment"). */
  title: string;
  /** Brief description of what this section contains. */
  description: string;
  /** First page (1-based). */
  startPage: number;
  /** Last page (1-based, inclusive). */
  endPage: number;
}

export interface ContentCatalog {
  /** Collection slug. */
  collectionSlug: string;
  /** Sections identified by the classifier. */
  sections: CatalogSection[];
  /** Total pages in the source material. */
  totalPages: number;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

// --- Draft entities (Stage 2 output) ---

export type EntityCategory =
  | "characters"
  | "locations"
  | "lore"
  | "rules"
  | "factions";

export interface DraftEntity {
  /** Entity name. */
  name: string;
  /** Category determines output subdirectory. */
  category: EntityCategory;
  /** URL-safe slug for filename. */
  slug: string;
  /** Front matter key-value pairs. */
  frontMatter: Record<string, string>;
  /** Markdown body content. */
  body: string;
  /** Source section from the catalog. */
  sourceSection?: string;
}
