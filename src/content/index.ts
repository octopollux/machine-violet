/**
 * Content pipeline — PDF ingestion and processing.
 *
 * This module is completely separate from the game engine.
 * The only shared interface is the filesystem format.
 */

// Types
export type {
  ChunkStatus,
  ChunkRecord,
  JobStatus,
  IngestJob,
  CollectionManifest,
  PdfChunk,
  PdfInfo,
  BatchSubmission,
  PageExtractionResult,
  ChunkExtractionResult,
} from "./types.js";

// PDF splitting
export { getPdfInfo, splitPdf, DEFAULT_CHUNK_SIZE } from "./pdf-split.js";

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

// Batch API client (retained for future use with processing pipeline)
export { buildBatchRequests, submitBatch, pollBatch, collectResults, parsePageDelimiters } from "./batch-client.js";

// Cache writer
export { writeChunkPages, writeBatchResults } from "./cache-writer.js";

// Orchestrator
export {
  validatePdfs,
  runIngestPipeline,
} from "./ingest.js";
export type { IngestProgress, ProgressCallback, ValidatedPdf } from "./ingest.js";
