/**
 * Cache writer — writes extracted page text to the ingest cache.
 *
 * Takes parsed extraction results and writes individual page files
 * to the cache directory. Each page gets its own .md file.
 */

import type { FileIO } from "../agents/scene-manager.js";
import type { IngestJob, ChunkExtractionResult } from "./types.js";
import { ingestPaths, slugify } from "./job-manager.js";

/**
 * Write extraction results for a single chunk to the page cache.
 *
 * Creates the pages directory if needed, then writes one .md file per
 * extracted page. Returns the number of pages successfully written.
 */
export async function writeChunkPages(
  io: FileIO,
  homeDir: string,
  job: IngestJob,
  result: ChunkExtractionResult,
): Promise<number> {
  if (!result.pages || result.pages.length === 0) return 0;

  const paths = ingestPaths(homeDir);
  const jobSlug = slugify(job.name.split(" — ")[1] ?? job.id);
  const pagesDir = paths.pagesDir(job.collectionSlug, jobSlug);

  await io.mkdir(pagesDir);

  let written = 0;
  for (const page of result.pages) {
    const pagePath = paths.pageFile(job.collectionSlug, jobSlug, page.pageNumber);
    await io.writeFile(pagePath, page.text);
    written++;
  }

  return written;
}

/**
 * Write all results from a completed batch to the cache.
 *
 * Iterates through chunk results, writes pages for successful chunks,
 * and returns a summary of what was written.
 */
export async function writeBatchResults(
  io: FileIO,
  homeDir: string,
  job: IngestJob,
  results: ChunkExtractionResult[],
): Promise<{ pagesWritten: number; chunksErrored: number }> {
  let pagesWritten = 0;
  let chunksErrored = 0;

  for (const result of results) {
    if (result.error) {
      chunksErrored++;
      continue;
    }

    const count = await writeChunkPages(io, homeDir, job, result);
    pagesWritten += count;
  }

  return { pagesWritten, chunksErrored };
}
