/**
 * Tests for the batch client utilities.
 *
 * These test the generic batch helpers that will be used by the
 * content processing pipeline (classifier, extractors).
 * PDF text extraction is now local (pdf-extract.ts).
 */

import { pollBatch } from "./batch-client.js";

describe("pollBatch", () => {
  it("returns immediately when batch is already ended", async () => {
    const mockClient = {
      messages: {
        batches: {
          retrieve: vi.fn().mockResolvedValue({
            id: "batch_123",
            processing_status: "ended",
            request_counts: { succeeded: 5, errored: 0, canceled: 0, expired: 0, processing: 0 },
          }),
        },
      },
    };

    const result = await pollBatch(mockClient as never, "batch_123", 100);
    expect(result.processing_status).toBe("ended");
    expect(mockClient.messages.batches.retrieve).toHaveBeenCalledTimes(1);
  });

  it("polls until batch ends", async () => {
    let callCount = 0;
    const mockClient = {
      messages: {
        batches: {
          retrieve: vi.fn().mockImplementation(async () => {
            callCount++;
            return {
              id: "batch_123",
              processing_status: callCount >= 3 ? "ended" : "in_progress",
              request_counts: {
                succeeded: callCount >= 3 ? 5 : callCount,
                errored: 0,
                canceled: 0,
                expired: 0,
                processing: callCount >= 3 ? 0 : 5 - callCount,
              },
            };
          }),
        },
      },
    };

    const progressCounts: number[] = [];
    const result = await pollBatch(mockClient as never, "batch_123", 10, (counts) => {
      progressCounts.push(counts.succeeded);
    });

    expect(result.processing_status).toBe("ended");
    expect(mockClient.messages.batches.retrieve).toHaveBeenCalledTimes(3);
    expect(progressCounts.length).toBe(3);
  });
});
