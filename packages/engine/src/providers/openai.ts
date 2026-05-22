/**
 * OpenAI-compatible provider adapter.
 *
 * Wraps the official OpenAI SDK. Works with:
 * - OpenAI API (api.openai.com, key-based) — uses Responses API
 * - OpenRouter (openrouter.ai/api) — uses Responses API
 * - Any OpenAI-compatible endpoint (Ollama, vLLM, llama.cpp, etc.) — uses Chat Completions API
 *
 * NOT used for ChatGPT-account auth. That goes through the
 * `openai-chatgpt` provider in `providers/openai-chatgpt/` which drives
 * the official `codex app-server` subprocess over JSON-RPC instead of
 * speaking directly to api.openai.com.
 *
 * Handles format translation: OpenAI tool_calls use function.arguments
 * as a JSON string (vs Anthropic's parsed object), different streaming
 * events, reasoning tokens, and automatic prompt caching.
 */
import OpenAI from "openai";
import type { Response as OAIResponse } from "openai/resources/responses/responses.js";
import type { Reasoning, ReasoningEffort } from "openai/resources/shared.js";
import type {
  LLMProvider, ChatParams, ChatResult, HealthCheckResult,
  NormalizedMessage, NormalizedToolCall,
  NormalizedUsage, ContentPart, StopReason,
} from "./types.js";
import { patchOrphanedToolUses } from "./orphan-patch.js";

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** Provider IDs that use the Responses API instead of Chat Completions. */
const RESPONSES_API_PROVIDERS = new Set(["openai-apikey", "openrouter"]);

function useResponsesAPI(providerId: string): boolean {
  return RESPONSES_API_PROVIDERS.has(providerId);
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface OpenAIProviderOptions {
  apiKey: string;
  baseURL?: string;
  /** Extra default headers (e.g., OpenRouter's HTTP-Referer, X-Title). */
  defaultHeaders?: Record<string, string>;
  /** Provider ID override (default "openai-apikey"). */
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

  const providerId = opts.providerId ?? "openai-apikey";

  return {
    providerId,
    chat: (params) => openaiChat(client, providerId, params, false),
    stream: (params, onDelta) => openaiChat(client, providerId, params, true, onDelta),
    healthCheck: (model) => openaiHealthCheck(client, providerId, model),
  };
}

// ---------------------------------------------------------------------------
// Chat (dispatch)
// ---------------------------------------------------------------------------

async function openaiChat(
  client: OpenAI,
  providerId: string,
  params: ChatParams,
  streaming: boolean,
  onDelta?: (text: string) => void,
): Promise<ChatResult> {
  if (useResponsesAPI(providerId)) {
    return responsesChat(client, params, streaming, onDelta);
  }
  return completionsChat(client, params, streaming, onDelta);
}

// =========================================================================
// Responses API path
// =========================================================================

// ---------------------------------------------------------------------------
// Non-streaming / streaming dispatch
// ---------------------------------------------------------------------------

async function responsesChat(
  client: OpenAI,
  params: ChatParams,
  streaming: boolean,
  onDelta?: (text: string) => void,
): Promise<ChatResult> {
  const apiParams = toResponsesParams(params);

  if (streaming && onDelta) {
    return responsesStream(client, apiParams, onDelta);
  }

  const response = await client.responses.create({
    ...apiParams,
    stream: false,
  });

  return fromResponsesResponse(response);
}

// ---------------------------------------------------------------------------
// Streaming (Responses API)
// ---------------------------------------------------------------------------

async function responsesStream(
  client: OpenAI,
  apiParams: ResponsesParams,
  onDelta: (text: string) => void,
): Promise<ChatResult> {
  const stream = client.responses.stream(apiParams);

  let text = "";
  // Reasoning summaries arrive via dedicated streaming events
  // (`response.reasoning_summary_text.done`, etc.) that the OpenAI SDK's
  // response accumulator does NOT handle — it has cases for output_text
  // deltas, function_call argument deltas, and content_part additions, but
  // no cases for `response.reasoning_summary_part.added` or
  // `response.reasoning_summary_text.*`. The bare reasoning item pushed by
  // `response.output_item.added` ships with `summary: []` and never gets
  // populated, so finalResponse().output[i].summary is empty even though
  // the API did stream summary parts. Walking finalResponse for summaries
  // is therefore unreliable on the streaming path; capture them from the
  // events directly. See node_modules/openai/lib/responses/ResponseStream.mjs.
  const reasoningParts: string[] = [];
  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      text += event.delta;
      onDelta(event.delta);
    } else if (event.type === "response.reasoning_summary_text.done") {
      // `.done` carries the complete text for one summary part. We could
      // also accumulate `.delta` events, but `.done` is authoritative and
      // simpler — and the API guarantees a `.done` per part.
      if (event.text) reasoningParts.push(event.text);
    }
  }

  const response = await stream.finalResponse();
  // finalResponse() returns ParsedResponse which lacks the output_text
  // convenience property, so we build the result from the accumulated text
  // and parse tool calls from the output items directly. Reasoning is
  // passed in from the event-driven capture above.
  return fromResponsesResponseWithText(response, text, reasoningParts);
}

// ---------------------------------------------------------------------------
// Parameter mapping: normalized → Responses API
// ---------------------------------------------------------------------------

interface ResponsesParams {
  model: string;
  input: OpenAI.Responses.ResponseInput;
  instructions?: string;
  tools?: OpenAI.Responses.Tool[];
  max_output_tokens?: number;
  reasoning?: Reasoning;
  store?: boolean;
}

function toResponsesParams(params: ChatParams): ResponsesParams {
  // System prompt → instructions
  let instructions: string | undefined;
  if (typeof params.systemPrompt === "string") {
    instructions = params.systemPrompt;
  } else {
    instructions = params.systemPrompt.map((b) => b.text).join("\n\n");
  }

  // Conversation messages → input items. Heal orphaned tool_use blocks first
  // so OpenAI's strict function_call ↔ function_call_output pairing doesn't
  // 400 on replays of corrupted history. (No block-order normalization needed
  // — the Responses API accepts interleaved text/function_call items.)
  const input: OpenAI.Responses.ResponseInputItem[] = [];
  for (const msg of patchOrphanedToolUses(params.messages)) {
    input.push(...toResponsesInput(msg));
  }

  // Tools
  let tools: OpenAI.Responses.Tool[] | undefined;
  if (params.tools?.length) {
    tools = params.tools.map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description ?? undefined,
      parameters: t.inputSchema as Record<string, unknown>,
      strict: false,
    }));
  }

  // Reasoning config
  let reasoning: Reasoning | undefined;
  if (params.thinking?.effort) {
    const effortMap: Record<string, ReasoningEffort> = {
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
    input,
    instructions,
    ...(tools ? { tools } : {}),
    max_output_tokens: params.maxTokens,
    ...(reasoning ? { reasoning } : {}),
    store: false,
  };
}

/**
 * Convert a single normalized message to one or more Responses API input items.
 *
 * Key differences from Chat Completions:
 * - Tool results are top-level `function_call_output` items (not nested in a user message)
 * - Tool calls are top-level `function_call` items (not nested in an assistant message)
 * - Assistant text uses `output_text` content type
 */
function toResponsesInput(msg: NormalizedMessage): OpenAI.Responses.ResponseInputItem[] {
  // Simple string content
  if (typeof msg.content === "string") {
    return [{ type: "message", role: msg.role, content: msg.content }];
  }

  if (msg.role === "assistant") {
    const items: OpenAI.Responses.ResponseInputItem[] = [];
    let pendingText = "";

    // Iterate in order to preserve text ↔ tool_use interleaving
    for (const part of msg.content) {
      if (part.type === "text") {
        pendingText += part.text;
      } else if (part.type === "tool_use") {
        // Flush accumulated text before the function_call
        if (pendingText) {
          items.push({ type: "message", role: "assistant", content: pendingText });
          pendingText = "";
        }
        items.push({
          type: "function_call",
          call_id: part.id,
          name: part.name,
          arguments: JSON.stringify(part.input),
        });
      }
    }
    // Flush trailing text
    if (pendingText) {
      items.push({ type: "message", role: "assistant", content: pendingText });
    }

    return items;
  }

  // User messages: check for tool results
  const toolResults = msg.content.filter((p) => p.type === "tool_result");
  if (toolResults.length > 0) {
    return toolResults.map((tr) => {
      if (tr.type !== "tool_result") throw new Error("unreachable");
      return {
        type: "function_call_output" as const,
        call_id: tr.tool_use_id,
        output: tr.content,
      };
    });
  }

  // Regular user text
  const text = msg.content
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("");
  return [{ type: "message", role: "user", content: text }];
}

// ---------------------------------------------------------------------------
// Response mapping: Responses API → normalized
// ---------------------------------------------------------------------------

function fromResponsesResponse(response: OAIResponse): ChatResult {
  return fromResponsesResponseWithText(response);
}

/**
 * Build a ChatResult from a Responses API response.
 *
 * When called from the streaming path, `accumulatedText` and
 * `accumulatedReasoning` are supplied because `ParsedResponse.output_text`
 * is undefined on streamed responses and `output[i].summary` arrays are
 * empty (the SDK's response accumulator doesn't handle the
 * `response.reasoning_summary_*` events — see responsesStream above).
 * For streaming, text/reasoning are taken from the caller's accumulators
 * and the loop only walks `response.output` for tool calls.
 *
 * For non-streaming, everything — text, reasoning, tool calls — comes
 * from `response.output` in order so text ↔ tool_call interleaving is
 * preserved and reasoning summaries (returned because the request set
 * `reasoning.summary: "concise"`) get extracted from the populated
 * `summary` arrays.
 *
 * Reasoning is joined into `thinkingText` for both paths. Reasoning items
 * are never pushed to `assistantContent` — that's persisted conversation
 * history, and per OpenAI's guidance the reasoning text must not be sent
 * back to the model.
 */
function fromResponsesResponseWithText(
  response: OAIResponse,
  accumulatedText?: string,
  accumulatedReasoning?: string[],
): ChatResult {
  const toolCalls: NormalizedToolCall[] = [];
  const assistantContent: ContentPart[] = [];
  const textParts: string[] = [];
  const reasoningParts: string[] = [];

  const useAccumulatedText = accumulatedText !== undefined;
  if (useAccumulatedText && accumulatedText) {
    textParts.push(accumulatedText);
    assistantContent.push({ type: "text", text: accumulatedText });
  }

  for (const item of response.output) {
    if (item.type === "message" && !useAccumulatedText) {
      for (const part of item.content) {
        if (part.type === "output_text" && part.text) {
          textParts.push(part.text);
          assistantContent.push({ type: "text", text: part.text });
        }
      }
    } else if (item.type === "function_call") {
      const input = parseToolArgs(item.arguments);
      toolCalls.push({ id: item.call_id, name: item.name, input });
      assistantContent.push({ type: "tool_use", id: item.call_id, name: item.name, input });
    } else if (item.type === "reasoning" && accumulatedReasoning === undefined) {
      // Non-streaming path only: walk the populated summary array. The
      // `content` field (full reasoning text) is only populated when the
      // request opts in via `include: ["reasoning.encrypted_content"]` —
      // we don't, so summary is what we get and what we surface.
      // Streaming captures these via dedicated events instead because the
      // SDK accumulator leaves these arrays empty.
      for (const sum of item.summary ?? []) {
        if (sum.type === "summary_text" && sum.text) {
          reasoningParts.push(sum.text);
        }
      }
    }
  }

  // Streaming: caller passes summaries captured from streaming events.
  // Use those instead of (the empty) `output[i].summary` arrays.
  if (accumulatedReasoning) {
    reasoningParts.push(...accumulatedReasoning);
  }

  const text = textParts.join("");
  const thinkingText = reasoningParts.length > 0 ? reasoningParts.join("\n\n") : undefined;

  const stopReason = mapResponsesStatus(response, toolCalls.length > 0);
  const usage = mapResponsesUsage(response.usage);

  return { text, toolCalls, usage, stopReason, assistantContent, thinkingText };
}

// ---------------------------------------------------------------------------
// Helpers (Responses API)
// ---------------------------------------------------------------------------

function parseToolArgs(args: string): Record<string, unknown> {
  try {
    return JSON.parse(args);
  } catch {
    return { _parse_error: `Malformed JSON in tool arguments: ${args.slice(0, 200)}` };
  }
}

function mapResponsesStatus(response: OAIResponse, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return "tool_use";
  if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason;
    if (reason === "max_output_tokens") return "length";
    if (reason === "content_filter") return "refusal";
  }
  return "end";
}

function mapResponsesUsage(usage?: OAIResponse["usage"]): NormalizedUsage {
  if (!usage) {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 };
  }
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    cacheCreationTokens: 0,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

// =========================================================================
// Chat Completions path (for custom / OpenAI-compatible endpoints)
// =========================================================================

// ---------------------------------------------------------------------------
// Non-streaming / streaming dispatch
// ---------------------------------------------------------------------------

async function completionsChat(
  client: OpenAI,
  params: ChatParams,
  streaming: boolean,
  onDelta?: (text: string) => void,
): Promise<ChatResult> {
  const apiParams = toOpenAIParams(params);

  if (streaming && onDelta) {
    return completionsStream(client, apiParams, onDelta);
  }

  const response = await client.chat.completions.create({
    ...apiParams,
    stream: false,
  });

  return fromOpenAIResponse(response);
}

// ---------------------------------------------------------------------------
// Streaming (Chat Completions)
// ---------------------------------------------------------------------------

async function completionsStream(
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
// Parameter mapping: normalized → Chat Completions
// ---------------------------------------------------------------------------

interface OpenAIChatParams {
  model: string;
  messages: OpenAI.ChatCompletionMessageParam[];
  tools?: OpenAI.ChatCompletionTool[];
  max_tokens?: number;
  max_completion_tokens?: number;
  reasoning_effort?: ReasoningEffort;
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

  // Conversation messages (may expand: one normalized msg → multiple OpenAI msgs
  // for tool results). Heal orphaned tool_use blocks first so OpenAI's strict
  // tool_call ↔ tool message pairing doesn't 400 on replays of corrupted history.
  for (const msg of patchOrphanedToolUses(params.messages)) {
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

  // Reasoning effort: OpenAI uses a flat reasoning_effort string parameter,
  // not an object. Map from our normalized effort levels.
  let reasoningEffort: ReasoningEffort | undefined;
  if (params.thinking?.effort) {
    const effortMap: Record<string, ReasoningEffort> = {
      low: "low",
      medium: "medium",
      high: "high",
      max: "xhigh",
    };
    reasoningEffort = effortMap[params.thinking.effort] ?? "medium";
  }

  return {
    model: params.model,
    messages,
    ...(tools ? { tools } : {}),
    // All current OpenAI models accept max_completion_tokens;
    // max_tokens is deprecated and incompatible with o-series.
    max_completion_tokens: params.maxTokens,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  };
}

/**
 * Convert a single normalized message to one or more Chat Completions messages.
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
// Response mapping: Chat Completions → normalized
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
// Helpers (Chat Completions)
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

// =========================================================================
// Health check
// =========================================================================

async function openaiHealthCheck(client: OpenAI, providerId: string, model?: string): Promise<HealthCheckResult> {
  try {
    if (useResponsesAPI(providerId)) {
      await client.responses.create({
        model: model ?? "gpt-4o-mini",
        input: ".",
        max_output_tokens: 16,
        store: false,
      });
    } else {
      await client.chat.completions.create({
        model: model ?? "gpt-4o-mini",
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
      });
    }

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
