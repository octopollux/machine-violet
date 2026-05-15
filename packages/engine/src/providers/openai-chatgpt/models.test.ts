import { describe, it, expect, vi } from "vitest";
import { listModels } from "./models.js";
import type { CodexRpcClient } from "./rpc.js";
import type { ModelListResult } from "./protocol.js";

function fakeClient(payload: ModelListResult): CodexRpcClient {
  return {
    call: vi.fn(async () => payload),
  } as unknown as CodexRpcClient;
}

describe("listModels", () => {
  it("translates ModelInfo into DiscoveredCodexModel with reasoning effort metadata", async () => {
    const client = fakeClient({
      data: [
        {
          id: "gpt-5.5",
          model: "gpt-5.5",
          displayName: "GPT-5.5",
          description: "Frontier",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "fast" },
            { reasoningEffort: "medium", description: "balanced" },
            { reasoningEffort: "high", description: "deep" },
          ],
          inputModalities: ["text", "image"],
          supportsPersonality: true,
          additionalSpeedTiers: ["fast"],
        },
      ],
      nextCursor: null,
    });

    const models = await listModels(client);
    expect(models).toHaveLength(1);
    const m = models[0];
    expect(m.id).toBe("gpt-5.5");
    expect(m.displayName).toBe("GPT-5.5");
    expect(m.available).toBe(true);
    expect(m.isDefault).toBe(true);
    expect(m.defaultReasoningEffort).toBe("medium");
    expect(m.supportedReasoningEfforts).toEqual(["low", "medium", "high"]);
  });

  it("marks hidden models as unavailable", async () => {
    const client = fakeClient({
      data: [
        {
          id: "gpt-5.2",
          model: "gpt-5.2",
          displayName: "gpt-5.2",
          hidden: true,
          isDefault: false,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [],
          inputModalities: ["text"],
          supportsPersonality: false,
          additionalSpeedTiers: [],
        },
      ],
      nextCursor: null,
    });

    const models = await listModels(client);
    expect(models[0].available).toBe(false);
  });

  it("passes through limit/includeHidden options", async () => {
    const callSpy = vi.fn(async () => ({ data: [], nextCursor: null }));
    const client = { call: callSpy } as unknown as CodexRpcClient;
    await listModels(client, { limit: 5, includeHidden: true });
    expect(callSpy).toHaveBeenCalledWith("model/list", { limit: 5, includeHidden: true });
  });
});
