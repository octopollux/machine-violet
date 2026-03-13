/**
 * Batch API client for PDF text extraction.
 *
 * Submits PDF chunks to the Anthropic Message Batches API for text extraction
 * by Haiku. Handles batch creation, polling, and result collection.
 *
 * This is purely mechanical — no agentic logic. The prompt asks for faithful
 * text extraction with page delimiters, nothing more.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { getModel } from "../config/models.js";
import type { PdfChunk, BatchSubmission, ChunkExtractionResult, PageExtractionResult } from "./types.js";

const EXTRACTION_PROMPT = `Extract all text from these PDF pages. Preserve structure: headings, lists, tables, stat blocks. Output as markdown.

Separate each page with a delimiter line in this exact format:

---PAGE {n}---

where {n} is the page number. Start with the first page in the document.

Do not add any commentary, preamble, or summary. Only output the extracted text with page delimiters.`;

/**
 * Build batch request items from PDF chunks.
 *
 * Each chunk becomes one batch request item containing the PDF as a
 * document content block. The custom_id encodes the job ID and chunk index
 * for matching results back to jobs.
 */
export function buildBatchRequests(
  jobId: string,
  chunks: PdfChunk[],
): Anthropic.Messages.Batches.BatchCreateParams.Request[] {
  const model = getModel("small");

  return chunks.map((chunk) => ({
    custom_id: `${jobId}_chunk-${chunk.index}`,
    params: {
      model,
      max_tokens: 16384,
      messages: [
        {
          role: "user" as const,
          content: [
            {
              type: "document" as const,
              source: {
                type: "base64" as const,
                media_type: "application/pdf" as const,
                data: chunk.pdfBase64,
              },
            },
            {
              type: "text" as const,
              text: EXTRACTION_PROMPT,
            },
          ],
        },
      ],
    },
  }));
}

/**
 * Submit a batch of extraction requests to the Anthropic Batch API.
 *
 * @returns BatchSubmission with the batch ID and a map from custom_id to job/chunk info.
 */
export async function submitBatch(
  client: Anthropic,
  requests: Anthropic.Messages.Batches.BatchCreateParams.Request[],
  jobId: string,
  chunks: PdfChunk[],
): Promise<BatchSubmission> {
  const batch = await client.messages.batches.create({ requests });

  const chunkMap: BatchSubmission["chunkMap"] = {};
  for (const chunk of chunks) {
    const customId = `${jobId}_chunk-${chunk.index}`;
    chunkMap[customId] = { jobId, chunkIndex: chunk.index };
  }

  return { batchId: batch.id, chunkMap };
}

/**
 * Poll a batch until it reaches a terminal state.
 *
 * @param pollIntervalMs - How often to check (default 5 seconds).
 * @param onProgress - Optional callback with current request counts.
 * @returns The final batch object.
 */
export async function pollBatch(
  client: Anthropic,
  batchId: string,
  pollIntervalMs: number = 5000,
  onProgress?: (counts: Anthropic.Messages.Batches.MessageBatchRequestCounts) => void,
): Promise<Anthropic.Messages.Batches.MessageBatch> {
  while (true) {
    const batch = await client.messages.batches.retrieve(batchId);

    if (onProgress) {
      onProgress(batch.request_counts);
    }

    if (batch.processing_status === "ended") {
      return batch;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * Collect results from a completed batch.
 *
 * Iterates through the JSONL result stream and parses each response into
 * extracted pages. Handles succeeded, errored, canceled, and expired results.
 */
export async function collectResults(
  client: Anthropic,
  batchId: string,
): Promise<ChunkExtractionResult[]> {
  const results: ChunkExtractionResult[] = [];
  const decoder = await client.messages.batches.results(batchId);

  for await (const item of decoder) {
    const { custom_id, result } = item;

    if (result.type === "succeeded") {
      const text = result.message.content
        .filter((block): block is Anthropic.Messages.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n");

      results.push({
        customId: custom_id,
        pages: parsePageDelimiters(text, custom_id),
      });
    } else if (result.type === "errored") {
      results.push({
        customId: custom_id,
        error: `API error: ${result.error.error.type} — ${result.error.error.message}`,
      });
    } else {
      // canceled or expired
      results.push({
        customId: custom_id,
        error: `Request ${result.type}`,
      });
    }
  }

  return results;
}

/**
 * Parse the page-delimited text output from Haiku into individual pages.
 *
 * Expected format:
 *   ---PAGE 1---
 *   (page 1 content)
 *   ---PAGE 2---
 *   (page 2 content)
 *   ...
 */
export function parsePageDelimiters(
  text: string,
  customId: string,
): PageExtractionResult[] {
  // Match ---PAGE {n}--- with flexible whitespace
  const delimiter = /^---PAGE\s+(\d+)---\s*$/gm;
  const pages: PageExtractionResult[] = [];

  const splits: { pageNumber: number; startIndex: number }[] = [];
  let match: RegExpExecArray | null;

  while ((match = delimiter.exec(text)) !== null) {
    splits.push({
      pageNumber: parseInt(match[1], 10),
      startIndex: match.index + match[0].length,
    });
  }

  if (splits.length === 0) {
    // No delimiters found — treat entire text as one page.
    // Parse the chunk index from the custom_id to determine the start page.
    const chunkMatch = customId.match(/chunk-(\d+)/);
    const pageNum = chunkMatch ? parseInt(chunkMatch[1], 10) * 30 + 1 : 1;
    return [{ pageNumber: pageNum, text: text.trim() }];
  }

  for (let i = 0; i < splits.length; i++) {
    const start = splits[i].startIndex;
    const end = i + 1 < splits.length
      ? text.lastIndexOf("\n", text.indexOf("---PAGE", start + 1))
      : text.length;

    const pageText = text.slice(start, end >= start ? end : text.length).trim();
    pages.push({
      pageNumber: splits[i].pageNumber,
      text: pageText,
    });
  }

  return pages;
}
