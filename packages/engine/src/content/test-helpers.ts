/**
 * Shared test helpers for the content pipeline tests.
 *
 * The pipeline now takes an LLMProvider for synchronous calls (merge / index /
 * rule-card-gen) and a raw Anthropic client for the Batch API stages
 * (classifier / extractors). These helpers keep test fixtures terse.
 */
import { vi } from "vitest";
import type { LLMProvider, ChatResult } from "../providers/types.js";

/**
 * Build a stub LLMProvider whose `chat()` always returns the given text.
 * Sufficient for content-pipeline tests, which only ever invoke `oneShot`.
 */
export function makeMockProvider(textOrFn: string | (() => string)): LLMProvider {
  const next = typeof textOrFn === "function" ? textOrFn : () => textOrFn;
  const result = (): ChatResult => ({
    text: next(),
    toolCalls: [],
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 },
    stopReason: "end",
    assistantContent: [],
  });
  return {
    providerId: "test",
    chat: vi.fn(async () => result()),
    stream: vi.fn(async (_p, onDelta) => { const r = result(); onDelta(r.text); return r; }),
    healthCheck: vi.fn(async () => ({ status: "valid", message: "ok" })),
  };
}
