/**
 * Content processing pipeline orchestrator.
 *
 * Chains all five stages:
 *   1. Classifier — identify content sections from cached pages
 *   2. Extractors — extract entities from each section
 *   3. Merge — reconcile drafts with existing entities
 *   4. Index — build TOC and cheat sheet
 *   5. Rule Card — generate if none exists
 *
 * Resumable: pipeline.json tracks current stage. On resume,
 * completed stages are skipped.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { FileIO } from "../agents/scene-manager.js";
import type { LLMProvider } from "../providers/types.js";
import {
  computeChunks,
  loadChunkPages,
  buildClassifierBatchRequests,
  parseClassifierResults,
  buildCatalog,
} from "./classifier.js";
import { pollBatch, collectBatchResults } from "./batch-client.js";
import {
  loadSectionPages,
  buildExtractorBatchRequests,
  parseExtractorResults,
  writeDraftEntities,
} from "./extractors.js";
import { runMerge } from "./merge.js";
import { runIndexer } from "./indexer.js";
import { runRuleCardGen } from "./rule-card-gen.js";
import { processingPaths } from "./processing-paths.js";
import {
  createPipelineState,
  loadPipelineState,
  savePipelineState,
  advanceStage,
  hasReachedStage,
  resetToStage,
} from "./processing-state.js";
import type { ContentCatalog, PipelineStage } from "./processing-types.js";

// --- Progress callback ---

export interface ProcessingProgress {
  stage: PipelineStage;
  message: string;
  detail?: string;
}

export type ProcessingProgressCallback = (progress: ProcessingProgress) => void;

// --- Orchestrator ---

export interface ProcessingOptions {
  /** Anthropic client instance — used for the Batch API (classifier + extractor stages). */
  client: Anthropic;
  /** Provider abstraction — used for the synchronous merge / index / rule-card stages. */
  provider: LLMProvider;
  /** FileIO abstraction. */
  io: FileIO;
  /** Application home directory (e.g. ~/.machine-violet). */
  homeDir: string;
  /** Collection slug (e.g. "d-d-5e"). */
  collectionSlug: string;
  /** Job slug for page cache lookup. */
  jobSlug: string;
  /** Total pages in the source material. */
  totalPages: number;
  /** Project root (where systems/ lives). */
  projectRoot: string;
  /** Progress callback. */
  onProgress?: ProcessingProgressCallback;
}

/**
 * Run the full content processing pipeline.
 *
 * Supports resume: if pipeline.json exists, skips completed stages.
 * Each stage saves state before advancing.
 */
export async function runProcessingPipeline(opts: ProcessingOptions): Promise<void> {
  const { client, provider, io, homeDir, collectionSlug, jobSlug, totalPages, projectRoot, onProgress } = opts;

  // Single-PDF convenience: run per-book stages then shared stages
  await runPerBookStages({ client, io, homeDir, collectionSlug, jobSlug, totalPages, onProgress });
  await runSharedStages({ provider, io, homeDir, collectionSlug, projectRoot, onProgress });
}

// --- Split pipeline for multi-PDF support ---

export interface PerBookOptions {
  client: Anthropic;
  io: FileIO;
  homeDir: string;
  collectionSlug: string;
  jobSlug: string;
  totalPages: number;
  onProgress?: ProcessingProgressCallback;
}

/**
 * Run per-book stages (classifier + extractors) for a single PDF.
 * Resets pipeline state to "classifier" so each PDF gets processed
 * even if a previous run already completed.
 */
export async function runPerBookStages(opts: PerBookOptions): Promise<void> {
  const { client, io, homeDir, collectionSlug, jobSlug, totalPages, onProgress } = opts;
  const paths = processingPaths(homeDir, collectionSlug);

  let state = await loadPipelineState(io, homeDir, collectionSlug);
  if (!state) {
    state = createPipelineState(collectionSlug);
    await io.mkdir(paths.base);
  } else if (hasReachedStage(state, "complete")) {
    // Previous run fully completed — reset so this new PDF gets processed
    resetToStage(state, "classifier");
  }
  // If state is at an intermediate stage (e.g. "merge" from a resumed run),
  // respect it — stages 1-2 will be skipped if already past them.
  await savePipelineState(io, homeDir, state);

  const progress = (stage: "classifier" | "extractors", message: string, detail?: string) => {
    onProgress?.({ stage, message, detail });
  };

  // Stage 1: Classifier
  if (!hasReachedStage(state, "extractors")) {
    progress("classifier", "Classifying content sections...");
    const chunks = computeChunks(totalPages);
    const chunkTexts: string[] = [];
    for (const chunk of chunks) {
      chunkTexts.push(await loadChunkPages(io, homeDir, collectionSlug, jobSlug, chunk));
    }
    const requests = buildClassifierBatchRequests(chunks, chunkTexts, collectionSlug);
    progress("classifier", `Submitting ${requests.length} classifier requests to batch API...`);
    const batch = await client.messages.batches.create({ requests });
    state.batchIds.push(batch.id);
    await savePipelineState(io, homeDir, state);
    progress("classifier", "Polling classifier batch...");
    await pollBatch(client, batch.id);
    const results = await collectBatchResults(client, batch.id);
    const sections = parseClassifierResults(results);
    const catalog = buildCatalog(collectionSlug, sections, totalPages);
    await io.writeFile(paths.catalog, JSON.stringify(catalog, null, 2));
    progress("classifier", `Classified ${catalog.sections.length} sections`);
    advanceStage(state);
    await savePipelineState(io, homeDir, state);
  }

  // Stage 2: Extractors
  if (!hasReachedStage(state, "merge")) {
    progress("extractors", "Loading catalog...");
    const catalogRaw = await io.readFile(paths.catalog);
    const catalog: ContentCatalog = JSON.parse(catalogRaw);
    const sectionTexts: string[] = [];
    for (const section of catalog.sections) {
      sectionTexts.push(await loadSectionPages(io, homeDir, collectionSlug, jobSlug, section));
    }
    const requests = buildExtractorBatchRequests(catalog.sections, sectionTexts, collectionSlug);
    progress("extractors", `Submitting ${requests.length} extractor requests to batch API...`);
    const batch = await client.messages.batches.create({ requests });
    state.batchIds.push(batch.id);
    await savePipelineState(io, homeDir, state);
    progress("extractors", "Polling extractor batch...");
    await pollBatch(client, batch.id);
    const results = await collectBatchResults(client, batch.id);
    const entities = parseExtractorResults(results, catalog.sections, collectionSlug);
    progress("extractors", `Writing ${entities.length} draft entities...`);
    await writeDraftEntities(io, homeDir, collectionSlug, entities);
    progress("extractors", `Extracted ${entities.length} entities`);
    advanceStage(state);
    await savePipelineState(io, homeDir, state);
  }
}

export interface SharedStagesOptions {
  provider: LLMProvider;
  io: FileIO;
  homeDir: string;
  collectionSlug: string;
  projectRoot: string;
  onProgress?: ProcessingProgressCallback;
}

/**
 * Run shared stages (merge + index + rule card) once across all entities.
 * Call this after all per-book stages have completed.
 */
export async function runSharedStages(opts: SharedStagesOptions): Promise<void> {
  const { provider, io, homeDir, collectionSlug, projectRoot, onProgress } = opts;
  const paths = processingPaths(homeDir, collectionSlug);

  let state = await loadPipelineState(io, homeDir, collectionSlug);
  if (!state) {
    state = createPipelineState(collectionSlug);
    await io.mkdir(paths.base);
  }
  // Ensure we're at least at "merge" stage
  if (!hasReachedStage(state, "merge")) {
    resetToStage(state, "merge");
  }
  await savePipelineState(io, homeDir, state);

  const progress = (stage: "merge" | "index" | "rule-card" | "complete", message: string, detail?: string) => {
    onProgress?.({ stage, message, detail });
  };

  // Stage 3: Merge
  if (!hasReachedStage(state, "index")) {
    progress("merge", "Merging drafts with existing entities...");
    const mergeResult = await runMerge(provider, io, homeDir, collectionSlug);
    progress("merge", `Merge: ${mergeResult.created} created, ${mergeResult.skipped} skipped, ${mergeResult.merged} merged`);
    advanceStage(state);
    await savePipelineState(io, homeDir, state);
  }

  // Stage 4: Index
  if (!hasReachedStage(state, "rule-card")) {
    progress("index", "Building index and cheat sheet...");
    const indexResult = await runIndexer(provider, io, homeDir, collectionSlug);
    progress("index", `Indexed ${indexResult.totalEntities} entities across ${indexResult.categories.length} categories`);
    advanceStage(state);
    await savePipelineState(io, homeDir, state);
  }

  // Stage 5: Rule Card
  if (!hasReachedStage(state, "complete")) {
    progress("rule-card", "Checking for rule card...");
    const generated = await runRuleCardGen(provider, io, homeDir, collectionSlug, projectRoot);
    progress("rule-card", generated ? "Rule card generated" : "Rule card skipped (hand-authored exists)");
    advanceStage(state);
    await savePipelineState(io, homeDir, state);
  }

  progress("complete", "Processing pipeline complete");
}
