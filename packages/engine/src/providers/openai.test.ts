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
// Responses API path (openai, openai-oauth, openrouter)
// =========================================================================

describe("OpenAI provider — Responses API", () => {
  describe("non-streaming chat", () => {
    it("creates provider with openai providerId", () => {
      const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai" });
      expect(provider.providerId).toBe("openai");
    });

    it("routes openai-oauth to Responses API", () => {
      const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai-oauth" });
      expect(provider.providerId).toBe("openai-oauth");
    });

    it("routes openrouter to Responses API", () => {
      const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openrouter" });
      expect(provider.providerId).toBe("openrouter");
    });

    it("defaults providerId to openai", () => {
      const provider = createOpenAIProvider({ apiKey: "test-key" });
      expect(provider.providerId).toBe("openai");
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

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai" });
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

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai" });
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

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai" });
    const result = await provider.chat(baseChatParams());

    expect(result.toolCalls[0].input).toHaveProperty("_parse_error");
  });

  it("maps incomplete status with max_output_tokens to length", async () => {
    mockResponses.create.mockResolvedValue(fakeResponse({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    }));

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai" });
    const result = await provider.chat(baseChatParams());

    expect(result.stopReason).toBe("length");
  });

  it("maps incomplete status with content_filter to refusal", async () => {
    mockResponses.create.mockResolvedValue(fakeResponse({
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
    }));

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai" });
    const result = await provider.chat(baseChatParams());

    expect(result.stopReason).toBe("refusal");
  });

  it("sends instructions from system prompt", async () => {
    mockResponses.create.mockResolvedValue(fakeResponse());

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai" });
    await provider.chat(baseChatParams({ systemPrompt: "Be concise." }));

    const callArgs = mockResponses.create.mock.calls[0][0];
    expect(callArgs.instructions).toBe("Be concise.");
  });

  it("joins system blocks into instructions", async () => {
    mockResponses.create.mockResolvedValue(fakeResponse());

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai" });
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

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai" });
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

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai" });
    await provider.chat(baseChatParams({ thinking: { effort: "high" } }));

    const callArgs = mockResponses.create.mock.calls[0][0];
    expect(callArgs.reasoning).toEqual({ effort: "high", summary: "concise" });
  });

  it("maps max effort to xhigh", async () => {
    mockResponses.create.mockResolvedValue(fakeResponse());

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai" });
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

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai" });
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

  it("sets store: false and max_output_tokens", async () => {
    mockResponses.create.mockResolvedValue(fakeResponse());

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai" });
    await provider.chat(baseChatParams({ maxTokens: 2048 }));

    const callArgs = mockResponses.create.mock.calls[0][0];
    expect(callArgs.store).toBe(false);
    expect(callArgs.max_output_tokens).toBe(2048);
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

      const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai" });
      const deltas: string[] = [];
      const result = await provider.stream(baseChatParams(), (d) => deltas.push(d));

      expect(deltas).toEqual(["Hi ", "there!"]);
      expect(result.text).toBe("Hi there!");
      expect(result.stopReason).toBe("end");
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

    const provider = createOpenAIProvider({ apiKey: "test-key", providerId: "openai" });
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
