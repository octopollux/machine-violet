/**
 * Stage 1: Classifier — chunk pages into windows, build batch requests,
 * parse content catalog from results, merge overlapping sections.
 *
 * Chunks cached page files into 20-page windows with 2-page overlap.
 * Each chunk becomes one batch request to Haiku. The responses are
 * JSON arrays of CatalogSection, which are merged and deduplicated.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { FileIO } from "../agents/scene-manager.js";
import { getModel } from "../config/models.js";
import { ingestPaths } from "./job-manager.js";
import { loadContentPrompt } from "./prompts/load-content-prompt.js";
import type { CatalogSection, ContentCatalog, ContentType } from "./processing-types.js";

/** Default chunk window size in pages. */
export const CHUNK_WINDOW = 20;
/** Number of overlapping pages between chunks. */
export const CHUNK_OVERLAP = 2;

const VALID_CONTENT_TYPES = new Set<ContentType>([
  "monsters", "spells", "rules", "chargen", "equipment",
  "tables", "lore", "locations", "generic",
]);

// --- Chunking ---

export interface PageChunk {
  /** Chunk index (0-based). */
  index: number;
  /** First page (1-based). */
  startPage: number;
  /** Last page (1-based, inclusive). */
  endPage: number;
}

/**
 * Compute chunk windows for a given total page count.
 * Windows are `CHUNK_WINDOW` pages with `CHUNK_OVERLAP` page overlap.
 */
export function computeChunks(totalPages: number, windowSize = CHUNK_WINDOW, overlap = CHUNK_OVERLAP): PageChunk[] {
  const chunks: PageChunk[] = [];
  const stride = windowSize - overlap;
  let start = 1;
  let index = 0;

  while (start <= totalPages) {
    const end = Math.min(start + windowSize - 1, totalPages);
    chunks.push({ index, startPage: start, endPage: end });
    index++;
    start += stride;
    if (end === totalPages) break;
  }

  return chunks;
}

/**
 * Load page text for a chunk from the cache directory.
 */
export async function loadChunkPages(
  io: FileIO,
  homeDir: string,
  collectionSlug: string,
  jobSlug: string,
  chunk: PageChunk,
): Promise<string> {
  const paths = ingestPaths(homeDir);
  const pages: string[] = [];

  for (let p = chunk.startPage; p <= chunk.endPage; p++) {
    const pagePath = paths.pageFile(collectionSlug, jobSlug, p);
    if (await io.exists(pagePath)) {
      const text = await io.readFile(pagePath);
      pages.push(`--- PAGE ${p} ---\n${text}`);
    }
  }

  return pages.join("\n\n");
}

/**
 * Build batch request items for all chunks.
 */
export function buildClassifierBatchRequests(
  chunks: PageChunk[],
  chunkTexts: string[],
  collectionSlug: string,
): Anthropic.Messages.Batches.BatchCreateParams.Request[] {
  const systemPrompt = loadContentPrompt("classifier");

  return chunks.map((chunk, i) => ({
    custom_id: `classify-${collectionSlug}-${chunk.startPage}-${chunk.endPage}`,
    params: {
      model: getModel("small"),
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        {
          role: "user" as const,
          content: `Classify the following pages (${chunk.startPage}–${chunk.endPage}) from a tabletop RPG sourcebook.\n\n${chunkTexts[i]}`,
        },
      ],
    },
  }));
}

/**
 * Parse classifier batch results into catalog sections.
 * Each result should be a JSON array of CatalogSection objects.
 */
export function parseClassifierResults(
  results: { customId: string; text?: string; error?: string }[],
): CatalogSection[] {
  const allSections: CatalogSection[] = [];

  for (const result of results) {
    if (result.error || !result.text) continue;

    try {
      // Extract JSON from possible markdown code fence
      let jsonText = result.text.trim();
      const fenceMatch = jsonText.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
      if (fenceMatch) {
        jsonText = fenceMatch[1].trim();
      }

      const sections = JSON.parse(jsonText) as Record<string, unknown>[];
      if (!Array.isArray(sections)) continue;

      for (const s of sections) {
        if (
          typeof s.contentType === "string" &&
          typeof s.title === "string" &&
          typeof s.startPage === "number" &&
          typeof s.endPage === "number"
        ) {
          const contentType = VALID_CONTENT_TYPES.has(s.contentType as ContentType)
            ? (s.contentType as ContentType)
            : "generic";

          allSections.push({
            contentType,
            title: s.title,
            description: typeof s.description === "string" ? s.description : "",
            startPage: s.startPage,
            endPage: s.endPage,
          });
        }
      }
    } catch {
      // Skip unparseable results
    }
  }

  return allSections;
}

/**
 * Merge overlapping sections from multiple chunk results.
 * Sections with the same title and overlapping page ranges are merged.
 * Sections with different titles but overlapping ranges keep the larger one.
 */
export function mergeSections(sections: CatalogSection[]): CatalogSection[] {
  if (sections.length === 0) return [];

  // Sort by startPage
  const sorted = [...sections].sort((a, b) => a.startPage - b.startPage);

  const merged: CatalogSection[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];

    // Same title and overlapping/adjacent → merge
    if (
      current.title === last.title &&
      current.contentType === last.contentType &&
      current.startPage <= last.endPage + 1
    ) {
      last.endPage = Math.max(last.endPage, current.endPage);
      if (current.description && !last.description) {
        last.description = current.description;
      }
    } else {
      merged.push(current);
    }
  }

  return merged;
}

/**
 * Build the final ContentCatalog from merged sections.
 */
export function buildCatalog(
  collectionSlug: string,
  sections: CatalogSection[],
  totalPages: number,
): ContentCatalog {
  return {
    collectionSlug,
    sections: mergeSections(sections),
    totalPages,
    createdAt: new Date().toISOString(),
  };
}
