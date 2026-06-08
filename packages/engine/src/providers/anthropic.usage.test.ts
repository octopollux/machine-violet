/**
 * Anthropic rate-limit usage tracking (issue #464).
 *
 * Two layers:
 *   - Pure helpers: header parsing + UsageStatus shaping (thresholds,
 *     percentages, missing-limit suppression).
 *   - Integration: a mocked SDK proves the provider captures the
 *     `anthropic-ratelimit-*` headers off a chat() response and surfaces them
 *     via getUsageStatus(), with the missing-header fallback preserving the
 *     last good snapshot.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { ChatParams } from "./types.js";

// Mock the SDK so createAnthropicProvider builds against a fake client whose
// messages.create(...).withResponse() returns headers we control.
vi.mock("@anthropic-ai/sdk", () => {
  const messages = { create: vi.fn(), stream: vi.fn() };
  class MockAnthropic {
    messages = messages;
    static AuthenticationError = class extends Error {};
    static PermissionDeniedError = class extends Error {};
    static RateLimitError = class extends Error {};
    static APIError = class extends Error {};
  }
  return { default: MockAnthropic, __mockMessages: messages };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anthropicMod = await import("@anthropic-ai/sdk") as any;
const mockCreate: ReturnType<typeof vi.fn> = anthropicMod.__mockMessages.create;

const {
  createAnthropicProvider,
  parseAnthropicRateLimits,
  rateLimitsToUsageStatus,
} = await import("./anthropic.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeMessage(): Anthropic.Message {
  return {
    id: "msg_1",
    model: "claude-sonnet-4-6",
    role: "assistant",
    type: "message",
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
    content: [{ type: "text", text: "ok" }],
  } as unknown as Anthropic.Message;
}

/** Make create() return the SDK's withResponse() shape with the given headers. */
function mockResponseHeaders(headers: Headers): void {
  mockCreate.mockReturnValue({
    withResponse: () => Promise.resolve({
      data: fakeMessage(),
      response: { headers },
      request_id: "req_test",
    }),
  });
}

function ratelimitHeaders(v: {
  reqRemaining?: number; reqLimit?: number; tokRemaining?: number; tokLimit?: number;
}): Headers {
  const h = new Headers();
  if (v.reqRemaining !== undefined) h.set("anthropic-ratelimit-requests-remaining", String(v.reqRemaining));
  if (v.reqLimit !== undefined) h.set("anthropic-ratelimit-requests-limit", String(v.reqLimit));
  if (v.tokRemaining !== undefined) h.set("anthropic-ratelimit-tokens-remaining", String(v.tokRemaining));
  if (v.tokLimit !== undefined) h.set("anthropic-ratelimit-tokens-limit", String(v.tokLimit));
  return h;
}

function baseParams(): ChatParams {
  return {
    model: "claude-sonnet-4-6",
    systemPrompt: "you are helpful",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 1024,
  };
}

beforeEach(() => {
  mockCreate.mockReset();
});

// ---------------------------------------------------------------------------
// parseAnthropicRateLimits
// ---------------------------------------------------------------------------

describe("parseAnthropicRateLimits", () => {
  it("returns null when none of the rate-limit headers are present", () => {
    expect(parseAnthropicRateLimits(new Headers())).toBeNull();
  });

  it("parses a full header set", () => {
    const h = ratelimitHeaders({ reqRemaining: 30, reqLimit: 50, tokRemaining: 250000, tokLimit: 1000000 });
    expect(parseAnthropicRateLimits(h)).toEqual({
      requestsRemaining: 30,
      requestsLimit: 50,
      tokensRemaining: 250000,
      tokensLimit: 1000000,
    });
  });

  it("fills missing fields with 0 when only some headers are present", () => {
    const h = ratelimitHeaders({ reqRemaining: 30, reqLimit: 50 });
    expect(parseAnthropicRateLimits(h)).toEqual({
      requestsRemaining: 30,
      requestsLimit: 50,
      tokensRemaining: 0,
      tokensLimit: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// rateLimitsToUsageStatus
// ---------------------------------------------------------------------------

describe("rateLimitsToUsageStatus", () => {
  it("emits requests + tokens percentage segments with computed usedPercent", () => {
    const status = rateLimitsToUsageStatus(
      { requestsRemaining: 30, requestsLimit: 50, tokensRemaining: 250000, tokensLimit: 1000000 },
      1234,
    );
    expect(status).not.toBeNull();
    expect(status!.snapshotAt).toBe(1234);
    expect(status!.fresh).toBe(true);
    expect(status!.segments).toEqual([
      expect.objectContaining({ id: "requests", kind: "percentage", usedPercent: 40, status: "ok", source: "request-header" }),
      expect.objectContaining({ id: "tokens", kind: "percentage", usedPercent: 75, status: "ok" }),
    ]);
  });

  it("escalates status across the warning / critical / exceeded thresholds", () => {
    const statusFor = (remaining: number, limit: number): string =>
      rateLimitsToUsageStatus({ requestsRemaining: remaining, requestsLimit: limit, tokensRemaining: 0, tokensLimit: 0 }, 0)!
        .segments[0].status;
    expect(statusFor(50, 100)).toBe("ok");        // 50% used
    expect(statusFor(15, 100)).toBe("warning");   // 85% used
    expect(statusFor(3, 100)).toBe("critical");   // 97% used
    expect(statusFor(0, 100)).toBe("exceeded");   // 100% used
  });

  it("skips a segment whose limit is 0 (header absent / garbage)", () => {
    const status = rateLimitsToUsageStatus(
      { requestsRemaining: 0, requestsLimit: 0, tokensRemaining: 250000, tokensLimit: 1000000 },
      0,
    );
    expect(status!.segments.map((s) => s.id)).toEqual(["tokens"]);
  });

  it("returns null when neither limit is usable", () => {
    expect(rateLimitsToUsageStatus(
      { requestsRemaining: 0, requestsLimit: 0, tokensRemaining: 0, tokensLimit: 0 },
      0,
    )).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createAnthropicProvider — integration
// ---------------------------------------------------------------------------

describe("createAnthropicProvider: getUsageStatus", () => {
  it("reports no usage before any request", () => {
    const provider = createAnthropicProvider("test-key");
    expect(provider.getUsageStatus?.()).toBeNull();
  });

  it("surfaces rate-limit segments after a chat() response carrying the headers", async () => {
    mockResponseHeaders(ratelimitHeaders({ reqRemaining: 30, reqLimit: 50, tokRemaining: 250000, tokLimit: 1000000 }));
    const provider = createAnthropicProvider("test-key");
    await provider.chat(baseParams());

    const usage = provider.getUsageStatus?.();
    expect(usage).not.toBeNull();
    expect(usage!.segments).toEqual([
      expect.objectContaining({ id: "requests", usedPercent: 40 }),
      expect.objectContaining({ id: "tokens", usedPercent: 75 }),
    ]);
  });

  it("keeps the last snapshot when a later response omits the headers (fallback)", async () => {
    const provider = createAnthropicProvider("test-key");

    mockResponseHeaders(ratelimitHeaders({ reqRemaining: 30, reqLimit: 50, tokRemaining: 250000, tokLimit: 1000000 }));
    await provider.chat(baseParams());

    // A subsequent header-less response (e.g. some error/retry paths) must not
    // blank the gauge — the previous snapshot stands.
    mockResponseHeaders(new Headers());
    await provider.chat(baseParams());

    const usage = provider.getUsageStatus?.();
    expect(usage!.segments.map((s) => s.usedPercent)).toEqual([40, 75]);
  });
});
