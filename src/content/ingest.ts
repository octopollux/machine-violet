/**
 * Ingest orchestrator — top-level API for PDF cracking.
 *
 * This is the entry point that the TUI calls. It coordinates:
 * 1. PDF validation and splitting
 * 2. Job creation and persistence
 * 3. Batch submission
 * 4. Polling and result collection
 * 5. Cache writing
 *
 * All operations are idempotent where possible.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { FileIO } from "../agents/scene-manager.js";
import type { IngestJob, BatchSubmission } from "./types.js";
import { getPdfInfo, splitPdf } from "./pdf-split.js";
import { buildBatchRequests, submitBatch, pollBatch, collectResults } from "./batch-client.js";
import {
  createJob,
  saveJob,
  saveCollectionManifest,
  updateChunkStatus,
  recomputeJobStatus,
  slugify,
} from "./job-manager.js";
import { writeBatchResults } from "./cache-writer.js";

// --- Types for progress callbacks ---

export interface IngestProgress {
  phase: "splitting" | "submitting" | "polling" | "collecting" | "writing" | "done";
  jobName: string;
  /** For splitting: pages processed. For polling: chunks completed. */
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
 * Run the full PDF cracking pipeline for a collection of PDFs.
 *
 * This is the main entry point. It:
 * 1. Splits each PDF into 30-page chunks
 * 2. Creates jobs and persists them
 * 3. Submits all chunks as one batch
 * 4. Polls until complete
 * 5. Collects results and writes to cache
 * 6. Updates job statuses
 *
 * @param client - Anthropic API client.
 * @param io - FileIO for persistence.
 * @param homeDir - Application home directory.
 * @param collection - User-provided collection name.
 * @param pdfs - Validated PDF info from validatePdfs().
 * @param onProgress - Optional progress callback for TUI updates.
 * @returns Array of completed jobs.
 */
export async function runIngestPipeline(
  client: Anthropic,
  io: FileIO,
  homeDir: string,
  collection: string,
  pdfs: ValidatedPdf[],
  onProgress?: ProgressCallback,
): Promise<IngestJob[]> {
  const jobs: IngestJob[] = [];
  const allRequests: Anthropic.Messages.Batches.BatchCreateParams.Request[] = [];
  const chunkMaps: BatchSubmission["chunkMap"] = {};

  // Phase 1: Split PDFs and create jobs
  for (const pdf of pdfs) {
    onProgress?.({
      phase: "splitting",
      jobName: `${collection} — ${pdf.baseName}`,
      message: `Splitting ${pdf.baseName} (${pdf.pageCount} pages)...`,
    });

    const chunks = await splitPdf(pdf.filePath);
    const job = createJob(collection, pdf.baseName, pdf.filePath, pdf.pageCount, chunks);

    // Build batch requests for this job's chunks
    const requests = buildBatchRequests(job.id, chunks);

    // Update chunk custom_ids on the job
    for (let i = 0; i < requests.length; i++) {
      job.chunks[i].customId = requests[i].custom_id;
      job.chunks[i].status = "submitted";
      chunkMaps[requests[i].custom_id] = { jobId: job.id, chunkIndex: i };
    }

    job.status = "submitted";
    await saveJob(io, homeDir, job);
    jobs.push(job);
    allRequests.push(...requests);
  }

  // Phase 2: Submit all chunks as one batch
  onProgress?.({
    phase: "submitting",
    jobName: collection,
    message: `Submitting ${allRequests.length} chunks to batch API...`,
    total: allRequests.length,
  });

  const batch = await client.messages.batches.create({ requests: allRequests });
  const batchId = batch.id;

  // Record batch ID on all jobs
  for (const job of jobs) {
    job.batchId = batchId;
    job.status = "processing";
    await saveJob(io, homeDir, job);
  }

  // Save collection manifest
  await saveCollectionManifest(io, homeDir, collection, jobs.map((j) => j.id));

  // Phase 3: Poll until done
  onProgress?.({
    phase: "polling",
    jobName: collection,
    message: "Waiting for batch processing...",
    current: 0,
    total: allRequests.length,
  });

  await pollBatch(client, batchId, 5000, (counts) => {
    onProgress?.({
      phase: "polling",
      jobName: collection,
      message: `Processing: ${counts.succeeded} succeeded, ${counts.processing} in progress`,
      current: counts.succeeded + counts.errored + counts.canceled + counts.expired,
      total: allRequests.length,
    });
  });

  // Phase 4: Collect results
  onProgress?.({
    phase: "collecting",
    jobName: collection,
    message: "Collecting results...",
  });

  const results = await collectResults(client, batchId);

  // Phase 5: Write pages and update job statuses
  for (const result of results) {
    const mapping = chunkMaps[result.customId];
    if (!mapping) continue;

    const job = jobs.find((j) => j.id === mapping.jobId);
    if (!job) continue;

    if (result.error) {
      updateChunkStatus(job, mapping.chunkIndex, "errored", result.error);
    } else {
      updateChunkStatus(job, mapping.chunkIndex, "succeeded");

      onProgress?.({
        phase: "writing",
        jobName: job.name,
        message: `Writing pages for chunk ${mapping.chunkIndex + 1}...`,
      });

      await writeBatchResults(io, homeDir, job, [result]);
    }
  }

  // Finalize job statuses
  for (const job of jobs) {
    recomputeJobStatus(job);
    await saveJob(io, homeDir, job);
  }

  onProgress?.({
    phase: "done",
    jobName: collection,
    message: `Done. ${jobs.reduce((sum, j) => sum + j.pagesCompleted, 0)} pages extracted.`,
  });

  return jobs;
}

/**
 * Resume polling and collection for jobs that were interrupted.
 *
 * Finds jobs with status "submitted" or "processing" and resumes
 * from where they left off.
 */
export async function resumeInterruptedJobs(
  client: Anthropic,
  io: FileIO,
  homeDir: string,
  jobs: IngestJob[],
  onProgress?: ProgressCallback,
): Promise<void> {
  // Group by batchId
  const byBatch = new Map<string, IngestJob[]>();
  for (const job of jobs) {
    if (!job.batchId) continue;
    if (job.status !== "submitted" && job.status !== "processing") continue;
    const group = byBatch.get(job.batchId) ?? [];
    group.push(job);
    byBatch.set(job.batchId, group);
  }

  for (const [batchId, batchJobs] of byBatch) {
    // Build chunk map from jobs
    const chunkMaps: BatchSubmission["chunkMap"] = {};
    for (const job of batchJobs) {
      for (const chunk of job.chunks) {
        if (chunk.customId) {
          chunkMaps[chunk.customId] = { jobId: job.id, chunkIndex: chunk.index };
        }
      }
    }

    // Check batch status
    const batch = await client.messages.batches.retrieve(batchId);

    if (batch.processing_status !== "ended") {
      // Still processing — poll
      onProgress?.({
        phase: "polling",
        jobName: batchJobs[0].collection,
        message: `Resuming poll for batch ${batchId}...`,
      });

      await pollBatch(client, batchId, 5000, (counts) => {
        onProgress?.({
          phase: "polling",
          jobName: batchJobs[0].collection,
          current: counts.succeeded + counts.errored,
          total: counts.processing + counts.succeeded + counts.errored + counts.canceled + counts.expired,
        });
      });
    }

    // Collect and write
    const results = await collectResults(client, batchId);

    for (const result of results) {
      const mapping = chunkMaps[result.customId];
      if (!mapping) continue;

      const job = batchJobs.find((j) => j.id === mapping.jobId);
      if (!job) continue;

      if (result.error) {
        updateChunkStatus(job, mapping.chunkIndex, "errored", result.error);
      } else {
        updateChunkStatus(job, mapping.chunkIndex, "succeeded");
        await writeBatchResults(io, homeDir, job, [result]);
      }
    }

    for (const job of batchJobs) {
      recomputeJobStatus(job);
      await saveJob(io, homeDir, job);
    }
  }
}
