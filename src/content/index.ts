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

// NOTE: batch-client.ts, pdf-split.ts (splitPdf), and their types are
// retained internally for the future content processing pipeline, which
// will use the Batch API for Haiku-powered classification and extraction.
// They are not re-exported here because they are not needed by consumers.
