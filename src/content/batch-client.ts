/**
 * Batch API client — generic helpers for the Anthropic Message Batches API.
 *
 * Used by the content processing pipeline (classifier, extractors) to
 * submit work to Haiku via batch. Handles batch creation, polling, and
 * result collection.
 *
 * NOTE: PDF text extraction is now done locally (pdf-extract.ts). This
 * module is retained for the processing pipeline which needs AI for
 * understanding content, not reproducing it.
 */

import type Anthropic from "@anthropic-ai/sdk";

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
 * Collect text results from a completed batch.
 *
 * Iterates through the JSONL result stream and extracts text content
 * from each response. Returns an array of { customId, text?, error? }.
 */
export async function collectBatchResults(
  client: Anthropic,
  batchId: string,
): Promise<Array<{ customId: string; text?: string; error?: string }>> {
  const results: Array<{ customId: string; text?: string; error?: string }> = [];
  const decoder = await client.messages.batches.results(batchId);

  for await (const item of decoder) {
    const { custom_id, result } = item;

    if (result.type === "succeeded") {
      const text = result.message.content
        .filter((block): block is Anthropic.Messages.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n");

      results.push({ customId: custom_id, text });
    } else if (result.type === "errored") {
      results.push({
        customId: custom_id,
        error: `API error: ${result.error.error.type} — ${result.error.error.message}`,
      });
    } else {
      results.push({
        customId: custom_id,
        error: `Request ${result.type}`,
      });
    }
  }

  return results;
}
