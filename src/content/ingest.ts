/**
 * Ingest orchestrator — top-level API for PDF text extraction.
 *
 * Uses local text extraction (pdf-parse) instead of the Claude API.
 * This is a mechanical operation — no AI involved, no API calls,
 * no cost, nearly instant.
 *
 * The extracted text is cached to disk per-page so the downstream
 * processing pipeline can read it cheaply and repeatedly.
 */

import type { FileIO } from "../agents/scene-manager.js";
import type { IngestJob } from "./types.js";
import { getPdfInfo } from "./pdf-split.js";
import { extractTextFromPdf } from "./pdf-extract.js";
import {
  createJob,
  saveJob,
  saveCollectionManifest,
  updateChunkStatus,
  ingestPaths,
  slugify,
} from "./job-manager.js";

// --- Types for progress callbacks ---

export interface IngestProgress {
  phase: "extracting" | "writing" | "done";
  jobName: string;
  current?: number;
  total?: number;
  message?: string;
}

export type ProgressCallback = (progress: IngestProgress) => void;

// --- Validation ---

export interface ValidatedPdf {
  filePath: string;
  baseName: string;
  pageCount: number;
}

/**
 * Validate one or more PDF file paths.
 * Returns info for each valid PDF. Throws on invalid files.
 */
export async function validatePdfs(filePaths: string[]): Promise<ValidatedPdf[]> {
  const results: ValidatedPdf[] = [];

  for (const filePath of filePaths) {
    const info = await getPdfInfo(filePath);
    results.push({
      filePath,
      baseName: info.baseName,
      pageCount: info.pageCount,
    });
  }

  return results;
}

// --- Full ingest pipeline ---

/**
 * Run the PDF text extraction pipeline for a collection of PDFs.
 *
 * Extracts text locally using pdf-parse (no API calls), then writes
 * per-page markdown files to the ingest cache.
 *
 * @param io - FileIO for persistence.
 * @param homeDir - Application home directory.
 * @param collection - User-provided collection name.
 * @param pdfs - Validated PDF info from validatePdfs().
 * @param onProgress - Optional progress callback for TUI updates.
 * @returns Array of completed jobs.
 */
export async function runIngestPipeline(
  io: FileIO,
  homeDir: string,
  collection: string,
  pdfs: ValidatedPdf[],
  onProgress?: ProgressCallback,
): Promise<IngestJob[]> {
  const jobs: IngestJob[] = [];
  const collectionSlug = slugify(collection);

  for (const pdf of pdfs) {
    const jobName = `${collection} — ${pdf.baseName}`;

    onProgress?.({
      phase: "extracting",
      jobName,
      message: `Extracting text from ${pdf.baseName} (${pdf.pageCount} pages)...`,
      current: 0,
      total: pdf.pageCount,
    });

    // Create a job with a single "chunk" representing the whole PDF
    // (we no longer split for API submission, but keep the job structure
    // for consistency with the cache layout and status tracking)
    const job = createJob(collection, pdf.baseName, pdf.filePath, pdf.pageCount, [
      { index: 0, startPage: 1, endPage: pdf.pageCount, pdfBase64: "" },
    ]);

    // Extract text locally
    const extraction = await extractTextFromPdf(pdf.filePath);

    // Write pages to cache
    onProgress?.({
      phase: "writing",
      jobName,
      message: `Writing ${extraction.pages.length} pages to cache...`,
      current: 0,
      total: extraction.pages.length,
    });

    const paths = ingestPaths(homeDir);
    const jobSlug = slugify(pdf.baseName);
    const pagesDir = paths.pagesDir(collectionSlug, jobSlug);
    await io.mkdir(pagesDir);

    let written = 0;
    for (const page of extraction.pages) {
      if (page.text.length > 0) {
        const pagePath = paths.pageFile(collectionSlug, jobSlug, page.pageNumber);
        await io.writeFile(pagePath, page.text);
        written++;
      }
    }

    // Update job status
    updateChunkStatus(job, 0, written > 0 ? "succeeded" : "errored",
      written === 0 ? "No text extracted from any page" : undefined);
    job.pagesCompleted = written;
    job.pagesFailed = extraction.emptyPages;
    job.status = written > 0 ? "complete" : "failed";

    await saveJob(io, homeDir, job);
    jobs.push(job);

    onProgress?.({
      phase: "writing",
      jobName,
      message: `${pdf.baseName}: ${written} pages extracted` +
        (extraction.emptyPages.length > 0 ? ` (${extraction.emptyPages.length} empty pages)` : ""),
      current: written,
      total: pdf.pageCount,
    });
  }

  // Save collection manifest
  await saveCollectionManifest(io, homeDir, collection, jobs.map((j) => j.id));

  const totalPages = jobs.reduce((sum, j) => sum + j.pagesCompleted, 0);
  const totalEmpty = jobs.reduce((sum, j) => sum + j.pagesFailed.length, 0);

  onProgress?.({
    phase: "done",
    jobName: collection,
    message: `Done. ${totalPages} pages extracted` +
      (totalEmpty > 0 ? `, ${totalEmpty} empty pages skipped` : "") + ".",
  });

  return jobs;
}
