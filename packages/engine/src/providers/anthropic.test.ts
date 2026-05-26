import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { toAnthropicParams, extractCacheDiagnostics } from "./anthropic.js";
import type { ChatParams, NormalizedMessage } from "./types.js";
import * as engineLog from "../context/engine-log.js";

/**
 * Exercise the BP4 (messages) cache-stamp logic — the single most important
 * cache decision for the DM loop. Stamping on an ephemeral message poisons
 * the cache for the next player turn; these tests guard against that
 * regression specifically.
 */

function baseParams(overrides?: Partial<ChatParams>): ChatParams {
  return {
    model: "claude-sonnet-4-6",
    systemPrompt: "You are a helpful assistant.",
    messages: [],
    maxTokens: 1024,
    cacheHints: [{ target: "messages" }],
    ...overrides,
  };
}

/**
 * Extract cache_control presence per message index from the mapped Anthropic
 * messages — returns an array where true = stamped, false = not stamped.
 */
function stampedIndexes(mapped: ReturnType<typeof toAnthropicParams>["messages"]): boolean[] {
  return mapped.map((m) => {
    if (typeof m.content === "string") return false;
    return (m.content as Record<string, unknown>[]).some((b) => "cache_control" in b);
  });
}

describe("toAnthropicParams: messages cache stamp (BP4)", () => {
  it("stamps the last message when nothing is ephemeral", () => {
    const messages: NormalizedMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "what is 2+2?" },
    ];
    const out = toAnthropicParams(baseParams({ messages }));
    expect(stampedIndexes(out.messages)).toEqual([false, false, true]);
  });

  it("skips past an ephemeral last message and stamps the previous one", () => {
    // Fresh-turn shape: history ends at asst_N-1, new user has a volatile
    // <context> preamble. BP4 must land on asst_N-1 so cache prefix stays
    // valid on the next turn (when the user message bytes will be stripped).
    const messages: NormalizedMessage[] = [
      { role: "user", content: "turn 1 input" },
      { role: "assistant", content: "turn 1 response" },
      { role: "user", content: "<context>...</context>\n\nturn 2 input", ephemeral: true },
    ];
    const out = toAnthropicParams(baseParams({ messages }));
    expect(stampedIndexes(out.messages)).toEqual([false, true, false]);
  });

  it("skips multiple trailing ephemeral messages", () => {
    // Defensive — unlikely today, but the loop should keep skipping back.
    const messages: NormalizedMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "ephemeral 1", ephemeral: true },
      { role: "user", content: "ephemeral 2", ephemeral: true },
    ];
    const out = toAnthropicParams(baseParams({ messages }));
    expect(stampedIndexes(out.messages)).toEqual([false, true, false, false]);
  });

  it("within-round (rounds 2+): stamps on the latest tool_result", () => {
    // Mid-loop shape: the preamble-bearing user is still in history and
    // marked ephemeral, but the tail is the stored tool_result from the
    // previous round. That tail is stable and should be stamped.
    const messages: NormalizedMessage[] = [
      { role: "user", content: "prior turn" },
      { role: "assistant", content: "prior response" },
      { role: "user", content: "<context>...</context>\n\nturn input", ephemeral: true },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "roll_dice", input: { sides: 20 } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "17" }],
      },
    ];
    const out = toAnthropicParams(baseParams({ messages }));
    expect(stampedIndexes(out.messages)).toEqual([false, false, false, false, true]);
  });

  it("does not stamp when no cacheHint for messages is requested", () => {
    const messages: NormalizedMessage[] = [
      { role: "user", content: "hi", ephemeral: true },
    ];
    const out = toAnthropicParams(baseParams({ messages, cacheHints: [] }));
    expect(stampedIndexes(out.messages)).toEqual([false]);
  });

  it("stamps nothing when every message is ephemeral (degenerate)", () => {
    // Pathological input: don't stamp anything rather than poison cache.
    const messages: NormalizedMessage[] = [
      { role: "user", content: "a", ephemeral: true },
      { role: "user", content: "b", ephemeral: true },
    ];
    const out = toAnthropicParams(baseParams({ messages }));
    expect(stampedIndexes(out.messages)).toEqual([false, false]);
  });
});

describe("toAnthropicParams: thinking-block round-trip (issue #533)", () => {
  it("emits thinking ContentParts as native Anthropic thinking blocks with signature", () => {
    // Round-tripping a thinking block back to the API is what keeps the
    // model's reasoning alive across turns on Opus 4.5+ / Sonnet 4.6+.
    // The signature is opaque and must be preserved unchanged.
    const messages: NormalizedMessage[] = [
      { role: "user", content: "what is 2+2?" },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "Let me think...", signature: "sig-abc123" },
          { type: "text", text: "4" },
        ],
      },
      { role: "user", content: "and 3+3?" },
    ];
    const out = toAnthropicParams(baseParams({ messages, cacheHints: [] }));
    const assistant = out.messages[1];
    expect(Array.isArray(assistant.content)).toBe(true);
    expect(assistant.content).toEqual([
      { type: "thinking", thinking: "Let me think...", signature: "sig-abc123" },
      { type: "text", text: "4" },
    ]);
  });

  it("emits redacted_thinking ContentParts as native blocks carrying data", () => {
    // The data payload is opaque (and the API redacted any visible text)
    // but must round-trip for the model to maintain continuity past the
    // redacted reasoning step.
    const messages: NormalizedMessage[] = [
      { role: "user", content: "tell me about X" },
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "redacted-blob-xyz" },
          { type: "text", text: "I can help with X." },
        ],
      },
      { role: "user", content: "go on" },
    ];
    const out = toAnthropicParams(baseParams({ messages, cacheHints: [] }));
    expect(out.messages[1].content).toEqual([
      { type: "redacted_thinking", data: "redacted-blob-xyz" },
      { type: "text", text: "I can help with X." },
    ]);
  });

  it("skips OpenAI-shape reasoning blocks (Anthropic API would reject them)", () => {
    // Cross-provider history (e.g., user switched from openai-apikey to
    // anthropic mid-campaign) shouldn't 400 — `reasoning` ContentParts
    // are silently dropped on Anthropic's input side.
    const messages: NormalizedMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", id: "rs_1", encryptedContent: "blob", summary: ["thought"] },
          { type: "text", text: "hello" },
        ],
      },
      { role: "user", content: "again" },
    ];
    const out = toAnthropicParams(baseParams({ messages, cacheHints: [] }));
    expect(out.messages[1].content).toEqual([{ type: "text", text: "hello" }]);
  });
});

describe("toAnthropicParams: orphan-patch wiring", () => {
  it("inserts a synthetic tool_result user message and lands the BP4 stamp on it", () => {
    // End-to-end: an orphan-trailing history with no clean stable tail.
    // The synthetic stub IS the new stable tail, so the cache stamp should
    // land on it (not on the original trailing assistant, which would be
    // invalid both for the API and for cache purposes).
    // Pure-function behavior is covered in orphan-patch.test.ts.
    const messages: NormalizedMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "roll_dice", input: {} }],
      },
    ];
    const out = toAnthropicParams(baseParams({ messages }));
    expect(out.messages).toHaveLength(3);
    expect(out.messages[2].role).toBe("user");
    expect(out.messages[2].content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: "[no tool result recorded]",
        is_error: true,
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(stampedIndexes(out.messages)).toEqual([false, false, true]);
  });
});

/**
 * Exercise the four documented `diagnostics` states from the
 * cache-diagnosis-2026-04-07 beta and verify that only the actionable
 * `*_changed` reasons (the ones operators can fix) trigger the structured
 * `cache:miss` engine-log entry. The other states are returned-or-omitted
 * silently so the log doesn't fill up with non-bugs.
 */
describe("extractCacheDiagnostics", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  // Minimal Anthropic.Message stand-in: the function only reads `id`, `model`,
  // and (via cast) `diagnostics`. Build a permissive cast so each test can
  // attach whatever `diagnostics` shape it's exercising without re-listing
  // all the unused Message fields.
  function msg(diagnostics: unknown): Anthropic.Message {
    return {
      id: "msg_test",
      model: "claude-test",
      diagnostics,
    } as unknown as Anthropic.Message;
  }

  beforeEach(() => {
    logSpy = vi.spyOn(engineLog, "logEvent").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("returns undefined when the diagnostics field is absent (beta not enabled)", () => {
    const m = { id: "msg_x", model: "claude-test" } as unknown as Anthropic.Message;
    expect(extractCacheDiagnostics(m)).toBeUndefined();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("returns undefined when diagnostics is null (first turn or no divergence)", () => {
    expect(extractCacheDiagnostics(msg(null))).toBeUndefined();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("returns undefined when cache_miss_reason is null (comparison still pending)", () => {
    expect(extractCacheDiagnostics(msg({ cache_miss_reason: null }))).toBeUndefined();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("returns the reasonType + token count for an actionable *_changed miss", () => {
    const result = extractCacheDiagnostics(msg({
      cache_miss_reason: { type: "system_changed", cache_missed_input_tokens: 41850 },
    }));
    expect(result).toEqual({ reasonType: "system_changed", missedInputTokens: 41850 });
  });

  it("emits a cache:miss engine-log entry for *_changed reasons", () => {
    extractCacheDiagnostics(msg({
      cache_miss_reason: { type: "tools_changed", cache_missed_input_tokens: 1234 },
    }));
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith("cache:miss", expect.objectContaining({
      messageId: "msg_test",
      model: "claude-test",
      reasonType: "tools_changed",
      missedInputTokens: 1234,
    }));
  });

  it("omits missedInputTokens from the result when the API didn't include it", () => {
    const result = extractCacheDiagnostics(msg({
      cache_miss_reason: { type: "model_changed" },
    }));
    expect(result).toEqual({ reasonType: "model_changed" });
    // And the log entry omits missedInputTokens too rather than logging undefined.
    const logged = logSpy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(logged).not.toHaveProperty("missedInputTokens");
  });

  it("returns previous_message_not_found but does NOT emit a cache:miss log", () => {
    // Non-actionable: the prior request just wasn't on file (fingerprint
    // expired, different workspace, beta header missing on the prior call).
    // Surface it for the viewer's gray pill but don't pollute the log with
    // a "miss" entry — there's nothing in our prompts to fix.
    const result = extractCacheDiagnostics(msg({
      cache_miss_reason: { type: "previous_message_not_found" },
    }));
    expect(result).toEqual({ reasonType: "previous_message_not_found" });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("returns unavailable but does NOT emit a cache:miss log", () => {
    // Same rationale as previous_message_not_found — no comparison was
    // produced, not a prompt-prefix bug.
    const result = extractCacheDiagnostics(msg({
      cache_miss_reason: { type: "unavailable" },
    }));
    expect(result).toEqual({ reasonType: "unavailable" });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("returns undefined for a malformed cache_miss_reason missing a type", () => {
    // Defensive against future beta schema drift — if `type` is absent,
    // treat the whole object as uninterpretable rather than emitting a
    // pill with `reasonType: undefined`.
    expect(extractCacheDiagnostics(msg({
      cache_miss_reason: { cache_missed_input_tokens: 100 },
    }))).toBeUndefined();
    expect(logSpy).not.toHaveBeenCalled();
  });
});
