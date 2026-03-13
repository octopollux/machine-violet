/**
 * Content pipeline — PDF ingestion and processing.
 *
 * This module is completely separate from the game engine.
 * The only shared interface is the filesystem format.
 */

// Types
export type {
  JobStatus,
  IngestJob,
  CollectionManifest,
  PdfInfo,
  PageExtractionResult,
} from "./types.js";

// PDF info (validation)
export { getPdfInfo } from "./pdf-split.js";

// PDF text extraction (local, no API)
export { extractTextFromPdf } from "./pdf-extract.js";
export type { ExtractionResult } from "./pdf-extract.js";

// Job management
export {
  ingestPaths,
  slugify,
  createJob,
  saveJob,
  loadJob,
  listCollectionJobs,
  listCollections,
  saveCollectionManifest,
  updateChunkStatus,
  recomputeJobStatus,
} from "./job-manager.js";

// Cache writer
export { writeChunkPages, writeBatchResults } from "./cache-writer.js";

// Orchestrator
export {
  validatePdfs,
  runIngestPipeline,
} from "./ingest.js";
export type { IngestProgress, ProgressCallback, ValidatedPdf } from "./ingest.js";

// Processing pipeline — Haiku-powered classification, extraction, merge, indexing
export { processingPaths } from "./processing-paths.js";
export type {
  PipelineStage,
  PipelineState,
  ContentType,
  CatalogSection,
  ContentCatalog,
  EntityCategory,
  DraftEntity,
} from "./processing-types.js";
export {
  createPipelineState,
  loadPipelineState,
  savePipelineState,
  advanceStage,
  hasReachedStage,
} from "./processing-state.js";
export { parseEntities } from "./entity-parser.js";
export { runProcessingPipeline } from "./process.js";
export type { ProcessingProgress, ProcessingProgressCallback, ProcessingOptions } from "./process.js";

// NOTE: batch-client.ts, pdf-split.ts, classifier.ts, extractors.ts,
// merge.ts, indexer.ts, and rule-card-gen.ts are internal modules used
// by the processing pipeline orchestrator (process.ts). They are not
// re-exported because consumers should use runProcessingPipeline().
