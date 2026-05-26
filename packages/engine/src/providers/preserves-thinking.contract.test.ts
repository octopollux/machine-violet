/**
 * Cross-provider contract: every provider that can carry reasoning across
 * turns must round-trip it through `assistantContent` correctly. Issue #533.
 *
 * The reasoning continuity contract is the same shape on every provider that
 * supports it: a response decoder produces a ContentPart, that ContentPart
 * survives in conversation history, and the request encoder emits it back as
 * the provider's native block on the next turn. This test pins both halves
 * for every supported provider.
 *
 * Provider registry sits at the top so adding a new provider without
 * registering it here becomes a visible omission in code review. If a new
 * provider lands without reasoning support, register it with `supported: false`
 * and link the upstream limitation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { ChatParams, ContentPart, NormalizedMessage } from "./types.js";
import { TurnCollector, messageToResponsesItems } from "./openai-chatgpt/provider.js";
import type { RawResponseItemCompletedNotification } from "./openai-chatgpt/protocol.js";

// ---------------------------------------------------------------------------
// Provider registry — one entry per `conn.provider` enum value
// ---------------------------------------------------------------------------

interface CaptureResult { assistantContent: ContentPart[]; thinkingText?: string }

interface ProviderContract {
  /** Stable provider id from `conn.provider`. */
  name: string;
  /** Why we don't / can't test reasoning here (only set when supported is false). */
  unsupportedReason?: string;
  /**
   * Drive a "turn 1" through whichever entry point captures reasoning for
   * this provider. Returns the assistantContent the provider would persist.
   */
  captureTurn1?: () => Promise<CaptureResult>;
  /**
   * Drive a "turn 2" with the assistantContent from `captureTurn1` placed in
   * history. Returns the provider's outbound request payload — whatever shape
   * is natural for the provider (Anthropic messages, Responses-API input, …).
   * The per-provider assertion below inspects the shape.
   */
  encodeTurn2?: (turn1Content: ContentPart[]) => Promise<unknown>;
  /** Per-provider assertion that the encoded turn 2 reflects reasoning replay. */
  assertReplayed?: (encoded: unknown) => void;
}

const PROVIDERS: ProviderContract[] = [
  { name: "anthropic" },        // wired below — body filled out after mocks
  { name: "openai-apikey" },    // wired below
  { name: "openrouter", unsupportedReason: "shares the Responses-API path with openai-apikey; covered by that entry" },
  { name: "custom", unsupportedReason: "Chat Completions API has no opaque reasoning blob; see openai.ts comment" },
  { name: "openai-chatgpt" },   // wired below
];

// ---------------------------------------------------------------------------
// SDK mocks (anthropic + openai)
// ---------------------------------------------------------------------------

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

vi.mock("openai", () => {
  const responses = { create: vi.fn(), stream: vi.fn() };
  class MockOpenAI {
    responses = responses;
    chat = { completions: { create: vi.fn() } };
    static AuthenticationError = class extends Error {};
    static PermissionDeniedError = class extends Error {};
    static RateLimitError = class extends Error {};
  }
  return { default: MockOpenAI, __mockResponses: responses };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anthropicMod = await import("@anthropic-ai/sdk") as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const openaiMod = await import("openai") as any;

const mockAnthropicCreate: ReturnType<typeof vi.fn> = anthropicMod.__mockMessages.create;
const mockResponsesCreate: ReturnType<typeof vi.fn> = openaiMod.__mockResponses.create;

const { createAnthropicProvider } = await import("./anthropic.js");
const { createOpenAIProvider } = await import("./openai.js");

// ---------------------------------------------------------------------------
// Per-provider wiring
// ---------------------------------------------------------------------------

function baseParams(overrides: Partial<ChatParams> = {}): ChatParams {
  return {
    model: "test-model",
    systemPrompt: "you are helpful",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 1024,
    ...overrides,
  };
}

// --- anthropic ---

const anthropicEntry = PROVIDERS.find((p) => p.name === "anthropic")!;
anthropicEntry.captureTurn1 = async () => {
  // Fake a thinking + text response from claude.
  const fakeMsg = {
    id: "msg_1",
    model: "claude-opus-4-7",
    role: "assistant",
    type: "message",
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
    content: [
      { type: "thinking", thinking: "Counting...", signature: "sig-abc" },
      { type: "text", text: "4" },
    ],
  } as unknown as Anthropic.Message;
  mockAnthropicCreate.mockResolvedValue(fakeMsg);
  const provider = createAnthropicProvider("test-key");
  const result = await provider.chat(baseParams({ messages: [{ role: "user", content: "2+2?" }] }));
  return { assistantContent: result.assistantContent, thinkingText: result.thinkingText };
};
anthropicEntry.encodeTurn2 = async (turn1Content) => {
  mockAnthropicCreate.mockResolvedValue({
    id: "msg_2", model: "claude-opus-4-7", role: "assistant", type: "message",
    stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 },
    content: [{ type: "text", text: "6" }],
  } as unknown as Anthropic.Message);
  const provider = createAnthropicProvider("test-key");
  await provider.chat(baseParams({
    messages: [
      { role: "user", content: "2+2?" },
      { role: "assistant", content: turn1Content },
      { role: "user", content: "and 3+3?" },
    ],
  }));
  return mockAnthropicCreate.mock.calls.at(-1)?.[0];
};
anthropicEntry.assertReplayed = (encoded) => {
  // The assistant message (index 1) must contain a native Anthropic
  // thinking block, signature preserved.
  const e = encoded as { messages: { role: string; content: unknown }[] };
  const assistant = e.messages[1];
  expect(assistant.role).toBe("assistant");
  expect(assistant.content).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "thinking", thinking: "Counting...", signature: "sig-abc" }),
  ]));
};

// --- openai-apikey ---

const openaiEntry = PROVIDERS.find((p) => p.name === "openai-apikey")!;
openaiEntry.captureTurn1 = async () => {
  mockResponsesCreate.mockResolvedValue({
    id: "resp_1", model: "gpt-5", object: "response", status: "completed",
    created_at: 1, error: null, incomplete_details: null, instructions: null,
    metadata: null, parallel_tool_calls: true, temperature: 1, tool_choice: "auto",
    tools: [], top_p: 1,
    output: [
      {
        id: "rs_1", type: "reasoning",
        encrypted_content: "enc-blob-1",
        summary: [{ type: "summary_text", text: "Pondered." }],
      },
      {
        id: "msg_1", type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "4", annotations: [] }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 2 } },
  });
  const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
  const result = await provider.chat(baseParams({
    thinking: { effort: "high" },
    messages: [{ role: "user", content: "2+2?" }],
  }));
  return { assistantContent: result.assistantContent, thinkingText: result.thinkingText };
};
openaiEntry.encodeTurn2 = async (turn1Content) => {
  mockResponsesCreate.mockResolvedValue({
    id: "resp_2", model: "gpt-5", object: "response", status: "completed",
    created_at: 2, error: null, incomplete_details: null, instructions: null,
    metadata: null, parallel_tool_calls: true, temperature: 1, tool_choice: "auto",
    tools: [], top_p: 1, output: [],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
  });
  const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
  await provider.chat(baseParams({
    thinking: { effort: "high" },
    messages: [
      { role: "user", content: "2+2?" },
      { role: "assistant", content: turn1Content },
      { role: "user", content: "and 3+3?" },
    ],
  }));
  return mockResponsesCreate.mock.calls.at(-1)?.[0];
};
openaiEntry.assertReplayed = (encoded) => {
  const e = encoded as { input: { type: string; id?: string; encrypted_content?: string }[] };
  const reasoningItems = e.input.filter((i) => i.type === "reasoning");
  expect(reasoningItems).toHaveLength(1);
  expect(reasoningItems[0]).toMatchObject({ id: "rs_1", encrypted_content: "enc-blob-1" });
};

// --- openai-chatgpt ---
//
// The codex provider talks to a subprocess and full-provider mocking would
// require shimming the rpc + auth + binary modules. We test the same contract
// at the natural unit-level pair instead: TurnCollector consumes the
// notifications, messageToResponsesItems is what `splitHistoryAndUserInput`
// calls to encode injected history. Together they prove the same round-trip.

const codexEntry = PROVIDERS.find((p) => p.name === "openai-chatgpt")!;
codexEntry.captureTurn1 = async () => {
  const c = new TurnCollector();
  const note: RawResponseItemCompletedNotification = {
    threadId: "t1", turnId: "turn_1",
    item: {
      type: "reasoning", id: "rs_codex",
      encrypted_content: "enc-codex-1",
      summary: [{ type: "summary_text", text: "Pondered." }],
    },
  };
  c.onRawResponseItem(note);
  c.onItemCompleted({ threadId: "t1", turnId: "turn_1", completedAtMs: 0,
    item: { id: "msg_1", type: "agentMessage", text: "4" } });
  const result = c.toChatResult({ threadId: "t1",
    turn: { id: "turn_1", status: "completed", durationMs: 1, completedAt: 1 } });
  return { assistantContent: result.assistantContent, thinkingText: result.thinkingText };
};
codexEntry.encodeTurn2 = async (turn1Content) => {
  const msg: NormalizedMessage = { role: "assistant", content: turn1Content };
  return messageToResponsesItems(msg);
};
codexEntry.assertReplayed = (encoded) => {
  const items = encoded as { type: string; id?: string; encrypted_content?: string }[];
  const reasoningItems = items.filter((i) => i.type === "reasoning");
  expect(reasoningItems).toHaveLength(1);
  expect(reasoningItems[0]).toMatchObject({ id: "rs_codex", encrypted_content: "enc-codex-1" });
};

// ---------------------------------------------------------------------------
// Contract test
// ---------------------------------------------------------------------------

const supported = PROVIDERS.filter((p) => !p.unsupportedReason);

describe.each(supported)("$name preserves reasoning across turns (issue #533)", (entry) => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures a reasoning ContentPart on turn 1", async () => {
    const { assistantContent } = await entry.captureTurn1!();
    const hasReasoningBlock = assistantContent.some(
      (p) => p.type === "thinking" || p.type === "reasoning" || p.type === "redacted_thinking",
    );
    expect(hasReasoningBlock).toBe(true);
  });

  it("emits the reasoning block back in the turn-2 API request", async () => {
    const { assistantContent } = await entry.captureTurn1!();
    const encoded = await entry.encodeTurn2!(assistantContent);
    entry.assertReplayed!(encoded);
  });
});

describe("unsupported providers are explicitly documented", () => {
  // Lock in the rationale so a future contributor can't silently move a
  // provider out of "supported" without thinking about why.
  it.each(PROVIDERS.filter((p) => p.unsupportedReason))(
    "$name: $unsupportedReason",
    (entry) => {
      expect(entry.unsupportedReason).toBeTruthy();
      expect(entry.captureTurn1).toBeUndefined();
      expect(entry.encodeTurn2).toBeUndefined();
    },
  );
});
