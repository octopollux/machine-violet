import { createOpenAIProvider } from "./openai.js";
import type { ChatParams, NormalizedMessage } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseChatParams(overrides: Partial<ChatParams> = {}): ChatParams {
  return {
    model: "gpt-4o",
    systemPrompt: "You are a helpful assistant.",
    messages: [{ role: "user", content: "Hello" }],
    maxTokens: 1024,
    ...overrides,
  };
}

/** Minimal Responses API response shape. */
function fakeResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "resp_123",
    created_at: 1000,
    output_text: "Hi there!",
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: "gpt-4o",
    object: "response",
    output: [
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Hi there!", annotations: [] }],
      },
    ],
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    status: "completed",
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    ...overrides,
  };
}

/** Minimal Chat Completions response shape. */
function fakeChatCompletion(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-123",
    object: "chat.completion",
    created: 1000,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Hi there!" },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
    ...overrides,
  };
}

// =========================================================================
// Responses API path (openai-apikey, openrouter)
// =========================================================================

describe("OpenAI provider — Responses API", () => {
  describe("non-streaming chat", () => {
    it("creates provider with openai-apikey providerId", () => {
      const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
      expect(provider.providerId).toBe("openai-apikey");
    });

    it("routes openrouter to Responses API", () => {
      const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openrouter" });
      expect(provider.providerId).toBe("openrouter");
    });

    it("defaults providerId to openai-apikey", () => {
      const provider = createOpenAIProvider({ apiKey: "test-key" });
      expect(provider.providerId).toBe("openai-apikey");
    });
  });
});

// =========================================================================
// Chat Completions path (custom endpoints)
// =========================================================================

describe("OpenAI provider — Chat Completions", () => {
  it("routes custom provider to Chat Completions", () => {
    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "custom" });
    expect(provider.providerId).toBe("custom");
  });
});

// =========================================================================
// Integration-style tests using vi.mock to intercept the OpenAI SDK
// =========================================================================

// Mock the openai module
vi.mock("openai", () => {
  // Keep track of mock implementations set by tests
  const mockResponses = {
    create: vi.fn(),
    stream: vi.fn(),
  };
  const mockCompletions = {
    create: vi.fn(),
  };

  class MockOpenAI {
    responses = mockResponses;
    chat = { completions: mockCompletions };

    static AuthenticationError = class extends Error { };
    static PermissionDeniedError = class extends Error { };
    static RateLimitError = class extends Error { };
  }

  return {
    default: MockOpenAI,
    __mockResponses: mockResponses,
    __mockCompletions: mockCompletions,
  };
});

// Get the mock handles
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { __mockResponses: mockResponses, __mockCompletions: mockCompletions } = await import("openai") as any;

describe("Responses API integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps a simple text response", async () => {
    mockResponses.create.mockResolvedValue(fakeResponse());

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
    const result = await provider.chat(baseChatParams());

    expect(result.text).toBe("Hi there!");
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe("end");
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.usage.cacheReadTokens).toBe(3);
    expect(result.usage.reasoningTokens).toBe(0);
    expect(result.assistantContent).toEqual([{ type: "text", text: "Hi there!" }]);
  });

  it("maps tool calls from response output", async () => {
    mockResponses.create.mockResolvedValue(fakeResponse({
      output_text: "",
      output: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_abc",
          name: "get_weather",
          arguments: '{"city":"London"}',
          status: "completed",
        },
      ],
      status: "completed",
    }));

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
    const result = await provider.chat(baseChatParams());

    expect(result.toolCalls).toEqual([
      { id: "call_abc", name: "get_weather", input: { city: "London" } },
    ]);
    expect(result.stopReason).toBe("tool_use");
    expect(result.assistantContent).toEqual([
      { type: "tool_use", id: "call_abc", name: "get_weather", input: { city: "London" } },
    ]);
  });

  it("handles malformed tool call arguments", async () => {
    mockResponses.create.mockResolvedValue(fakeResponse({
      output_text: "",
      output: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_bad",
          name: "broken",
          arguments: "{not json",
          status: "completed",
        },
      ],
    }));

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
    const result = await provider.chat(baseChatParams());

    expect(result.toolCalls[0].input).toHaveProperty("_parse_error");
  });

  it("maps incomplete status with max_output_tokens to length", async () => {
    mockResponses.create.mockResolvedValue(fakeResponse({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    }));

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
    const result = await provider.chat(baseChatParams());

    expect(result.stopReason).toBe("length");
  });

  it("maps incomplete status with content_filter to refusal", async () => {
    mockResponses.create.mockResolvedValue(fakeResponse({
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
    }));

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
    const result = await provider.chat(baseChatParams());

    expect(result.stopReason).toBe("refusal");
  });

  it("sends instructions from system prompt", async () => {
    mockResponses.create.mockResolvedValue(fakeResponse());

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
    await provider.chat(baseChatParams({ systemPrompt: "Be concise." }));

    const callArgs = mockResponses.create.mock.calls[0][0];
    expect(callArgs.instructions).toBe("Be concise.");
  });

  it("joins system blocks into instructions", async () => {
    mockResponses.create.mockResolvedValue(fakeResponse());

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
    await provider.chat(baseChatParams({
      systemPrompt: [
        { text: "First block." },
        { text: "Second block." },
      ],
    }));

    const callArgs = mockResponses.create.mock.calls[0][0];
    expect(callArgs.instructions).toBe("First block.\n\nSecond block.");
  });

  it("maps tools to flat function format", async () => {
    mockResponses.create.mockResolvedValue(fakeResponse());

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
    await provider.chat(baseChatParams({
      tools: [{
        name: "search",
        description: "Search the web",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      }],
    }));

    const callArgs = mockResponses.create.mock.calls[0][0];
    expect(callArgs.tools).toEqual([{
      type: "function",
      name: "search",
      description: "Search the web",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      strict: false,
    }]);
  });

  it("maps reasoning config with effort", async () => {
    mockResponses.create.mockResolvedValue(fakeResponse());

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
    await provider.chat(baseChatParams({ thinking: { effort: "high" } }));

    const callArgs = mockResponses.create.mock.calls[0][0];
    expect(callArgs.reasoning).toEqual({ effort: "high", summary: "concise" });
  });

  it("maps max effort to xhigh", async () => {
    mockResponses.create.mockResolvedValue(fakeResponse());

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
    await provider.chat(baseChatParams({ thinking: { effort: "max" } }));

    const callArgs = mockResponses.create.mock.calls[0][0];
    expect(callArgs.reasoning.effort).toBe("xhigh");
  });

  it("converts assistant tool_use messages to function_call input items", async () => {
    mockResponses.create.mockResolvedValue(fakeResponse());

    const messages: NormalizedMessage[] = [
      { role: "user", content: "What's the weather?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "call_1", name: "weather", input: { city: "NYC" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "72°F and sunny" },
        ],
      },
    ];

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
    await provider.chat(baseChatParams({ messages }));

    const callArgs = mockResponses.create.mock.calls[0][0];
    const input = callArgs.input;

    // User message
    expect(input[0]).toEqual({ type: "message", role: "user", content: "What's the weather?" });
    // Assistant text
    expect(input[1]).toEqual({ type: "message", role: "assistant", content: "Let me check." });
    // Function call
    expect(input[2]).toEqual({
      type: "function_call",
      call_id: "call_1",
      name: "weather",
      arguments: '{"city":"NYC"}',
    });
    // Function call output
    expect(input[3]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "72°F and sunny",
    });
  });

  it("preserves ordering for interleaved assistant text and tool_use content", async () => {
    mockResponses.create.mockResolvedValue(fakeResponse());

    const messages: NormalizedMessage[] = [
      { role: "user", content: "What's the weather and time?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking weather." },
          { type: "tool_use", id: "call_1", name: "weather", input: { city: "NYC" } },
          { type: "text", text: "Now checking time." },
          { type: "tool_use", id: "call_2", name: "time", input: { timezone: "EST" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "72°F and sunny" },
          { type: "tool_result", tool_use_id: "call_2", content: "3:00 PM" },
        ],
      },
    ];

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
    await provider.chat(baseChatParams({ messages }));

    const callArgs = mockResponses.create.mock.calls[0][0];
    const input = callArgs.input;

    expect(input[0]).toEqual({ type: "message", role: "user", content: "What's the weather and time?" });
    expect(input[1]).toEqual({ type: "message", role: "assistant", content: "Checking weather." });
    expect(input[2]).toEqual({ type: "function_call", call_id: "call_1", name: "weather", arguments: '{"city":"NYC"}' });
    expect(input[3]).toEqual({ type: "message", role: "assistant", content: "Now checking time." });
    expect(input[4]).toEqual({ type: "function_call", call_id: "call_2", name: "time", arguments: '{"timezone":"EST"}' });
    expect(input[5]).toEqual({ type: "function_call_output", call_id: "call_1", output: "72°F and sunny" });
    expect(input[6]).toEqual({ type: "function_call_output", call_id: "call_2", output: "3:00 PM" });
  });

  it("sets store: false and max_output_tokens", async () => {
    mockResponses.create.mockResolvedValue(fakeResponse());

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
    await provider.chat(baseChatParams({ maxTokens: 2048 }));

    const callArgs = mockResponses.create.mock.calls[0][0];
    expect(callArgs.store).toBe(false);
    expect(callArgs.max_output_tokens).toBe(2048);
  });

  // -----------------------------------------------------------------------
  // Reasoning summary extraction
  //
  // The provider asks for `reasoning.summary: "concise"` whenever an effort
  // is set. The Responses API returns the summary as a `type: "reasoning"`
  // output item with `summary[]: { type: "summary_text"; text: string }`
  // entries. We surface these as `thinkingText` so context-dump's
  // `dumpThinking` accumulates a visible reasoning trace alongside the
  // request log — without this, the only sign that reasoning happened
  // is the `reasoningTokens` count in the usage block.
  // -----------------------------------------------------------------------

  it("extracts reasoning summaries into thinkingText", async () => {
    mockResponses.create.mockResolvedValue(fakeResponse({
      output: [
        {
          id: "rs_1",
          type: "reasoning",
          summary: [
            { type: "summary_text", text: "Considering the player's intent." },
            { type: "summary_text", text: "Picking a tone." },
          ],
        },
        {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "The door creaks open.", annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 50,
        output_tokens: 20,
        total_tokens: 70,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 128 },
      },
    }));

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
    const result = await provider.chat(baseChatParams());

    expect(result.text).toBe("The door creaks open.");
    expect(result.thinkingText).toBe("Considering the player's intent.\n\nPicking a tone.");
    expect(result.usage.reasoningTokens).toBe(128);
    // Reasoning items must NOT leak into assistantContent — that array is
    // persisted as conversation history and OpenAI's API rejects reasoning
    // blocks on the input side.
    expect(result.assistantContent).toEqual([
      { type: "text", text: "The door creaks open." },
    ]);
  });

  it("leaves thinkingText undefined when no reasoning items are present", async () => {
    mockResponses.create.mockResolvedValue(fakeResponse());

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
    const result = await provider.chat(baseChatParams());

    expect(result.thinkingText).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Encrypted reasoning replay
  //
  // With `store: false`, the Responses API doesn't retain reasoning state
  // server-side, so each turn the model would re-derive its chain of
  // thought from scratch. The fix is to ask for an encrypted reasoning
  // blob via `include: ["reasoning.encrypted_content"]`, persist it on
  // the assistant turn, and replay it as a `reasoning` input item on the
  // next request. These tests pin the request opt-in, the response
  // capture, and the round-trip.
  // -----------------------------------------------------------------------

  it("requests reasoning.encrypted_content when thinking effort is set", async () => {
    mockResponses.create.mockResolvedValue(fakeResponse());

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
    await provider.chat(baseChatParams({ thinking: { effort: "high" } }));

    const callArgs = mockResponses.create.mock.calls[0][0];
    expect(callArgs.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("does not request reasoning.encrypted_content without thinking effort", async () => {
    mockResponses.create.mockResolvedValue(fakeResponse());

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
    await provider.chat(baseChatParams());

    const callArgs = mockResponses.create.mock.calls[0][0];
    expect(callArgs.include).toBeUndefined();
  });

  it("captures encrypted reasoning into assistantContent for replay", async () => {
    // Reasoning item carries an `encrypted_content` blob — this must
    // round-trip through conversation history so the next turn can hand
    // it back to the model.
    mockResponses.create.mockResolvedValue(fakeResponse({
      output: [
        {
          id: "rs_1",
          type: "reasoning",
          encrypted_content: "enc-blob-1",
          summary: [{ type: "summary_text", text: "Weighing options." }],
        },
        {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Onward.", annotations: [] }],
        },
      ],
    }));

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
    const result = await provider.chat(baseChatParams({ thinking: { effort: "high" } }));

    expect(result.thinkingText).toBe("Weighing options.");
    expect(result.assistantContent).toEqual([
      { type: "reasoning", id: "rs_1", encryptedContent: "enc-blob-1", summary: ["Weighing options."] },
      { type: "text", text: "Onward." },
    ]);
  });

  it("does not push reasoning to assistantContent when encrypted_content is absent", async () => {
    // Without the opt-in, reasoning items still arrive (summaries) but
    // carry no encrypted blob. Persisting an empty shell would round-trip
    // back as an invalid input item, so we leave them out entirely —
    // only the summary text flows through `thinkingText`.
    mockResponses.create.mockResolvedValue(fakeResponse({
      output: [
        {
          id: "rs_1",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Thinking…" }],
        },
        {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Hi.", annotations: [] }],
        },
      ],
    }));

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
    const result = await provider.chat(baseChatParams());

    expect(result.thinkingText).toBe("Thinking…");
    expect(result.assistantContent).toEqual([{ type: "text", text: "Hi." }]);
  });

  it("replays persisted reasoning blocks as input items ahead of function_calls", async () => {
    // Simulate the second turn of a conversation: the prior assistant
    // turn had a reasoning block + tool_use, both captured into
    // assistantContent on turn N and persisted. On turn N+1 we feed that
    // history back in. The Responses API requires reasoning items before
    // their corresponding function_call within the same turn.
    mockResponses.create.mockResolvedValue(fakeResponse());

    const messages: NormalizedMessage[] = [
      { role: "user", content: "Roll for it." },
      {
        role: "assistant",
        content: [
          { type: "reasoning", id: "rs_prev", encryptedContent: "enc-prev", summary: ["Pondered."] },
          { type: "text", text: "Rolling…" },
          { type: "tool_use", id: "call_1", name: "roll_dice", input: { expression: "1d20" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "17" }],
      },
    ];

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
    await provider.chat(baseChatParams({ messages, thinking: { effort: "high" } }));

    const callArgs = mockResponses.create.mock.calls[0][0];
    const input = callArgs.input;

    // user → reasoning (first within the assistant turn) → assistant text → function_call → tool result
    expect(input[0]).toEqual({ type: "message", role: "user", content: "Roll for it." });
    expect(input[1]).toEqual({
      type: "reasoning",
      id: "rs_prev",
      encrypted_content: "enc-prev",
      summary: [{ type: "summary_text", text: "Pondered." }],
    });
    expect(input[2]).toEqual({ type: "message", role: "assistant", content: "Rolling…" });
    expect(input[3]).toEqual({
      type: "function_call",
      call_id: "call_1",
      name: "roll_dice",
      arguments: '{"expression":"1d20"}',
    });
    expect(input[4]).toEqual({ type: "function_call_output", call_id: "call_1", output: "17" });
  });

  it("emits reasoning items in order even when stored late in assistantContent", async () => {
    // Streaming pushes encrypted reasoning items at the END of the
    // assistantContent array (after text). toResponsesInput must still
    // emit them at the start of the turn's input items. Two reasoning
    // items must keep their relative order.
    mockResponses.create.mockResolvedValue(fakeResponse());

    const messages: NormalizedMessage[] = [
      { role: "user", content: "Go." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Going." },
          { type: "reasoning", id: "rs_a", encryptedContent: "enc-a", summary: [] },
          { type: "reasoning", id: "rs_b", encryptedContent: "enc-b", summary: [] },
        ],
      },
    ];

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
    await provider.chat(baseChatParams({ messages, thinking: { effort: "high" } }));

    const input = mockResponses.create.mock.calls[0][0].input;
    expect(input[0]).toEqual({ type: "message", role: "user", content: "Go." });
    // Both reasoning items, in original order, before the message.
    expect(input[1]).toEqual({ type: "reasoning", id: "rs_a", encrypted_content: "enc-a", summary: [] });
    expect(input[2]).toEqual({ type: "reasoning", id: "rs_b", encrypted_content: "enc-b", summary: [] });
    expect(input[3]).toEqual({ type: "message", role: "assistant", content: "Going." });
  });

  it("skips reasoning items with empty summaries", async () => {
    // Models can return reasoning items with no summary parts when reasoning
    // happened but produced nothing the model wanted to summarize. Don't emit
    // a thinkingText of "" — undefined is the right signal to dumpThinking.
    mockResponses.create.mockResolvedValue(fakeResponse({
      output: [
        { id: "rs_1", type: "reasoning", summary: [] },
        {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Hi.", annotations: [] }],
        },
      ],
    }));

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
    const result = await provider.chat(baseChatParams());

    expect(result.thinkingText).toBeUndefined();
    expect(result.text).toBe("Hi.");
  });

  it("inserts synthetic function_call_output for orphaned tool_use in history", async () => {
    // Pure-function behavior is covered in orphan-patch.test.ts; this asserts
    // the wiring in toResponsesParams so the request body stays API-valid.
    mockResponses.create.mockResolvedValue(fakeResponse());

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
    await provider.chat(baseChatParams({
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_orphan", name: "roll_dice", input: {} }],
        },
      ],
    }));

    const sent = mockResponses.create.mock.calls[0][0];
    // [user message, function_call, function_call_output stub]
    expect(sent.input).toHaveLength(3);
    expect(sent.input[2]).toEqual({
      type: "function_call_output",
      call_id: "call_orphan",
      output: "[no tool result recorded]",
    });
  });

  describe("streaming", () => {
    it("emits text deltas and returns final response", async () => {
      const response = fakeResponse();
      const events = [
        { type: "response.output_text.delta", delta: "Hi " },
        { type: "response.output_text.delta", delta: "there!" },
        { type: "response.completed", response },
      ];

      let eventIdx = 0;
      mockResponses.stream.mockReturnValue({
        [Symbol.asyncIterator]: () => ({
          next: async () =>
            eventIdx < events.length
              ? { value: events[eventIdx++], done: false }
              : { value: undefined, done: true },
        }),
        finalResponse: vi.fn().mockResolvedValue(response),
      });

      const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
      const deltas: string[] = [];
      const result = await provider.stream(baseChatParams(), (d) => deltas.push(d));

      expect(deltas).toEqual(["Hi ", "there!"]);
      expect(result.text).toBe("Hi there!");
      expect(result.stopReason).toBe("end");
    });

    it("captures reasoning summaries from streaming `summary_text.done` events", async () => {
      // The SDK's response stream accumulator doesn't handle the
      // `response.reasoning_summary_*` events — it ships the bare reasoning
      // item from `output_item.added` (with summary: []) and only later
      // overwrites the snapshot on `response.completed`. In practice that
      // means `finalResponse().output[i].summary` is empty even when the
      // model streamed summaries. The provider captures them from the
      // dedicated `.done` events in the streaming loop instead. This test
      // mocks an EMPTY summary array on finalResponse to prove that the
      // events are what produce `thinkingText`, not the output walk.
      const response = fakeResponse({
        output: [
          // Summary is empty here on purpose — see comment above.
          { id: "rs_1", type: "reasoning", summary: [] },
          {
            id: "msg_1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "You step forward.", annotations: [] }],
          },
        ],
      });
      const events = [
        { type: "response.output_text.delta", delta: "You step forward." },
        // Two summary parts, each terminated with a `.done` event.
        { type: "response.reasoning_summary_text.done", text: "Picking a path." },
        { type: "response.reasoning_summary_text.done", text: "Steeling the player." },
        { type: "response.completed", response },
      ];

      let eventIdx = 0;
      mockResponses.stream.mockReturnValue({
        [Symbol.asyncIterator]: () => ({
          next: async () =>
            eventIdx < events.length
              ? { value: events[eventIdx++], done: false }
              : { value: undefined, done: true },
        }),
        finalResponse: vi.fn().mockResolvedValue(response),
      });

      const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
      const result = await provider.stream(baseChatParams(), () => {});

      expect(result.text).toBe("You step forward.");
      // Multi-part summaries get joined with the same separator as the
      // non-streaming path uses for `output[i].summary` entries.
      expect(result.thinkingText).toBe("Picking a path.\n\nSteeling the player.");
    });

    it("captures encrypted reasoning from `output_item.done` events", async () => {
      // The SDK's response accumulator is unreliable for reasoning items
      // (the same hazard that affects `summary[]` also affects
      // `encrypted_content` on finalResponse). The streaming path
      // captures encrypted blobs directly from `output_item.done`
      // events. This test puts an EMPTY reasoning item on finalResponse
      // to prove the event-driven capture is what populates the
      // persisted assistant content, not the output walk.
      const response = fakeResponse({
        output: [
          { id: "rs_1", type: "reasoning", summary: [] },
          {
            id: "msg_1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Onward.", annotations: [] }],
          },
        ],
      });
      const events = [
        { type: "response.output_text.delta", delta: "Onward." },
        { type: "response.reasoning_summary_text.done", text: "Weighed it." },
        {
          type: "response.output_item.done",
          item: {
            id: "rs_1",
            type: "reasoning",
            encrypted_content: "enc-stream-1",
            summary: [{ type: "summary_text", text: "Weighed it." }],
          },
        },
        { type: "response.completed", response },
      ];

      let eventIdx = 0;
      mockResponses.stream.mockReturnValue({
        [Symbol.asyncIterator]: () => ({
          next: async () =>
            eventIdx < events.length
              ? { value: events[eventIdx++], done: false }
              : { value: undefined, done: true },
        }),
        finalResponse: vi.fn().mockResolvedValue(response),
      });

      const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
      const result = await provider.stream(baseChatParams({ thinking: { effort: "high" } }), () => {});

      expect(result.text).toBe("Onward.");
      expect(result.thinkingText).toBe("Weighed it.");
      expect(result.assistantContent).toEqual([
        { type: "text", text: "Onward." },
        { type: "reasoning", id: "rs_1", encryptedContent: "enc-stream-1", summary: ["Weighed it."] },
      ]);
    });

    it("leaves thinkingText undefined when no summary events fire", async () => {
      // Reasoning may happen with no summary parts emitted (model returned
      // an empty summary array for the part). The non-streaming sibling
      // test pins the same invariant — undefined, not "".
      const response = fakeResponse({
        output: [
          { id: "rs_1", type: "reasoning", summary: [] },
          {
            id: "msg_1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Hi.", annotations: [] }],
          },
        ],
      });
      const events = [
        { type: "response.output_text.delta", delta: "Hi." },
        { type: "response.completed", response },
      ];

      let eventIdx = 0;
      mockResponses.stream.mockReturnValue({
        [Symbol.asyncIterator]: () => ({
          next: async () =>
            eventIdx < events.length
              ? { value: events[eventIdx++], done: false }
              : { value: undefined, done: true },
        }),
        finalResponse: vi.fn().mockResolvedValue(response),
      });

      const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
      const result = await provider.stream(baseChatParams(), () => {});

      expect(result.thinkingText).toBeUndefined();
    });
  });
});

// =========================================================================
// Chat Completions integration (custom provider)
// =========================================================================

describe("Chat Completions integration (custom provider)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses chat.completions.create for custom provider", async () => {
    mockCompletions.create.mockResolvedValue(fakeChatCompletion());

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "custom" });
    const result = await provider.chat(baseChatParams());

    expect(mockCompletions.create).toHaveBeenCalled();
    expect(mockResponses.create).not.toHaveBeenCalled();
    expect(result.text).toBe("Hi there!");
    expect(result.stopReason).toBe("end");
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.usage.cacheReadTokens).toBe(2);
  });

  it("maps tool_calls finish reason", async () => {
    mockCompletions.create.mockResolvedValue(fakeChatCompletion({
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "tc_1",
            type: "function",
            function: { name: "search", arguments: '{"q":"test"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }));

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "custom" });
    const result = await provider.chat(baseChatParams());

    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toEqual([
      { id: "tc_1", name: "search", input: { q: "test" } },
    ]);
  });

  it("maps system prompt to system message", async () => {
    mockCompletions.create.mockResolvedValue(fakeChatCompletion());

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "custom" });
    await provider.chat(baseChatParams({ systemPrompt: "You are a pirate." }));

    const callArgs = mockCompletions.create.mock.calls[0][0];
    expect(callArgs.messages[0]).toEqual({ role: "system", content: "You are a pirate." });
  });

  it("inserts synthetic tool message for orphaned tool_use in history", async () => {
    // Pure-function behavior is covered in orphan-patch.test.ts; this asserts
    // the wiring in toOpenAIParams so the request body stays API-valid.
    mockCompletions.create.mockResolvedValue(fakeChatCompletion());

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "custom" });
    await provider.chat(baseChatParams({
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_orphan", name: "roll_dice", input: {} }],
        },
      ],
    }));

    const sent = mockCompletions.create.mock.calls[0][0];
    // [system, user, assistant w/ tool_calls, tool result stub]
    expect(sent.messages).toHaveLength(4);
    expect(sent.messages[3]).toEqual({
      role: "tool",
      tool_call_id: "call_orphan",
      content: "[no tool result recorded]",
    });
  });
});

// =========================================================================
// Health check
// =========================================================================

describe("health check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses responses.create for openai provider", async () => {
    mockResponses.create.mockResolvedValue(fakeResponse());

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-apikey" });
    const result = await provider.healthCheck();

    expect(result.status).toBe("valid");
    expect(mockResponses.create).toHaveBeenCalled();
    const callArgs = mockResponses.create.mock.calls[0][0];
    expect(callArgs.input).toBe(".");
    expect(callArgs.max_output_tokens).toBe(16);
    expect(callArgs.store).toBe(false);
  });

  it("uses chat.completions.create for custom provider", async () => {
    mockCompletions.create.mockResolvedValue(fakeChatCompletion());

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "custom" });
    const result = await provider.healthCheck();

    expect(result.status).toBe("valid");
    expect(mockCompletions.create).toHaveBeenCalled();
    expect(mockResponses.create).not.toHaveBeenCalled();
  });
});
