/**
 * Types for the PDF content ingestion pipeline.
 *
 * The pipeline has two phases:
 * 1. PDF Cracking — mechanical batch job that extracts text from PDFs
 * 2. Content Processing — agentic pipeline that organizes extracted text (separate concern)
 *
 * This module covers phase 1 types only.
 */

// --- Chunk tracking ---

export type ChunkStatus = "pending" | "submitted" | "succeeded" | "errored" | "expired" | "canceled";

export interface ChunkRecord {
  /** Zero-based index within this job. */
  index: number;
  /** Human-readable page range, e.g. "1-30". */
  pageRange: string;
  /** First page number (1-based). */
  startPage: number;
  /** Last page number (1-based, inclusive). */
  endPage: number;
  /** Batch API custom_id for this chunk. */
  customId: string;
  /** Current processing status. */
  status: ChunkStatus;
  /** Error message if status is "errored". */
  error?: string;
}

// --- Job tracking ---

export type JobStatus = "pending" | "submitted" | "processing" | "complete" | "partial" | "failed";

export interface IngestJob {
  /** Unique job identifier (generated). */
  id: string;
  /** User-provided collection name (e.g. "D&D 5e"). */
  collection: string;
  /** Slugified collection name, used for directory paths. */
  collectionSlug: string;
  /** Display name: "{collection} — {PDF basename}". */
  name: string;
  /** Original PDF file path. */
  sourceFile: string;
  /** Total pages in the PDF. */
  totalPages: number;
  /** Chunk records for tracking per-chunk status. */
  chunks: ChunkRecord[];
  /** Batch API batch ID, set after submission. */
  batchId?: string;
  /** Overall job status. */
  status: JobStatus;
  /** Number of pages successfully extracted. */
  pagesCompleted: number;
  /** Page numbers (1-based) that failed extraction. */
  pagesFailed: number[];
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 last-updated timestamp. */
  updatedAt: string;
}

// --- Collection manifest ---

export interface CollectionManifest {
  /** User-provided collection name. */
  name: string;
  /** Slugified name. */
  slug: string;
  /** Job IDs belonging to this collection. */
  jobIds: string[];
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 last-updated timestamp. */
  updatedAt: string;
}

// --- PDF splitting ---

export interface PdfChunk {
  /** Zero-based chunk index. */
  index: number;
  /** First page (1-based). */
  startPage: number;
  /** Last page (1-based, inclusive). */
  endPage: number;
  /** Base64-encoded PDF bytes for this chunk. */
  pdfBase64: string;
}

export interface PdfInfo {
  /** Total number of pages. */
  pageCount: number;
  /** Basename without extension (e.g. "Monster Manual"). */
  baseName: string;
}

// --- Batch submission ---

export interface BatchSubmission {
  /** Batch API batch ID. */
  batchId: string;
  /** Map from custom_id → { jobId, chunkIndex }. */
  chunkMap: Record<string, { jobId: string; chunkIndex: number }>;
}

// --- Results ---

export interface PageExtractionResult {
  /** 1-based page number. */
  pageNumber: number;
  /** Extracted markdown text. */
  text: string;
}

export interface ChunkExtractionResult {
  /** custom_id from the batch request. */
  customId: string;
  /** Extracted pages, if successful. */
  pages?: PageExtractionResult[];
  /** Error message, if failed. */
  error?: string;
}
