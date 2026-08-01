import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatParams } from "./types.js";

const mockCreate = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    interactions = { create: mockCreate };
  },
}));

import {
  createGeminiProvider,
  DEFAULT_GEMINI_IMAGE_MODEL,
  fromGeminiInteraction,
  mapGeminiUsage,
  toGeminiParams,
} from "./gemini.js";

function baseParams(overrides: Partial<ChatParams> = {}): ChatParams {
  return {
    model: "gemini-3.6-flash",
    systemPrompt: "Run the game.",
    messages: [{ role: "user", content: "Open the door." }],
    maxTokens: 65536,
    ...overrides,
  };
}

beforeEach(() => {
  mockCreate.mockReset();
});

describe("toGeminiParams", () => {
  it("builds a stateless Interactions request with current function-tool schema", () => {
    const mapped = toGeminiParams(baseParams({
      thinking: { effort: "max" },
      tools: [{
        name: "roll_dice",
        description: "Roll a die.",
        inputSchema: {
          type: "object",
          properties: { sides: { type: "integer" } },
          required: ["sides"],
        },
      }],
      dispatchTool: async () => ({ content: "20" }),
    }));

    expect(mapped).toMatchObject({
      model: "gemini-3.6-flash",
      store: false,
      system_instruction: "Run the game.",
      generation_config: {
        max_output_tokens: 65536,
        thinking_level: "high",
        thinking_summaries: "auto",
      },
      tools: [{
        type: "function",
        name: "roll_dice",
        parameters: expect.objectContaining({ type: "object" }),
      }],
    });
    expect(mapped.input).toEqual([{
      type: "user_input",
      content: [{ type: "text", text: "Open the door." }],
    }]);
  });

  it("replays thought signatures, model output, function calls, and results exactly", () => {
    const mapped = toGeminiParams(baseParams({
      messages: [
        { role: "user", content: "Roll a d20." },
        {
          role: "assistant",
          content: [
            {
              type: "gemini_thought",
              signature: "opaque-sig",
              summary: [{ type: "text", text: "I should use the tool." }],
            },
            {
              type: "tool_use",
              id: "call-1",
              name: "roll_dice",
              input: { sides: 20 },
              geminiSignature: "call-sig",
            },
          ],
        },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "call-1",
            content: "17",
          }],
        },
      ],
    }));

    expect(mapped.input).toEqual([
      { type: "user_input", content: [{ type: "text", text: "Roll a d20." }] },
      {
        type: "thought",
        signature: "opaque-sig",
        summary: [{ type: "text", text: "I should use the tool." }],
      },
      {
        type: "function_call",
        id: "call-1",
        name: "roll_dice",
        arguments: { sides: 20 },
        signature: "call-sig",
      },
      {
        type: "function_result",
        call_id: "call-1",
        name: "roll_dice",
        result: [{ type: "text", text: "17" }],
        is_error: undefined,
      },
    ]);
  });

  it("maps input images onto multimodal user_input content", () => {
    const mapped = toGeminiParams(baseParams({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Who is this?" },
          {
            type: "image_input",
            base64: "YWJj",
            mimeType: "image/png",
            lowDetail: true,
          },
        ],
      }],
    }));

    expect(mapped.input).toEqual([{
      type: "user_input",
      content: [
        { type: "text", text: "Who is this?" },
        { type: "image", data: "YWJj", mime_type: "image/png", resolution: "low" },
      ],
    }]);
  });
});

describe("Gemini response normalization", () => {
  it("continues the agent loop when a completed interaction contains a function call", () => {
    const result = fromGeminiInteraction({
      id: "int-completed-tool",
      status: "completed",
      steps: [{
        type: "function_call",
        id: "call-completed",
        name: "lookup",
        arguments: { key: "alarm" },
      }],
    });

    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toEqual([{
      id: "call-completed",
      name: "lookup",
      input: { key: "alarm" },
    }]);
  });

  it("normalizes thought, text, function calls, stop reason, and usage", () => {
    const result = fromGeminiInteraction({
      id: "int-1",
      status: "requires_action",
      steps: [
        {
          type: "thought",
          signature: "sig-1",
          summary: [{ type: "text", text: "Use a tool." }],
        },
        {
          type: "model_output",
          content: [{ type: "text", text: "Let me check." }],
        },
        {
          type: "function_call",
          id: "call-1",
          name: "lookup",
          arguments: { key: "door" },
          signature: "call-sig",
        },
      ],
      usage: {
        total_input_tokens: 100,
        total_output_tokens: 20,
        total_cached_tokens: 40,
        total_thought_tokens: 12,
      },
    });

    expect(result.text).toBe("Let me check.");
    expect(result.thinkingText).toBe("Use a tool.");
    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toEqual([{
      id: "call-1",
      name: "lookup",
      input: { key: "door" },
    }]);
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheCreationTokens: 0,
      reasoningTokens: 12,
    });
    expect(result.assistantContent[0]).toEqual({
      type: "gemini_thought",
      signature: "sig-1",
      summary: [{ type: "text", text: "Use a tool." }],
    });
    expect(result.assistantContent[2]).toEqual({
      type: "tool_use",
      id: "call-1",
      name: "lookup",
      input: { key: "door" },
      geminiSignature: "call-sig",
    });
  });

  it("defaults absent usage counters to zero", () => {
    expect(mapGeminiUsage()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    });
  });
});

describe("Gemini provider", () => {
  it("streams text deltas and assembles the final result", async () => {
    mockCreate.mockResolvedValueOnce((async function* () {
      yield {
        event_type: "interaction.created",
        interaction: { id: "int-stream", status: "in_progress" },
      };
      yield {
        event_type: "step.start",
        index: 0,
        step: { type: "model_output", content: [] },
      };
      yield {
        event_type: "step.delta",
        index: 0,
        delta: { type: "text", text: "Hello " },
      };
      yield {
        event_type: "step.delta",
        index: 0,
        delta: { type: "text", text: "there." },
      };
      yield {
        event_type: "interaction.completed",
        interaction: {
          id: "int-stream",
          status: "completed",
          usage: { total_input_tokens: 4, total_output_tokens: 2 },
        },
      };
    })());

    const provider = createGeminiProvider("test-key");
    const deltas: string[] = [];
    const result = await provider.stream(baseParams(), (delta) => deltas.push(delta));

    expect(deltas).toEqual(["Hello ", "there."]);
    expect(result.text).toBe("Hello there.");
    expect(result.stopReason).toBe("end");
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: "gemini-3.6-flash",
      stream: true,
      store: false,
    }));
  });

  it("assembles streamed function arguments from a completed interaction and returns tool_use", async () => {
    mockCreate.mockResolvedValueOnce((async function* () {
      yield {
        event_type: "interaction.created",
        interaction: { id: "int-tool", status: "in_progress" },
      };
      yield {
        event_type: "step.start",
        index: 0,
        step: { type: "function_call", id: "c1", name: "roll", arguments: {} },
      };
      yield {
        event_type: "step.delta",
        index: 0,
        delta: { type: "arguments_delta", arguments: "{\"sides\":" },
      };
      yield {
        event_type: "step.delta",
        index: 0,
        delta: { type: "arguments_delta", arguments: "20}" },
      };
      yield {
        event_type: "interaction.completed",
        interaction: {
          id: "int-tool",
          status: "completed",
        },
      };
    })());

    const result = await createGeminiProvider("test-key").stream(baseParams(), () => {});
    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toEqual([{
      id: "c1",
      name: "roll",
      input: { sides: 20 },
    }]);
  });

  it("uses Nano Banana 2 by default and maps image effort/aspect/references", async () => {
    mockCreate.mockResolvedValueOnce({
      id: "img-1",
      status: "completed",
      output_image: {
        type: "image",
        data: "aW1hZ2U=",
        mime_type: "image/jpeg",
      },
    });

    const result = await createGeminiProvider("test-key").generateImage!({
      prompt: "A clockwork citadel",
      effort: "quality",
      aspect: "landscape",
      referenceImages: [{
        base64: "cmVm",
        mimeType: "image/png",
        label: "Violet",
      }],
    });

    expect(mockCreate).toHaveBeenCalledWith({
      model: DEFAULT_GEMINI_IMAGE_MODEL,
      store: false,
      input: [
        { type: "text", text: "A clockwork citadel" },
        { type: "text", text: "Reference 1: Violet" },
        { type: "image", data: "cmVm", mime_type: "image/png" },
      ],
      response_format: {
        type: "image",
        aspect_ratio: "3:2",
        image_size: "2K",
      },
    });
    expect(result).toEqual({
      base64: "aW1hZ2U=",
      mimeType: "image/jpeg",
      effortUsed: "quality",
      aspectUsed: "landscape",
    });
  });

  it("honors an explicit image-model override", async () => {
    mockCreate.mockResolvedValueOnce({
      id: "img-2",
      status: "completed",
      output_image: { type: "image", data: "eA==", mime_type: "image/png" },
    });

    await createGeminiProvider("test-key").generateImage!({
      prompt: "A sigil",
      imageModel: "gemini-3-pro-image",
    });

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: "gemini-3-pro-image",
    }));
  });
});
