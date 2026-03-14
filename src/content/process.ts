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
  /** Anthropic client instance. */
  client: Anthropic;
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
  const {
    client, io, homeDir, collectionSlug, jobSlug,
    totalPages, projectRoot, onProgress,
  } = opts;

  const paths = processingPaths(homeDir, collectionSlug);

  // Load or create pipeline state
  let state = await loadPipelineState(io, homeDir, collectionSlug);
  if (!state) {
    state = createPipelineState(collectionSlug);
    await io.mkdir(paths.base);
    await savePipelineState(io, homeDir, state);
  }

  const progress = (stage: PipelineStage, message: string, detail?: string) => {
    onProgress?.({ stage, message, detail });
  };

  // --- Stage 1: Classifier ---
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

  // --- Stage 2: Extractors ---
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

  // --- Stage 3: Merge ---
  if (!hasReachedStage(state, "index")) {
    progress("merge", "Merging drafts with existing entities...");
    const mergeResult = await runMerge(client, io, homeDir, collectionSlug);
    progress("merge", `Merge: ${mergeResult.created} created, ${mergeResult.skipped} skipped, ${mergeResult.merged} merged`);

    advanceStage(state);
    await savePipelineState(io, homeDir, state);
  }

  // --- Stage 4: Index ---
  if (!hasReachedStage(state, "rule-card")) {
    progress("index", "Building index and cheat sheet...");
    const indexResult = await runIndexer(client, io, homeDir, collectionSlug);
    progress("index", `Indexed ${indexResult.totalEntities} entities across ${indexResult.categories.length} categories`);

    advanceStage(state);
    await savePipelineState(io, homeDir, state);
  }

  // --- Stage 5: Rule Card ---
  if (!hasReachedStage(state, "complete")) {
    progress("rule-card", "Checking for rule card...");
    const generated = await runRuleCardGen(client, io, homeDir, collectionSlug, projectRoot);
    progress("rule-card", generated ? "Rule card generated" : "Rule card skipped (hand-authored exists)");

    advanceStage(state);
    await savePipelineState(io, homeDir, state);
  }

  progress("complete", "Processing pipeline complete");
}
