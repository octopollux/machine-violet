/**
 * Job manager — CRUD for ingest job state and collection manifests.
 *
 * All state is persisted to disk as JSON so jobs survive app restarts.
 * The job manager is purely a bookkeeping layer — it doesn't know about
 * the Anthropic API or PDF splitting.
 */

import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { FileIO } from "../agents/scene-manager.js";
import type { IngestJob, ChunkRecord, CollectionManifest, PdfChunk, ChunkStatus, JobStatus } from "./types.js";

/** Generate a short random ID for jobs. */
function generateId(): string {
  return randomBytes(8).toString("hex");
}

/** Slugify a string for use in directory names. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Paths within the ingest state directory.
 *
 * @param homeDir - The application home directory (e.g. ~/.machine-violet).
 */
export function ingestPaths(homeDir: string) {
  const base = join(homeDir, "ingest");
  return {
    base,
    jobsDir: join(base, "jobs"),
    cacheDir: join(base, "cache"),
    jobFile: (collectionSlug: string, jobSlug: string) =>
      join(base, "jobs", collectionSlug, `${jobSlug}.json`),
    manifestFile: (collectionSlug: string) =>
      join(base, "cache", collectionSlug, "manifest.json"),
    pagesDir: (collectionSlug: string, jobSlug: string) =>
      join(base, "cache", collectionSlug, jobSlug, "pages"),
    pageFile: (collectionSlug: string, jobSlug: string, pageNum: number) =>
      join(base, "cache", collectionSlug, jobSlug, "pages", `${String(pageNum).padStart(4, "0")}.md`),
  };
}

/**
 * Create a new ingest job from PDF info.
 *
 * Does not persist — call `saveJob()` after creation.
 */
export function createJob(
  collection: string,
  pdfBaseName: string,
  sourceFile: string,
  totalPages: number,
  chunks: PdfChunk[],
): IngestJob {
  const now = new Date().toISOString();
  const collectionSlug = slugify(collection);
  const jobSlug = slugify(pdfBaseName);

  return {
    id: generateId(),
    collection,
    collectionSlug,
    name: `${collection} — ${pdfBaseName}`,
    sourceFile,
    totalPages,
    chunks: chunks.map((c): ChunkRecord => ({
      index: c.index,
      pageRange: `${c.startPage}-${c.endPage}`,
      startPage: c.startPage,
      endPage: c.endPage,
      customId: "", // Set after batch submission
      status: "pending",
    })),
    status: "pending",
    pagesCompleted: 0,
    pagesFailed: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Persist a job to disk.
 */
export async function saveJob(io: FileIO, homeDir: string, job: IngestJob): Promise<void> {
  const paths = ingestPaths(homeDir);
  const jobSlug = slugify(job.name.split(" — ")[1] ?? job.id);
  const filePath = paths.jobFile(job.collectionSlug, jobSlug);

  // Ensure directory exists
  const dir = filePath.replace(/[/\\][^/\\]+$/, "");
  await io.mkdir(dir);

  job.updatedAt = new Date().toISOString();
  await io.writeFile(filePath, JSON.stringify(job, null, 2));
}

/**
 * Load a job from disk.
 */
export async function loadJob(io: FileIO, homeDir: string, collectionSlug: string, jobSlug: string): Promise<IngestJob> {
  const paths = ingestPaths(homeDir);
  const raw = await io.readFile(paths.jobFile(collectionSlug, jobSlug));
  return JSON.parse(raw) as IngestJob;
}

/**
 * List all jobs in a collection.
 */
export async function listCollectionJobs(io: FileIO, homeDir: string, collectionSlug: string): Promise<IngestJob[]> {
  const paths = ingestPaths(homeDir);
  const dir = join(paths.jobsDir, collectionSlug);

  if (!(await io.exists(dir))) return [];

  const files = await io.listDir(dir);
  const jobs: IngestJob[] = [];

  for (const file of files) {
    if (file.endsWith(".json")) {
      const raw = await io.readFile(join(dir, file));
      jobs.push(JSON.parse(raw) as IngestJob);
    }
  }

  return jobs;
}

/**
 * List all collections.
 */
export async function listCollections(io: FileIO, homeDir: string): Promise<CollectionManifest[]> {
  const paths = ingestPaths(homeDir);

  if (!(await io.exists(paths.cacheDir))) return [];

  const dirs = await io.listDir(paths.cacheDir);
  const manifests: CollectionManifest[] = [];

  for (const dir of dirs) {
    const manifestPath = paths.manifestFile(dir);
    if (await io.exists(manifestPath)) {
      const raw = await io.readFile(manifestPath);
      manifests.push(JSON.parse(raw) as CollectionManifest);
    }
  }

  return manifests;
}

/**
 * Create or update a collection manifest.
 */
export async function saveCollectionManifest(
  io: FileIO,
  homeDir: string,
  collection: string,
  jobIds: string[],
): Promise<CollectionManifest> {
  const paths = ingestPaths(homeDir);
  const slug = slugify(collection);
  const manifestPath = paths.manifestFile(slug);

  const dir = manifestPath.replace(/[/\\][^/\\]+$/, "");
  await io.mkdir(dir);

  let manifest: CollectionManifest;
  if (await io.exists(manifestPath)) {
    const raw = await io.readFile(manifestPath);
    manifest = JSON.parse(raw) as CollectionManifest;
    // Merge job IDs, avoiding duplicates
    const existing = new Set(manifest.jobIds);
    for (const id of jobIds) existing.add(id);
    manifest.jobIds = [...existing];
    manifest.updatedAt = new Date().toISOString();
  } else {
    const now = new Date().toISOString();
    manifest = { name: collection, slug, jobIds, createdAt: now, updatedAt: now };
  }

  await io.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * Update chunk statuses on a job after batch results come in.
 */
export function updateChunkStatus(
  job: IngestJob,
  chunkIndex: number,
  status: ChunkStatus,
  error?: string,
): void {
  const chunk = job.chunks[chunkIndex];
  if (!chunk) return;

  chunk.status = status;
  if (error) chunk.error = error;
}

/**
 * Recompute a job's overall status from its chunk statuses.
 */
export function recomputeJobStatus(job: IngestJob): void {
  const statuses = job.chunks.map((c) => c.status);

  const allSucceeded = statuses.every((s) => s === "succeeded");
  const anyPending = statuses.some((s) => s === "pending" || s === "submitted");
  const anySucceeded = statuses.some((s) => s === "succeeded");
  const anyErrored = statuses.some((s) => s === "errored" || s === "expired" || s === "canceled");

  let status: JobStatus;
  if (allSucceeded) {
    status = "complete";
  } else if (anyPending) {
    status = statuses.some((s) => s === "submitted") ? "processing" : "pending";
  } else if (anySucceeded && anyErrored) {
    status = "partial";
  } else {
    status = "failed";
  }

  job.status = status;

  // Recompute page counts
  let completed = 0;
  const failed: number[] = [];

  for (const chunk of job.chunks) {
    const pageCount = chunk.endPage - chunk.startPage + 1;
    if (chunk.status === "succeeded") {
      completed += pageCount;
    } else if (chunk.status === "errored" || chunk.status === "expired" || chunk.status === "canceled") {
      for (let p = chunk.startPage; p <= chunk.endPage; p++) {
        failed.push(p);
      }
    }
  }

  job.pagesCompleted = completed;
  job.pagesFailed = failed;
}
