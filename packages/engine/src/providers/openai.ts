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
  GenerateImageRequest, GenerateImageResult,
  ImageEffort, ImageAspect,
} from "./types.js";
import { patchOrphanedToolUses } from "./orphan-patch.js";
import { supportsImageGeneration } from "../config/model-registry.js";
import { logEvent } from "../context/engine-log.js";

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
    getCapabilities: (model) => ({
      // Only the Responses API path supports inline image generation. The
      // Chat Completions fallback (custom OpenAI-compatible endpoints) has
      // no `image_generation` tool, regardless of model.
      imageGeneration: useResponsesAPI(providerId) && supportsImageGeneration(model),
    }),
    chat: (params) => openaiChat(client, providerId, params, false),
    stream: (params, onDelta) => openaiChat(client, providerId, params, true, onDelta),
    healthCheck: (model) => openaiHealthCheck(client, providerId, model),
    // Only the Responses API path supports image generation; the Chat
    // Completions fallback (custom OpenAI-compatible endpoints) has no
    // Images API equivalent, so leave generateImage undefined there.
    ...(useResponsesAPI(providerId) ? { generateImage: (req) => openaiGenerateImage(client, req) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Image generation
// ---------------------------------------------------------------------------

/**
 * Map the abstract effort knob to OpenAI's quality param.
 *
 * `showcase` collapses to the same `high` quality as `quality` —
 * `images.generate` doesn't expose a separate fidelity dial. Future
 * backends that genuinely distinguish them can pick a different mapping.
 */
const EFFORT_TO_QUALITY: Record<ImageEffort, "low" | "medium" | "high"> = {
  draft: "low",
  standard: "medium",
  quality: "high",
  showcase: "high",
};

const ASPECT_TO_SIZE: Record<ImageAspect, "1024x1024" | "1024x1536" | "1536x1024"> = {
  square: "1024x1024",
  portrait: "1024x1536",
  landscape: "1536x1024",
};

async function openaiGenerateImage(
  client: OpenAI,
  req: GenerateImageRequest,
): Promise<GenerateImageResult> {
  const effort = req.effort ?? "standard";
  const aspect = req.aspect ?? "square";
  const quality = EFFORT_TO_QUALITY[effort];
  const size = ASPECT_TO_SIZE[aspect];

  // Diagnostic breadcrumb. The harness asserts on these.
  logEvent("image_gen:request", {
    effort,
    aspect,
    quality,
    size,
    intent: req.intent ?? "player_request",
    promptPreview: req.prompt.slice(0, 120),
  });

  // We must pass `model` — OpenAI's images.generate 400s with "Missing
  // required parameter: 'model'" when omitted (the documented defaulting
  // only kicks in for the older dall-e-2/3 path, which doesn't accept
  // low/medium/high quality).
  //
  // We pin to `gpt-image-2`. It's a direct upgrade over gpt-image-1 /
  // 1.5 at the same quality tiers — same call surface, sharper output,
  // better prompt adherence. Launched 2026-04-21; SDK support added in
  // openai@6.37. Rolling pointer rather than the dated snapshot
  // (`gpt-image-2-2026-04-21`) so we ride future quality bumps without
  // a code change.
  let response: Awaited<ReturnType<typeof client.images.generate>>;
  try {
    response = await client.images.generate({
      model: "gpt-image-2",
      prompt: req.prompt,
      quality,
      size,
      output_format: "png",
      n: 1,
    });
  } catch (e) {
    // Without this breadcrumb, a thrown error is invisible — the harness sees
    // image_gen:request fire but no terminal event, then the upstream
    // dispatcher's catch turns the throw into a tool_result with is_error
    // and the model continues. Surface the actual error.
    const message = e instanceof Error ? e.message : String(e);
    const status = (e as { status?: number } | null)?.status;
    logEvent("image_gen:error", {
      effort,
      aspect,
      message: message.slice(0, 400),
      ...(typeof status === "number" ? { status } : {}),
    });
    throw e;
  }

  const item = response.data?.[0];
  if (!item?.b64_json) {
    logEvent("image_gen:no_data", { effort, aspect });
    throw new Error("OpenAI images.generate returned no image data");
  }

  logEvent("image_gen:response", {
    effort,
    aspect,
    base64Length: item.b64_json.length,
    ...(item.revised_prompt ? { revisedPromptPreview: item.revised_prompt.slice(0, 120) } : {}),
  });

  return {
    base64: item.b64_json,
    mimeType: "image/png",
    ...(item.revised_prompt ? { revisedPrompt: item.revised_prompt } : {}),
    effortUsed: effort,
    aspectUsed: aspect,
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
  //
  // Same hazard for `encrypted_content` (only present when the request set
  // `include: ["reasoning.encrypted_content"]`): we don't trust the
  // finalResponse snapshot for reasoning items at all. The blob is
  // emitted on `response.output_item.done` events alongside the final
  // reasoning item shape, so capture it directly from there. Keyed by id
  // (last-write-wins) so a hypothetical retry or duplicate `done` for the
  // same item can't replay the same reasoning input twice on the next turn
  // — the Responses API would reject duplicate item ids.
  const reasoningParts: string[] = [];
  const encryptedReasoningById = new Map<string, { id: string; encryptedContent: string; summary: string[] }>();
  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      text += event.delta;
      onDelta(event.delta);
    } else if (event.type === "response.reasoning_summary_text.done") {
      // `.done` carries the complete text for one summary part. We could
      // also accumulate `.delta` events, but `.done` is authoritative and
      // simpler — and the API guarantees a `.done` per part.
      if (event.text) reasoningParts.push(event.text);
    } else if (event.type === "response.output_item.done") {
      // Reasoning items only show their `encrypted_content` once they're
      // fully done. Other item types (message, function_call) are handled
      // in `fromResponsesResponseWithText` via the finalResponse walk —
      // the SDK accumulator IS reliable for those.
      if (event.item.type === "reasoning" && event.item.encrypted_content) {
        const summary: string[] = [];
        for (const sum of event.item.summary ?? []) {
          if (sum.type === "summary_text" && sum.text) summary.push(sum.text);
        }
        encryptedReasoningById.set(event.item.id, {
          id: event.item.id,
          encryptedContent: event.item.encrypted_content,
          summary,
        });
      }
    }
  }

  const response = await stream.finalResponse();
  // finalResponse() returns ParsedResponse which lacks the output_text
  // convenience property, so we build the result from the accumulated text
  // and parse tool calls from the output items directly. Reasoning is
  // passed in from the event-driven capture above. Map preserves insertion
  // order, which matches the order ids first appeared in the stream.
  return fromResponsesResponseWithText(response, text, reasoningParts, [...encryptedReasoningById.values()]);
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
  /** Optional `include` selectors — currently we only use this to opt into
   * `reasoning.encrypted_content` when a reasoning effort is requested. */
  include?: OpenAI.Responses.ResponseIncludable[];
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

  // Tools — all flow through as plain function tools, including
  // `generate_image`. The earlier design hijacked generate_image and
  // substituted OpenAI's hosted `image_generation` tool config, which
  // meant the model couldn't pick per-call quality/size and we had
  // to compensate with several workarounds (replay-drop, status gates,
  // image-only continuation loops). Function-tool dispatch lets the
  // model pick effort + aspect per call via the tool args, and the
  // host calls provider.generateImage() to fulfill — no provider-side
  // hijack required.
  let tools: OpenAI.Responses.Tool[] | undefined;
  if (params.tools?.length) {
    const functionTools: OpenAI.Responses.Tool[] = params.tools.map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description ?? undefined,
      parameters: t.inputSchema as Record<string, unknown>,
      strict: false,
    }));
    if (functionTools.length > 0) tools = functionTools;
  }

  // Reasoning config. When any effort is set we also opt into encrypted
  // reasoning blobs (`include: ["reasoning.encrypted_content"]`) so the
  // model's chain-of-thought survives across turns. Without this, with
  // `store: false`, every turn restarts cold — the symptom is the model
  // re-deriving "do I have roll_dice, am I the DM?" deep into a campaign.
  // The blobs are opaque and we replay them via `toResponsesInput`.
  let reasoning: Reasoning | undefined;
  let include: OpenAI.Responses.ResponseIncludable[] | undefined;
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
    include = ["reasoning.encrypted_content"];
  }

  return {
    model: params.model,
    input,
    instructions,
    ...(tools ? { tools } : {}),
    max_output_tokens: params.maxTokens,
    ...(reasoning ? { reasoning } : {}),
    ...(include ? { include } : {}),
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

    // Reasoning items must precede the message/function_call items they
    // reason about, per the Responses API contract. Emit them all up front
    // in capture order. (`assistantContent` may store them anywhere in the
    // array depending on path — streaming pushes them late, non-streaming
    // pushes them early; the relative order among reasoning items is what
    // matters, and that's preserved here.)
    for (const part of msg.content) {
      if (part.type === "reasoning") {
        items.push({
          type: "reasoning",
          id: part.id,
          encrypted_content: part.encryptedContent,
          summary: part.summary.map((text) => ({ type: "summary_text", text })),
        });
      }
    }

    // Iterate in order to preserve text ↔ tool_use interleaving.
    // `image_generated` ContentParts (produced by the host when an image
    // is rendered) are stripped from replay: the model already saw the
    // tool_call + tool_result pair that carries the on-disk path, so
    // re-sending the base64 bytes would inflate the cached prefix for
    // zero model-visible benefit. Bytes still live on disk and in the
    // transcript export.
    let pendingText = "";
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
      // Reasoning parts already emitted above; image_generated stripped (see above).
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

  // User messages: if any image_input parts are present, emit a multimodal
  // content array so the model receives the visual context (party
  // portraits, etc.) alongside the text. When no images are present,
  // stay on the simpler string-content path.
  const hasImages = msg.content.some((p) => p.type === "image_input");
  if (hasImages) {
    const content: OpenAI.Responses.ResponseInputContent[] = [];
    for (const part of msg.content) {
      if (part.type === "text") {
        content.push({ type: "input_text", text: part.text });
      } else if (part.type === "image_input") {
        content.push({
          type: "input_image",
          detail: part.lowDetail ? "low" : "auto",
          image_url: `data:${part.mimeType};base64,${part.base64}`,
        });
      }
    }
    return [{ type: "message", role: "user", content }];
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
 * with an `encrypted_content` blob ARE pushed to `assistantContent` so they
 * round-trip through conversation persistence and get replayed on the next
 * turn via `toResponsesInput` — this is what lets `store: false` + reasoning
 * models keep their chain-of-thought across calls. The opaque encrypted
 * payload is what OpenAI accepts back; the human-readable summary text
 * continues to surface only through `thinkingText`.
 */
function fromResponsesResponseWithText(
  response: OAIResponse,
  accumulatedText?: string,
  accumulatedReasoning?: string[],
  accumulatedEncryptedReasoning?: { id: string; encryptedContent: string; summary: string[] }[],
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
  // Streaming path: surface encrypted reasoning items captured from
  // `output_item.done` events. The relative order of `reasoning` and other
  // content parts in `assistantContent` is purely cosmetic — `toResponsesInput`
  // re-sorts reasoning items ahead of text/tool_use when replaying, which is
  // the order the Responses API requires.
  if (accumulatedEncryptedReasoning) {
    for (const r of accumulatedEncryptedReasoning) {
      assistantContent.push({
        type: "reasoning",
        id: r.id,
        encryptedContent: r.encryptedContent,
        summary: r.summary,
      });
    }
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
    } else if (item.type === "image_generation_call") {
      // Tripwire. We never register the hosted `image_generation` tool
      // (image-gen is a function tool dispatched through provider.generateImage),
      // so this item type should not appear in normal operation. Drop
      // silently rather than crash, but log so an accidental future
      // re-registration of the hosted tool surfaces immediately.
      logEvent("image_gen:legacy_hosted_item_ignored", { id: item.id });
    } else if (item.type === "reasoning" && accumulatedReasoning === undefined) {
      // Non-streaming path. The streaming path's SDK accumulator is
      // unreliable for reasoning items (see the responsesStream comment),
      // so for streaming we get summary text via events and encrypted
      // blobs via `output_item.done` events — both arrive via the
      // `accumulated*` parameters and we skip the finalResponse walk.
      const summaryTexts: string[] = [];
      for (const sum of item.summary ?? []) {
        if (sum.type === "summary_text" && sum.text) {
          summaryTexts.push(sum.text);
        }
      }
      reasoningParts.push(...summaryTexts);

      // Encrypted-content replay. When the request set
      // `include: ["reasoning.encrypted_content"]` (i.e. any reasoning
      // effort was requested), the response carries an opaque blob per
      // reasoning item. Persist it on the assistant turn so the next call
      // can pass it back as a `reasoning` input item — that's what keeps
      // chain-of-thought alive across turns with `store: false`. If the
      // blob isn't present we don't push anything; persisting an empty
      // shell would let it round-trip back as an invalid input item.
      if (item.encrypted_content) {
        assistantContent.push({
          type: "reasoning",
          id: item.id,
          encryptedContent: item.encrypted_content,
          summary: summaryTexts,
        });
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
//
// REASONING PRESERVATION: not supported on this path. The Chat Completions
// API has no encrypted-blob equivalent the model accepts back on subsequent
// turns. Vendor-specific reasoning surfaces that exist (DeepSeek's
// `reasoning_content`, Ollama's `thinking` field, etc.) are display-only
// text — there is no contract that says "send this back to preserve the
// model's chain-of-thought." For custom endpoints, each turn's reasoning is
// re-derived from history. This is a hard upstream API limitation, not a
// gap in our adapter. If a future vendor exposes a round-trippable opaque
// reasoning payload, capture it as a `reasoning` ContentPart here. See
// issue #533 for context.
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
