import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression for issue #712: on the Anthropic path, non-streaming subagent
 * calls (scribe, style_scene, …) failed with
 *
 *   "Streaming is required for operations that may take longer than 10 minutes."
 *
 * The SDK throws that from `calculateNonstreamingTimeout` — a purely
 * client-side guard on `messages.create()` — whenever `max_tokens` is large
 * enough that the request *could* exceed the 10-minute ceiling. Thinking bumps
 * `max_tokens` to the model max (128000 on Opus), so heavy subagent calls trip
 * it and throw before any HTTP request. The fix routes every call — streaming
 * or not — through `client.messages.stream(...).finalMessage()`, which has no
 * such ceiling.
 *
 * These tests mock the SDK so `messages.create()` faithfully reproduces the
 * guard (throws on large max_tokens) and `messages.stream()` succeeds, then
 * assert that `provider.chat()` (the non-streaming entry subagents use) never
 * touches `create()` and resolves cleanly.
 */

const hoisted = vi.hoisted(() => {
  function makeMessage(body: { model: string }) {
    return {
      id: "msg_test",
      model: body.model,
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  }
  // Rate-limit headers ride on this; return null for all so captureRateLimits
  // no-ops (parseAnthropicRateLimits → null).
  const httpResponse = { headers: { get: () => null } };

  // Faithful stand-in for the SDK's client-side non-streaming guard
  // (client.js `_calculateNonstreamingTimeout`): expectedTime =
  // 60min * max_tokens / 128000; if that exceeds 10min, throw. This is the
  // exact error text and threshold the real SDK uses — reproduced here so the
  // test fails loudly if the provider ever regresses to the create() path.
  const createSpy = vi.fn((body: { model: string; max_tokens: number }) => {
    const expectedTimeMs = (60 * 60 * 1000 * body.max_tokens) / 128000;
    if (expectedTimeMs > 10 * 60 * 1000) {
      throw new Error(
        "Streaming is required for operations that may take longer than 10 minutes. " +
          "See https://github.com/anthropics/anthropic-sdk-typescript#long-requests for more details",
      );
    }
    return { withResponse: async () => ({ data: makeMessage(body), response: httpResponse }) };
  });

  const streamSpy = vi.fn((body: { model: string }) => ({
    on: () => {},
    finalMessage: async () => makeMessage(body),
    get response() {
      return httpResponse;
    },
  }));

  return { createSpy, streamSpy };
});

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: hoisted.createSpy, stream: hoisted.streamSpy };
  }
  return { default: MockAnthropic };
});

import { createAnthropicProvider } from "./anthropic.js";
import type { ChatParams } from "./types.js";

function params(overrides?: Partial<ChatParams>): ChatParams {
  return {
    model: "claude-opus-4-6",
    systemPrompt: "You are the scribe.",
    messages: [{ role: "user", content: "persist this" }],
    maxTokens: 1024,
    ...overrides,
  };
}

describe("createAnthropicProvider: non-streaming calls avoid the 10-min guard (issue #712)", () => {
  beforeEach(() => {
    hoisted.createSpy.mockClear();
    hoisted.streamSpy.mockClear();
  });

  it("does not throw when max_tokens is large — routes through stream, never create", async () => {
    const provider = createAnthropicProvider("test-key");
    // Above the SDK's ~21k non-streaming ceiling; the old create() path threw here.
    const result = await provider.chat(params({ maxTokens: 64000 }));

    expect(result.text).toBe("ok");
    expect(hoisted.streamSpy).toHaveBeenCalledTimes(1);
    expect(hoisted.createSpy).not.toHaveBeenCalled();

    // Guard the guard: the mocked create() really would have thrown on these
    // tokens, so a regression to the create() path can't pass silently.
    expect(() => hoisted.createSpy({ model: "claude-opus-4-6", max_tokens: 64000 })).toThrow(
      /Streaming is required/,
    );
  });

  it("survives the thinking-driven max_tokens bump (128000 on Opus) that first surfaced the bug", async () => {
    // Reproduces the reported repro shape: an Opus subagent with thinking
    // enabled. toAnthropicParams bumps max_tokens to the model max (128000),
    // which is far above the guard threshold.
    const provider = createAnthropicProvider("test-key");
    const result = await provider.chat(params({ thinking: { effort: "medium" } }));

    expect(result.text).toBe("ok");
    expect(hoisted.streamSpy).toHaveBeenCalledTimes(1);
    expect(hoisted.streamSpy.mock.calls[0][0]).toMatchObject({ max_tokens: 128000 });
    expect(hoisted.createSpy).not.toHaveBeenCalled();
  });

  it("streaming callers (onDelta) also go through stream", async () => {
    const provider = createAnthropicProvider("test-key");
    const deltas: string[] = [];
    const result = await provider.stream(params({ maxTokens: 64000 }), (t) => deltas.push(t));

    expect(result.text).toBe("ok");
    expect(hoisted.streamSpy).toHaveBeenCalledTimes(1);
    expect(hoisted.createSpy).not.toHaveBeenCalled();
  });
});
