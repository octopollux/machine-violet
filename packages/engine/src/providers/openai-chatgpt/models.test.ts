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


describe("paginated account catalogs", () => {
  const row = (id: string, model = id, hidden = false) => ({
    id, model, displayName: model, hidden, isDefault: false,
    defaultReasoningEffort: "medium" as const,
    supportedReasoningEfforts: [{ reasoningEffort: "max" as const, description: "deep" }],
    inputModalities: ["text" as const], supportsPersonality: false, additionalSpeedTiers: [],
  });
  it("follows opaque cursors and uses backend model IDs, including unknown future models", async () => {
    const call = vi.fn().mockResolvedValueOnce({data:[row("catalog-sol", "gpt-6.1-sol")], nextCursor:"page2"})
      .mockResolvedValueOnce({data:[row("catalog-future", "gpt-future"),row("hidden", "gpt-hidden", true)], nextCursor:null});
    const models = await listModels({call} as unknown as CodexRpcClient, {limit:1, includeHidden:true});
    expect(call).toHaveBeenNthCalledWith(2, "model/list", {limit:1, includeHidden:true, cursor:"page2"});
    expect(models.map((m) => [m.id,m.available])).toEqual([["gpt-6.1-sol",true],["gpt-future",true],["gpt-hidden",false]]);
    expect(models[0].aliases).toEqual(["catalog-sol"]);
    expect(models[1].aliases).toEqual(["catalog-future"]);
    expect(models[1].supportedReasoningEfforts).toEqual(["max"]);
  });

  it("distinguishes an explicitly empty effort list from an older server without metadata", async () => {
    const empty = row("empty", "gpt-empty");
    empty.supportedReasoningEfforts = [];
    const legacy = row("legacy", "gpt-legacy");
    const withoutEfforts: Partial<typeof legacy> = { ...legacy };
    delete withoutEfforts.supportedReasoningEfforts;
    const models = await listModels(fakeClient({ data: [empty, withoutEfforts] } as ModelListResult));
    expect(models[0].supportedReasoningEfforts).toEqual([]);
    expect(models[1]).not.toHaveProperty("supportedReasoningEfforts");
  });
  it("rejects repeated cursors instead of hanging discovery", async () => {
    const call = vi.fn().mockResolvedValue({data:[],nextCursor:"repeat"});
    await expect(listModels({call} as unknown as CodexRpcClient)).rejects.toThrow("repeated a pagination cursor");
    expect(call).toHaveBeenCalledTimes(2);
  });
});
