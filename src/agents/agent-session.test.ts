import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  runAgentLoop,
  retryDelay,
  extractStatus,
  stampToolsCacheControl,
  isTuiCommand,
} from "./agent-session.js";
import type { AgentSessionConfig } from "./agent-session.js";

// --- Test helpers ---

function mockUsage(input = 100, output = 50): Anthropic.Usage {
  return { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null, inference_geo: null, server_tool_use: null, service_tier: null };
}

function textMessage(text: string, usage?: Anthropic.Usage): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: usage ?? mockUsage(),
  } as Anthropic.Message;
}

function toolUseMessage(
  toolName: string,
  input: Record<string, unknown>,
  toolId = "toolu_test",
): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: [{ type: "tool_use", id: toolId, name: toolName, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: mockUsage(),
  } as Anthropic.Message;
}

function textAndToolMessage(
  text: string,
  toolName: string,
  input: Record<string, unknown>,
): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: [
      { type: "text", text },
      { type: "tool_use", id: "toolu_test", name: toolName, input },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: mockUsage(),
  } as Anthropic.Message;
}

function mockClient(responses: Anthropic.Message[]): Anthropic {
  let callIdx = 0;
  return {
    messages: {
      create: vi.fn(async () => responses[callIdx++]),
      stream: vi.fn(() => {
        const response = responses[callIdx++];
        return {
          on: vi.fn(),
          finalMessage: vi.fn(async () => response),
        };
      }),
    },
  } as unknown as Anthropic;
}

function baseConfig(overrides?: Partial<AgentSessionConfig>): AgentSessionConfig {
  return {
    name: "test",
    model: "claude-haiku-4-5-20251001",
    maxTokens: 1024,
    maxToolRounds: 5,
    stream: false,
    ...overrides,
  };
}

// --- Tests ---

describe("runAgentLoop", () => {
  describe("text-only responses", () => {
    it("returns text from a simple non-streaming response", async () => {
      const client = mockClient([textMessage("The door creaks open.")]);
      const result = await runAgentLoop(
        client,
        "You are a DM.",
        [{ role: "user", content: "I open the door." }],
        baseConfig(),
      );
      expect(result.text).toBe("The door creaks open.");
      expect(result.tuiCommands).toHaveLength(0);
      expect(result.truncated).toBe(false);
    });

    it("returns text from a streaming response", async () => {
      const client = mockClient([textMessage("Streaming response.")]);
      const onTextDelta = vi.fn();
      const result = await runAgentLoop(
        client,
        "System",
        [{ role: "user", content: "Hi" }],
        baseConfig({ stream: true, onTextDelta }),
      );
      expect(result.text).toBe("Streaming response.");
      expect(client.messages.stream).toHaveBeenCalled();
    });

    it("fires onTextDelta for text blocks in non-streaming mode", async () => {
      const client = mockClient([textMessage("Hello world")]);
      const onTextDelta = vi.fn();
      await runAgentLoop(
        client,
        "System",
        [{ role: "user", content: "Hi" }],
        baseConfig({ onTextDelta }),
      );
      expect(onTextDelta).toHaveBeenCalledWith("Hello world");
    });
  });

  describe("tool use loop", () => {
    it("handles tool_use -> tool_result -> text loop", async () => {
      const client = mockClient([
        toolUseMessage("roll_dice", { expression: "1d20+5" }),
        textMessage("You rolled a 17!"),
      ]);
      const toolHandler = vi.fn(() => ({ content: "1d20+5: [12]→17" }));
      const onToolStart = vi.fn();
      const onToolEnd = vi.fn();

      const result = await runAgentLoop(
        client,
        "System",
        [{ role: "user", content: "Roll" }],
        baseConfig({ toolHandler, onToolStart, onToolEnd }),
      );

      expect(onToolStart).toHaveBeenCalledWith("roll_dice");
      expect(onToolEnd).toHaveBeenCalledWith("roll_dice", expect.objectContaining({ content: "1d20+5: [12]→17" }));
      expect(result.text).toBe("You rolled a 17!");
    });

    it("handles text + tool_use in same response", async () => {
      const client = mockClient([
        textAndToolMessage("Rolling... ", "roll_dice", { expression: "1d20" }),
        textMessage("A natural 20!"),
      ]);
      const toolHandler = vi.fn(() => ({ content: "20" }));

      const result = await runAgentLoop(
        client,
        "System",
        [{ role: "user", content: "Roll" }],
        baseConfig({ toolHandler }),
      );
      expect(result.text).toBe("Rolling... A natural 20!");
    });

    it("handles async tool handlers", async () => {
      const client = mockClient([
        toolUseMessage("read_file", { path: "test.md" }),
        textMessage("File contents shown."),
      ]);
      const toolHandler = vi.fn(async () => ({ content: "file data" }));

      await runAgentLoop(
        client,
        "System",
        [{ role: "user", content: "Read file" }],
        baseConfig({ toolHandler }),
      );
      expect(toolHandler).toHaveBeenCalledWith("read_file", { path: "test.md" });
    });

    it("returns error for tool_use with no handler", async () => {
      const client = mockClient([
        toolUseMessage("unknown_tool", {}),
        textMessage("Done."),
      ]);
      const onToolEnd = vi.fn();

      await runAgentLoop(
        client,
        "System",
        [{ role: "user", content: "Do something" }],
        baseConfig({ onToolEnd }),
      );
      expect(onToolEnd).toHaveBeenCalledWith("unknown_tool", expect.objectContaining({ is_error: true }));
    });
  });

  describe("TUI command extraction", () => {
    it("collects TUI commands from tool calls", async () => {
      const client = mockClient([
        toolUseMessage("style_scene", { key_color: "#cc4444" }),
        textMessage("The mood shifts."),
      ]);
      const toolHandler = vi.fn(() => ({ content: JSON.stringify({ type: "style_scene", key_color: "#cc4444" }) }));

      const result = await runAgentLoop(
        client,
        "System",
        [{ role: "user", content: "Attack" }],
        baseConfig({ toolHandler, tuiToolNames: new Set(["style_scene"]) }),
      );

      expect(result.tuiCommands).toHaveLength(1);
      expect(result.tuiCommands[0].type).toBe("style_scene");
    });

    it("ignores non-TUI tool results", async () => {
      const client = mockClient([
        toolUseMessage("roll_dice", { expression: "1d20" }),
        textMessage("Done."),
      ]);
      const toolHandler = vi.fn(() => ({ content: "15" }));

      const result = await runAgentLoop(
        client,
        "System",
        [{ role: "user", content: "Roll" }],
        baseConfig({ toolHandler, tuiToolNames: new Set(["style_scene"]) }),
      );

      expect(result.tuiCommands).toHaveLength(0);
    });
  });

  describe("usage accumulation", () => {
    it("accumulates usage across rounds", async () => {
      const client = mockClient([
        toolUseMessage("roll_dice", { expression: "1d6" }),
        textMessage("Done."),
      ]);
      const toolHandler = vi.fn(() => ({ content: "3" }));

      const result = await runAgentLoop(
        client,
        "System",
        [{ role: "user", content: "Roll" }],
        baseConfig({ toolHandler }),
      );

      expect(result.usage.inputTokens).toBe(200);
      expect(result.usage.outputTokens).toBe(100);
    });

    it("calls onComplete with final usage", async () => {
      const client = mockClient([textMessage("Done.")]);
      const onComplete = vi.fn();

      await runAgentLoop(
        client,
        "System",
        [{ role: "user", content: "Go" }],
        baseConfig({ onComplete }),
      );

      expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
        inputTokens: 100,
        outputTokens: 50,
      }));
    });
  });

  describe("roundMessages tracking", () => {
    it("populates roundMessages for a single-round text response", async () => {
      const client = mockClient([textMessage("Hello.")]);
      const result = await runAgentLoop(
        client,
        "System",
        [{ role: "user", content: "Hi" }],
        baseConfig(),
      );
      expect(result.roundMessages).toHaveLength(1);
      expect(result.roundMessages[0].role).toBe("assistant");
    });

    it("populates roundMessages for multi-round tool interactions", async () => {
      const client = mockClient([
        toolUseMessage("roll_dice", { expression: "1d20" }),
        textMessage("You rolled a 17!"),
      ]);
      const toolHandler = vi.fn(() => ({ content: "1d20: [17]→17" }));

      const result = await runAgentLoop(
        client,
        "System",
        [{ role: "user", content: "Roll" }],
        baseConfig({ toolHandler }),
      );

      // Should have: assistant(tool_use), user(tool_result), assistant(text)
      expect(result.roundMessages).toHaveLength(3);
      expect(result.roundMessages[0].role).toBe("assistant");
      expect(result.roundMessages[1].role).toBe("user");
      expect(result.roundMessages[2].role).toBe("assistant");
    });
  });

  describe("max tool rounds truncation", () => {
    it("truncates at maxToolRounds", async () => {
      const infiniteTools = Array.from({ length: 3 }, () =>
        toolUseMessage("roll_dice", { expression: "1d6" }),
      );
      const client = mockClient(infiniteTools);
      const toolHandler = vi.fn(() => ({ content: "3" }));

      const result = await runAgentLoop(
        client,
        "System",
        [{ role: "user", content: "Roll a lot" }],
        baseConfig({ maxToolRounds: 3, toolHandler }),
      );

      expect(result.truncated).toBe(true);
    });
  });

  describe("thinking block filtering", () => {
    it("strips thinking blocks from conversation history", async () => {
      const thinkingPlusToolMsg: Anthropic.Message = {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5-20251001",
        content: [
          { type: "thinking", thinking: "Let me consider...", signature: "sig" } as unknown as Anthropic.ContentBlock,
          { type: "tool_use", id: "toolu_1", name: "roll_dice", input: { notation: "1d20" } },
        ] as Anthropic.ContentBlock[],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: mockUsage(),
      } as Anthropic.Message;

      const createFn = vi.fn()
        .mockResolvedValueOnce(thinkingPlusToolMsg)
        .mockResolvedValueOnce(textMessage("You rolled a 15!"));

      const client = { messages: { create: createFn } } as unknown as Anthropic;
      const toolHandler = vi.fn(() => ({ content: "15" }));

      await runAgentLoop(
        client,
        "System",
        [{ role: "user", content: "Roll" }],
        baseConfig({ toolHandler }),
      );

      // Second call should have the assistant message WITHOUT the thinking block
      const secondCallArgs = createFn.mock.calls[1][0] as { messages: Anthropic.MessageParam[] };
      const assistantMsg = secondCallArgs.messages.find(
        (m: Anthropic.MessageParam) => m.role === "assistant",
      );
      expect(assistantMsg).toBeDefined();
      const blockTypes = (assistantMsg!.content as Anthropic.ContentBlock[]).map(
        (b: Anthropic.ContentBlock) => b.type,
      );
      expect(blockTypes).not.toContain("thinking");
      expect(blockTypes).toContain("tool_use");
    });
  });

  describe("terseSuffix", () => {
    it("appends terse instruction to string system prompt", async () => {
      const client = mockClient([textMessage("Done.")]);

      await runAgentLoop(
        client,
        "You are a helper.",
        [{ role: "user", content: "Hi" }],
        baseConfig({ terseSuffix: true }),
      );

      const createCall = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.system).toContain("minimum tokens");
      expect(createCall.system).toContain("terse");
    });

    it("appends terse instruction to array system prompt", async () => {
      const client = mockClient([textMessage("Done.")]);

      await runAgentLoop(
        client,
        [{ type: "text" as const, text: "You are a helper." }],
        [{ role: "user", content: "Hi" }],
        baseConfig({ terseSuffix: true }),
      );

      const createCall = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.system).toHaveLength(2);
      expect(createCall.system[1].text).toContain("terse");
    });
  });

  describe("cacheTools", () => {
    it("stamps cache_control on last tool definition", async () => {
      const tools: Anthropic.Tool[] = [
        { name: "a", description: "A", input_schema: { type: "object" as const, properties: {} } },
        { name: "b", description: "B", input_schema: { type: "object" as const, properties: {} } },
      ];
      const client = mockClient([textMessage("Done.")]);

      await runAgentLoop(
        client,
        "System",
        [{ role: "user", content: "Hi" }],
        baseConfig({ tools, cacheTools: true }),
      );

      const createCall = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const lastTool = createCall.tools[createCall.tools.length - 1];
      expect(lastTool.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    });
  });

  describe("non-streaming mode (no onTextDelta)", () => {
    it("uses client.messages.create when stream is false", async () => {
      const client = mockClient([textMessage("Hello")]);

      await runAgentLoop(
        client,
        "System",
        [{ role: "user", content: "Hi" }],
        baseConfig({ stream: false }),
      );

      expect(client.messages.create).toHaveBeenCalled();
      expect(client.messages.stream).not.toHaveBeenCalled();
    });

    it("falls back to create when stream is true but no onTextDelta", async () => {
      const client = mockClient([textMessage("Hello")]);

      await runAgentLoop(
        client,
        "System",
        [{ role: "user", content: "Hi" }],
        baseConfig({ stream: true }), // no onTextDelta
      );

      expect(client.messages.create).toHaveBeenCalled();
      expect(client.messages.stream).not.toHaveBeenCalled();
    });
  });

  describe("fire-and-forget TUI bail-out", () => {
    it("bails out when all tool calls are TUI tools", async () => {
      // Only one API call — no second round
      const client = mockClient([
        textAndToolMessage("The tavern glows warmly.", "update_modeline", { location: "Tavern" }),
      ]);
      const toolHandler = vi.fn(() => ({
        content: JSON.stringify({ type: "update_modeline", location: "Tavern" }),
      }));

      const result = await runAgentLoop(
        client,
        "System",
        [{ role: "user", content: "I enter the tavern." }],
        baseConfig({ toolHandler, tuiToolNames: new Set(["update_modeline"]) }),
      );

      // Only one API call was made (no round-trip for ack)
      expect(client.messages.create).toHaveBeenCalledTimes(1);
      // Text was captured
      expect(result.text).toBe("The tavern glows warmly.");
      // TUI command was collected
      expect(result.tuiCommands).toHaveLength(1);
    });

    it("keeps tool_use/tool_result pair in roundMessages on bail-out", async () => {
      const client = mockClient([
        textAndToolMessage("Scene text.", "scribe", { updates: [] }),
      ]);
      const toolHandler = vi.fn(() => ({
        content: JSON.stringify({ type: "scribe", updates: [] }),
      }));

      const result = await runAgentLoop(
        client,
        "System",
        [{ role: "user", content: "Continue" }],
        baseConfig({ toolHandler, tuiToolNames: new Set(["scribe"]) }),
      );

      // roundMessages: assistant(text+tool_use), user(tool_result)
      expect(result.roundMessages).toHaveLength(2);
      expect(result.roundMessages[0].role).toBe("assistant");
      expect(result.roundMessages[1].role).toBe("user");

      // Assistant message retains tool_use blocks
      const assistantBlocks = result.roundMessages[0].content as Anthropic.ContentBlock[];
      const types = assistantBlocks.map((b) => b.type);
      expect(types).toContain("tool_use");
      expect(types).toContain("text");

      // User message has tool_result
      const userBlocks = result.roundMessages[1].content as Anthropic.ToolResultBlockParam[];
      expect(userBlocks[0].type).toBe("tool_result");
    });

    it("does NOT bail out when some tools are non-TUI", async () => {
      const msg: Anthropic.Message = {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5-20251001",
        content: [
          { type: "text", text: "Rolling and updating..." },
          { type: "tool_use", id: "toolu_1", name: "roll_dice", input: { expression: "1d20" } },
          { type: "tool_use", id: "toolu_2", name: "update_modeline", input: { location: "Arena" } },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: mockUsage(),
      } as Anthropic.Message;

      const client = mockClient([msg, textMessage("You rolled a 15!")]);
      const toolHandler = vi.fn((name: string) => {
        if (name === "roll_dice") return { content: "15" };
        return { content: JSON.stringify({ type: "update_modeline", location: "Arena" }) };
      });

      const result = await runAgentLoop(
        client,
        "System",
        [{ role: "user", content: "Attack" }],
        baseConfig({ toolHandler, tuiToolNames: new Set(["update_modeline"]) }),
      );

      // Two API calls — results sent back normally
      expect(client.messages.create).toHaveBeenCalledTimes(2);
    });

    it("handles tool-only response (no text) on bail-out", async () => {
      // DM returns ONLY tool_use blocks, no text
      const client = mockClient([
        toolUseMessage("update_modeline", { location: "Cave" }),
      ]);
      const toolHandler = vi.fn(() => ({
        content: JSON.stringify({ type: "update_modeline", location: "Cave" }),
      }));

      const result = await runAgentLoop(
        client,
        "System",
        [{ role: "user", content: "Look around" }],
        baseConfig({ toolHandler, tuiToolNames: new Set(["update_modeline"]) }),
      );

      expect(client.messages.create).toHaveBeenCalledTimes(1);
      expect(result.text).toBe("");
      // roundMessages: assistant(tool_use), user(tool_result)
      expect(result.roundMessages).toHaveLength(2);
    });
  });
});

describe("stampToolsCacheControl", () => {
  it("stamps cache_control on the last tool", () => {
    const tools: Anthropic.Tool[] = [
      { name: "roll_dice", description: "Roll dice.", input_schema: { type: "object", properties: {} } },
      { name: "draw_card", description: "Draw a card.", input_schema: { type: "object", properties: {} } },
    ];

    const result = stampToolsCacheControl(tools);
    const last = result[result.length - 1] as unknown as Record<string, unknown>;
    expect(last["cache_control"]).toEqual({ type: "ephemeral", ttl: "1h" });
    const first = result[0] as unknown as Record<string, unknown>;
    expect(first["cache_control"]).toBeUndefined();
  });

  it("does not mutate the input array or tools", () => {
    const tools: Anthropic.Tool[] = [
      { name: "roll_dice", description: "Roll dice.", input_schema: { type: "object", properties: {} } },
    ];

    const result = stampToolsCacheControl(tools);
    expect(tools).not.toBe(result);
    expect((tools[0] as unknown as Record<string, unknown>)["cache_control"]).toBeUndefined();
    expect((result[0] as unknown as Record<string, unknown>)["cache_control"]).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("returns empty array unchanged", () => {
    const result = stampToolsCacheControl([]);
    expect(result).toEqual([]);
  });
});

describe("extractStatus", () => {
  it("extracts numeric .status from error objects", () => {
    expect(extractStatus({ status: 429, message: "rate limit" })).toBe(429);
    expect(extractStatus({ status: 529 })).toBe(529);
  });

  it("detects overloaded errors by message string", () => {
    expect(extractStatus(new Error("server overloaded"))).toBe(529);
  });

  it("detects network errors and maps to status 0", () => {
    expect(extractStatus(new Error("fetch failed"))).toBe(0);
    expect(extractStatus(new Error("connect ECONNRESET"))).toBe(0);
    expect(extractStatus(new Error("getaddrinfo ENOTFOUND api.anthropic.com"))).toBe(0);
    expect(extractStatus(new Error("connect ETIMEDOUT 1.2.3.4:443"))).toBe(0);
    expect(extractStatus(new Error("connect ECONNREFUSED 127.0.0.1:443"))).toBe(0);
    expect(extractStatus(new Error("socket hang up"))).toBe(0);
    expect(extractStatus(new Error("network error"))).toBe(0);
    expect(extractStatus(new Error("write EPIPE"))).toBe(0);
    expect(extractStatus(new Error("getaddrinfo EAI_AGAIN api.anthropic.com"))).toBe(0);
    expect(extractStatus(new Error("Connection error."))).toBe(0);
  });

  it("returns null for unknown errors", () => {
    expect(extractStatus(new Error("something unexpected"))).toBeNull();
    expect(extractStatus("just a string")).toBeNull();
  });
});

describe("retryDelay", () => {
  it("uses exponential backoff", () => {
    expect(retryDelay(0)).toBe(1000);
    expect(retryDelay(1)).toBe(2000);
    expect(retryDelay(2)).toBe(4000);
    expect(retryDelay(3)).toBe(8000);
  });

  it("caps at 12s", () => {
    expect(retryDelay(4)).toBe(12000);
    expect(retryDelay(5)).toBe(12000);
    expect(retryDelay(100)).toBe(12000);
  });
});

describe("isTuiCommand", () => {
  it("recognizes TUI tool names", () => {
    expect(isTuiCommand("style_scene")).toBe(true);
    expect(isTuiCommand("present_choices")).toBe(true);
    expect(isTuiCommand("update_modeline")).toBe(true);
  });

  it("rejects non-TUI tool names", () => {
    expect(isTuiCommand("roll_dice")).toBe(false);
    expect(isTuiCommand("unknown")).toBe(false);
  });
});

describe("retry behavior via runAgentLoop", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("retries on 529 and eventually succeeds", async () => {
    const overloadedError = Object.assign(new Error("overloaded"), { status: 529 });
    let callCount = 0;
    const client = {
      messages: {
        create: vi.fn(async () => {
          callCount++;
          if (callCount <= 2) throw overloadedError;
          return textMessage("Success after retries");
        }),
      },
    } as unknown as Anthropic;

    const onRetry = vi.fn();
    const promise = runAgentLoop(
      client,
      "System",
      [{ role: "user", content: "Hi" }],
      baseConfig({ retry: true, onRetry }),
    );

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result.text).toBe("Success after retries");
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(529, expect.any(Number));
  });

  it("retries on network errors (ECONNRESET)", async () => {
    let callCount = 0;
    const client = {
      messages: {
        create: vi.fn(async () => {
          callCount++;
          if (callCount === 1) throw new Error("connect ECONNRESET");
          return textMessage("Reconnected");
        }),
      },
    } as unknown as Anthropic;

    const onRetry = vi.fn();
    const promise = runAgentLoop(
      client,
      "System",
      [{ role: "user", content: "Hi" }],
      baseConfig({ retry: true, onRetry }),
    );

    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result.text).toBe("Reconnected");
    expect(onRetry).toHaveBeenCalledWith(0, 1000);
  });

  it("throws immediately on non-retryable errors", async () => {
    const client = {
      messages: {
        create: vi.fn(async () => {
          throw Object.assign(new Error("bad request"), { status: 400 });
        }),
      },
    } as unknown as Anthropic;

    const onError = vi.fn();
    await expect(
      runAgentLoop(
        client,
        "System",
        [{ role: "user", content: "Hi" }],
        baseConfig({ retry: true, onError }),
      ),
    ).rejects.toThrow("bad request");
    expect(onError).toHaveBeenCalled();
  });

  it("throws immediately without retry when retry is false", async () => {
    const client = {
      messages: {
        create: vi.fn(async () => {
          throw Object.assign(new Error("overloaded"), { status: 529 });
        }),
      },
    } as unknown as Anthropic;

    const onError = vi.fn();
    await expect(
      runAgentLoop(
        client,
        "System",
        [{ role: "user", content: "Hi" }],
        baseConfig({ retry: false, onError }),
      ),
    ).rejects.toThrow("overloaded");
    expect(onError).toHaveBeenCalled();
  });
});
