import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ChatParams, ChatResult, LLMProvider, TierProvider } from "./types.js";
import type { ModelTier } from "@machine-violet/shared/types/engine.js";
import { __resetTapeModeForTest, getRecordedTape, wrapForRecording } from "./tape-mode.js";

function result(text: string): ChatResult {
  return {
    text,
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 },
    stopReason: "end",
    assistantContent: [{ type: "text", text }],
  };
}

function fakeProvider(id: string): LLMProvider {
  return {
    providerId: id,
    getCapabilities: () => ({ imageGeneration: false }),
    chat: vi.fn(async () => result(`${id}-reply`)),
    stream: vi.fn(async () => result(`${id}-reply`)),
    healthCheck: vi.fn(async () => ({ status: "valid", message: "ok" })),
  };
}

function params(conversationId: string): ChatParams {
  return { model: "m", systemPrompt: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 10, conversationId };
}

function tiers(large: LLMProvider, medium: LLMProvider, small: LLMProvider): Record<ModelTier, TierProvider> {
  return { large: { provider: large, model: "L" }, medium: { provider: medium, model: "M" }, small: { provider: small, model: "S" } };
}

describe("tape-mode record wiring", () => {
  beforeEach(() => { __resetTapeModeForTest(); });
  afterEach(() => {
    delete process.env.MV_TAPE_MODE;
    delete process.env.MV_TAPE_SCENARIO;
    __resetTapeModeForTest();
  });

  it("is a pass-through no-op when MV_TAPE_MODE is not 'record'", () => {
    const t = tiers(fakeProvider("a"), fakeProvider("b"), fakeProvider("c"));
    expect(wrapForRecording(t)).toBe(t); // same object, untouched
    expect(getRecordedTape()).toBeNull();
  });

  it("tapes calls across tiers into one tape, deduping a shared provider", async () => {
    process.env.MV_TAPE_MODE = "record";
    process.env.MV_TAPE_SCENARIO = "unit";

    const large = fakeProvider("large");
    const shared = fakeProvider("shared");
    const w = wrapForRecording(tiers(large, shared, shared));

    // medium + small share one inner provider → one wrapper instance.
    expect(w.medium.provider).toBe(w.small.provider);
    expect(w.large.provider).not.toBe(w.medium.provider);

    await w.large.provider.chat(params("dm"));
    await w.medium.provider.chat(params("scribe"));

    const tape = getRecordedTape();
    expect(tape?.scenario).toBe("unit");
    expect(tape?.entries.map((e) => e.bucket)).toEqual(["dm", "scribe"]);
  });
});
