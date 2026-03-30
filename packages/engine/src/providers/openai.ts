/**
 * OpenAI-compatible provider adapter.
 *
 * Wraps the official OpenAI SDK. Works with:
 * - OpenAI API (api.openai.com)
 * - OpenAI OAuth tokens (ChatGPT accounts)
 * - OpenRouter (openrouter.ai/api)
 * - Any OpenAI-compatible endpoint (Ollama, vLLM, llama.cpp, etc.)
 *
 * Handles format translation: OpenAI tool_calls use function.arguments
 * as a JSON string (vs Anthropic's parsed object), different streaming
 * events, reasoning tokens, and automatic prompt caching.
 */
import OpenAI from "openai";
import type {
  LLMProvider, ChatParams, ChatResult, HealthCheckResult,
  NormalizedMessage, NormalizedToolCall,
  NormalizedUsage, ContentPart, StopReason,
} from "./types.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface OpenAIProviderOptions {
  apiKey: string;
  baseURL?: string;
  /** Extra default headers (e.g., OpenRouter's HTTP-Referer, X-Title). */
  defaultHeaders?: Record<string, string>;
  /** Provider ID override (default "openai"). */
  providerId?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOpenAIProvider(opts: OpenAIProviderOptions): LLMProvider {
  const client = new OpenAI({
    apiKey: opts.apiKey as string,
    baseURL: opts.baseURL,
    defaultHeaders: opts.defaultHeaders,
  });

  const providerId = opts.providerId ?? "openai";

  return {
    providerId,
    chat: (params) => openaiChat(client, params, false),
    stream: (params, onDelta) => openaiChat(client, params, true, onDelta),
    healthCheck: (model) => openaiHealthCheck(client, model),
  };
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

async function openaiChat(
  client: OpenAI,
  params: ChatParams,
  streaming: boolean,
  onDelta?: (text: string) => void,
): Promise<ChatResult> {
  const apiParams = toOpenAIParams(params);

  if (streaming && onDelta) {
    return openaiStream(client, apiParams, onDelta);
  }

  const response = await client.chat.completions.create({
    ...apiParams,
    stream: false,
  });

  return fromOpenAIResponse(response);
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

async function openaiStream(
  client: OpenAI,
  apiParams: OpenAIChatParams,
  onDelta: (text: string) => void,
): Promise<ChatResult> {
  const stream = await client.chat.completions.create({
    ...apiParams,
    stream: true,
    stream_options: { include_usage: true },
  });

  let text = "";
  const toolCallAccumulators = new Map<number, { id: string; name: string; args: string }>();
  let finishReason: string | null = null;
  let usage: OpenAI.CompletionUsage | undefined;

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta;
    const finish = chunk.choices?.[0]?.finish_reason;
    if (finish) finishReason = finish;
    if (chunk.usage) usage = chunk.usage;

    if (delta?.content) {
      text += delta.content;
      onDelta(delta.content);
    }

    // Accumulate tool calls across chunks
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        if (!toolCallAccumulators.has(idx)) {
          toolCallAccumulators.set(idx, {
            id: tc.id ?? "",
            name: tc.function?.name ?? "",
            args: "",
          });
        }
        const acc = toolCallAccumulators.get(idx);
        if (!acc) continue;
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
      }
    }
  }

  // Parse accumulated tool calls
  const toolCalls: NormalizedToolCall[] = [];
  const assistantContent: ContentPart[] = [];

  if (text) {
    assistantContent.push({ type: "text", text });
  }

  for (const [, acc] of toolCallAccumulators) {
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(acc.args);
    } catch {
      // Strict parsing: malformed JSON → error tool result
      input = { _parse_error: `Malformed JSON in tool arguments: ${acc.args.slice(0, 200)}` };
    }
    toolCalls.push({ id: acc.id, name: acc.name, input });
    assistantContent.push({ type: "tool_use", id: acc.id, name: acc.name, input });
  }

  const stopReason = mapFinishReason(finishReason);
  const normalizedUsage = mapUsage(usage);

  return { text, toolCalls, usage: normalizedUsage, stopReason, assistantContent };
}

// ---------------------------------------------------------------------------
// Parameter mapping: normalized → OpenAI
// ---------------------------------------------------------------------------

interface OpenAIChatParams {
  model: string;
  messages: OpenAI.ChatCompletionMessageParam[];
  tools?: OpenAI.ChatCompletionTool[];
  max_tokens?: number;
  max_completion_tokens?: number;
  reasoning?: { effort: string; summary?: string };
}

function toOpenAIParams(params: ChatParams): OpenAIChatParams {
  const messages: OpenAI.ChatCompletionMessageParam[] = [];

  // System prompt
  if (typeof params.systemPrompt === "string") {
    messages.push({ role: "system", content: params.systemPrompt });
  } else {
    // Concatenate system blocks (OpenAI doesn't support multiple system messages with cache control)
    const systemText = params.systemPrompt.map((b) => b.text).join("\n\n");
    messages.push({ role: "system", content: systemText });
  }

  // Conversation messages (may expand: one normalized msg → multiple OpenAI msgs for tool results)
  for (const msg of params.messages) {
    messages.push(...toOpenAIMessages(msg));
  }

  // Tools
  let tools: OpenAI.ChatCompletionTool[] | undefined;
  if (params.tools?.length) {
    tools = params.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }

  // Reasoning/thinking config
  let reasoning: { effort: string; summary?: string } | undefined;
  if (params.thinking?.effort) {
    const effortMap: Record<string, string> = {
      low: "low",
      medium: "medium",
      high: "high",
      max: "xhigh",
    };
    reasoning = {
      effort: effortMap[params.thinking.effort] ?? "medium",
      summary: "concise",
    };
  }

  return {
    model: params.model,
    messages,
    ...(tools ? { tools } : {}),
    // Use max_completion_tokens for reasoning models, max_tokens for others
    ...(reasoning
      ? { max_completion_tokens: params.maxTokens, reasoning }
      : { max_tokens: params.maxTokens }),
  };
}

/**
 * Convert a single normalized message to one or more OpenAI messages.
 *
 * Anthropic groups tool results in one user message with multiple tool_result
 * blocks. OpenAI requires each tool result as a separate "tool" role message.
 * This function returns an array to handle that expansion.
 */
function toOpenAIMessages(msg: NormalizedMessage): OpenAI.ChatCompletionMessageParam[] {
  if (typeof msg.content === "string") {
    return [{ role: msg.role, content: msg.content }];
  }

  if (msg.role === "assistant") {
    let textContent = "";
    const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];

    for (const part of msg.content) {
      if (part.type === "text") {
        textContent += part.text;
      } else if (part.type === "tool_use") {
        toolCalls.push({
          id: part.id,
          type: "function",
          function: { name: part.name, arguments: JSON.stringify(part.input) },
        });
      }
    }

    if (toolCalls.length > 0) {
      return [{ role: "assistant", content: textContent || null, tool_calls: toolCalls }];
    }
    return [{ role: "assistant", content: textContent }];
  }

  // User messages: separate tool results into individual "tool" messages
  const toolResults = msg.content.filter((p) => p.type === "tool_result");
  if (toolResults.length > 0) {
    return toolResults.map((tr) => {
      if (tr.type !== "tool_result") throw new Error("unreachable");
      return {
        role: "tool" as const,
        tool_call_id: tr.tool_use_id,
        content: tr.content,
      };
    });
  }

  // Regular user text
  const text = msg.content
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("");
  return [{ role: "user", content: text }];
}

// ---------------------------------------------------------------------------
// Response mapping: OpenAI → normalized
// ---------------------------------------------------------------------------

function fromOpenAIResponse(response: OpenAI.ChatCompletion): ChatResult {
  const choice = response.choices[0];
  const text = choice?.message?.content ?? "";
  const toolCalls: NormalizedToolCall[] = [];
  const assistantContent: ContentPart[] = [];

  if (text) {
    assistantContent.push({ type: "text", text });
  }

  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      if (!("function" in tc)) continue;
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = { _parse_error: `Malformed JSON in tool arguments: ${tc.function.arguments.slice(0, 200)}` };
      }
      toolCalls.push({ id: tc.id, name: tc.function.name, input });
      assistantContent.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }
  }

  const stopReason = mapFinishReason(choice?.finish_reason ?? null);
  const usage = mapUsage(response.usage);

  return { text, toolCalls, usage, stopReason, assistantContent };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapFinishReason(reason: string | null): StopReason {
  switch (reason) {
    case "tool_calls": return "tool_use";
    case "length": return "length";
    case "content_filter": return "refusal";
    default: return "end";
  }
}

function mapUsage(usage?: OpenAI.CompletionUsage): NormalizedUsage {
  if (!usage) {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };
  }

  const details = usage.prompt_tokens_details as Record<string, number> | undefined;
  const outputDetails = usage.completion_tokens_details as Record<string, number> | undefined;

  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cacheReadTokens: details?.cached_tokens ?? 0,
    cacheCreationTokens: 0, // OpenAI doesn't charge separately for cache writes
    reasoningTokens: outputDetails?.reasoning_tokens ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

async function openaiHealthCheck(client: OpenAI, model?: string): Promise<HealthCheckResult> {
  try {
    await client.chat.completions.create({
      model: model ?? "gpt-4o-mini",
      max_tokens: 1,
      messages: [{ role: "user", content: "." }],
    });

    return { status: "valid", message: "Valid" };
  } catch (e) {
    if (e instanceof OpenAI.AuthenticationError) {
      return { status: "invalid", message: "Invalid API key" };
    }
    if (e instanceof OpenAI.PermissionDeniedError) {
      return { status: "invalid", message: "Permission denied" };
    }
    if (e instanceof OpenAI.RateLimitError) {
      return { status: "rate_limited", message: "Rate limited (key is valid)" };
    }
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
