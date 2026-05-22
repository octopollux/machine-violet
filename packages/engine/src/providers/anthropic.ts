/**
 * Anthropic provider adapter.
 *
 * Wraps the @anthropic-ai/sdk to conform to the LLMProvider interface.
 * Handles Anthropic-specific features: cache_control breakpoints,
 * adaptive thinking, content block format, streaming events.
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider, ChatParams, ChatResult, HealthCheckResult,
  NormalizedMessage, NormalizedToolCall,
  NormalizedUsage, ContentPart, StopReason, CacheDiagnostics,
} from "./types.js";
import { getKnownModel } from "../config/model-registry.js";
import { logEvent } from "../context/engine-log.js";

/**
 * Beta header for prompt-cache diagnostics (Anthropic API only). When set,
 * the API returns a `diagnostics` field describing where the prompt prefix
 * diverged from a previous request identified by `previous_message_id`.
 * See https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics.
 */
const CACHE_DIAGNOSIS_BETA = "cache-diagnosis-2026-04-07";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAnthropicProvider(apiKey?: string): LLMProvider {
  const client = new Anthropic({
    defaultHeaders: { "x-app-name": "machine-violet" },
    ...(apiKey ? { apiKey } : {}),
  });

  /**
   * Per-conversation cursor for cache diagnostics. Key is the caller's
   * `conversationId` (typically the agent name); value is the `id` of the
   * most recent successful response on that chain. Looked up on each call
   * to populate `diagnostics.previous_message_id`. Lost on process restart,
   * which is fine — the next call simply passes `null` and starts a new
   * chain; the API treats it as a first turn.
   */
  const previousIdByConversation = new Map<string, string>();

  return {
    providerId: "anthropic",
    chat: (params) => anthropicChat(client, params, false, undefined, previousIdByConversation),
    stream: (params, onDelta) => anthropicChat(client, params, true, onDelta, previousIdByConversation),
    healthCheck: (model) => anthropicHealthCheck(client, model),
  };
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

async function anthropicChat(
  client: Anthropic,
  params: ChatParams,
  streaming: boolean,
  onDelta: ((text: string) => void) | undefined,
  previousIdByConversation: Map<string, string>,
): Promise<ChatResult> {
  const apiParams = toAnthropicParams(params);

  // Cache diagnostics: thread the previous response id on this chain so the
  // API can pinpoint cache divergence. Sent on every call when the caller
  // supplied a conversationId; `null` on the first call of a fresh chain
  // (per Anthropic docs, that's the opt-in signal — no comparison, but
  // future turns can compare against this one). The SDK at 0.82.0 doesn't
  // type `diagnostics` yet, so we attach it as an untyped extension.
  const convoId = params.conversationId;
  const diagnosticsParams = convoId !== undefined
    ? { diagnostics: { previous_message_id: previousIdByConversation.get(convoId) ?? null } }
    : {};

  // Anthropic-beta header per request; doesn't disturb existing default headers.
  const requestOptions = convoId !== undefined
    ? { headers: { "anthropic-beta": CACHE_DIAGNOSIS_BETA } }
    : undefined;

  let response: Anthropic.Message;

  // Extension fields (`diagnostics`, `betas`) aren't typed by SDK 0.82.0; we
  // attach them via an unknown cast that resolves to the same shape the
  // typed methods accept. `as unknown as ...` keeps the overload resolution
  // correctly disambiguating Message vs Stream return types.
  const streamParams = { ...apiParams, ...diagnosticsParams } as unknown as Anthropic.MessageStreamParams;
  const createParams = { ...apiParams, ...diagnosticsParams, stream: false } as unknown as Anthropic.MessageCreateParamsNonStreaming;

  if (streaming && onDelta) {
    const stream = client.messages.stream(streamParams, requestOptions);
    stream.on("text", (delta) => onDelta(delta));
    response = await stream.finalMessage();
  } else {
    response = await client.messages.create(createParams, requestOptions);
  }

  // Cursor advances on success only — a thrown error leaves the prior id in
  // place so a retry-then-success doesn't break the chain.
  if (convoId !== undefined && response.id) {
    previousIdByConversation.set(convoId, response.id);
  }

  return fromAnthropicResponse(response, !streaming ? onDelta : undefined);
}

// ---------------------------------------------------------------------------
// Parameter mapping: normalized → Anthropic
// ---------------------------------------------------------------------------

/** Exported for tests — maps normalized ChatParams to Anthropic SDK params. */
export function toAnthropicParams(params: ChatParams): {
  model: string;
  max_tokens: number;
  system: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  thinking?: Anthropic.Messages.ThinkingConfigParam;
  output_config?: Anthropic.Messages.OutputConfig;
} {
  // System prompt
  let system: string | Anthropic.TextBlockParam[];
  if (typeof params.systemPrompt === "string") {
    system = params.systemPrompt;
  } else {
    system = params.systemPrompt.map((block) => {
      const tb: Anthropic.TextBlockParam = { type: "text", text: block.text };
      if (block.cacheControl) {
        (tb as unknown as Record<string, unknown>).cache_control = {
          type: "ephemeral",
          ttl: block.cacheControl.ttl,
        };
      }
      return tb;
    });
  }

  // Messages
  const messages = params.messages.map(toAnthropicMessage);

  // Tools
  let tools: Anthropic.Tool[] | undefined;
  if (params.tools?.length) {
    tools = params.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool["input_schema"],
    }));

    // Apply cache hint to last tool if requested
    const toolCacheHint = params.cacheHints?.find((h) => h.target === "tools");
    if (toolCacheHint && tools.length > 0) {
      const last = { ...tools[tools.length - 1] };
      (last as Record<string, unknown>).cache_control = {
        type: "ephemeral",
        ttl: toolCacheHint.ttl ?? "1h",
      };
      tools[tools.length - 1] = last;
    }
  }

  // Thinking config — only enable for models that support it.
  const modelInfo = getKnownModel(params.model);
  const supportsThinking = modelInfo?.capabilities?.thinking ?? false;
  const isOpus = params.model.includes("opus");
  const effort = supportsThinking ? (params.thinking?.effort ?? null) : null;
  const thinking: Anthropic.Messages.ThinkingConfigParam =
    effort ? { type: "adaptive" } : { type: "disabled" };
  const output_config: Anthropic.Messages.OutputConfig | undefined =
    effort && isOpus ? { effort } : undefined;

  // When thinking is enabled, max_tokens must cover BOTH thinking and
  // response tokens. Boost to the model's max output so thinking doesn't
  // starve the actual response (especially on turn 1 with heavy tool use).
  let maxTokens = params.maxTokens;
  if (effort) {
    const modelMax = modelInfo?.maxOutput ?? 16384;
    maxTokens = Math.max(maxTokens, modelMax);
  }

  // Apply cache hint for conversation messages (BP4) if requested.
  //
  // Stamp on the last *non-ephemeral* message — i.e., the last message whose
  // bytes will be identical on subsequent turns. If we stamped on an ephemeral
  // message (e.g., the fresh user turn with its `<context>` preamble), the
  // next turn would send a stripped version of that message, the cached
  // prefix would diverge at that position, and everything downstream would
  // need to be rewritten. By stamping on the last stable message we ensure
  // the cached prefix contains only content that's byte-identical across
  // turns, and cross-turn hits only pay for the actual one-turn delta.
  //
  // Within a tool-use loop (rounds 2+), the newly-appended tool_use /
  // tool_result messages are non-ephemeral and stable, so we stamp on them
  // as usual — within-round caching is preserved.
  const msgCacheHint = params.cacheHints?.find((h) => h.target === "messages");
  if (msgCacheHint && messages.length > 0) {
    let stampMsgIdx = messages.length - 1;
    while (stampMsgIdx >= 0 && params.messages[stampMsgIdx]?.ephemeral) {
      stampMsgIdx--;
    }
    if (stampMsgIdx >= 0) {
      const last = messages[stampMsgIdx];
      if (typeof last.content === "string") {
        if (last.content) {
          messages[stampMsgIdx] = {
            role: last.role,
            content: [{
              type: "text" as const,
              text: last.content,
              cache_control: { type: "ephemeral" },
            } as Anthropic.TextBlockParam],
          };
        }
      } else if (Array.isArray(last.content) && last.content.length > 0) {
        const blocks = [...last.content] as unknown as Record<string, unknown>[];
        // Find last non-empty text block
        let stampIdx = blocks.length - 1;
        while (stampIdx >= 0 && blocks[stampIdx].type === "text" && !(blocks[stampIdx].text as string)) {
          stampIdx--;
        }
        if (stampIdx >= 0) {
          blocks[stampIdx] = { ...blocks[stampIdx], cache_control: { type: "ephemeral" } };
          messages[stampMsgIdx] = { role: last.role, content: blocks as unknown as Anthropic.MessageParam["content"] };
        }
      }
    }
  }

  return {
    model: params.model,
    max_tokens: maxTokens,
    system,
    messages,
    ...(tools ? { tools } : {}),
    thinking,
    ...(output_config ? { output_config } : {}),
  };
}

function toAnthropicMessage(msg: NormalizedMessage): Anthropic.MessageParam {
  if (typeof msg.content === "string") {
    return { role: msg.role, content: msg.content };
  }

  const content: (Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam | Anthropic.ToolResultBlockParam)[] = [];
  for (const part of msg.content) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text });
    } else if (part.type === "tool_use") {
      content.push({
        type: "tool_use",
        id: part.id,
        name: part.name,
        input: part.input,
      });
    } else if (part.type === "tool_result") {
      content.push({
        type: "tool_result",
        tool_use_id: part.tool_use_id,
        content: part.content,
        is_error: part.is_error,
      });
    }
    // Skip thinking blocks — they must not be sent back
  }
  return { role: msg.role, content };
}

// ---------------------------------------------------------------------------
// Response mapping: Anthropic → normalized
// ---------------------------------------------------------------------------

function fromAnthropicResponse(
  response: Anthropic.Message,
  emitText?: (text: string) => void,
): ChatResult {
  let text = "";
  const toolCalls: NormalizedToolCall[] = [];
  const assistantContent: ContentPart[] = [];
  let thinkingText = "";

  for (const block of response.content) {
    if (block.type === "thinking") {
      thinkingText += block.thinking;
      continue;
    }

    if (block.type === "text") {
      text += block.text;
      emitText?.(block.text);
      assistantContent.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      });
      assistantContent.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      });
    }
  }

  const stopReason: StopReason =
    response.stop_reason === "tool_use" ? "tool_use"
    : response.stop_reason === "refusal" ? "refusal"
    : response.stop_reason === "max_tokens" ? "length"
    : "end";

  const usage: NormalizedUsage = {
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: (response.usage as unknown as Record<string, number>).cache_read_input_tokens ?? 0,
    cacheCreationTokens: (response.usage as unknown as Record<string, number>).cache_creation_input_tokens ?? 0,
    reasoningTokens: 0,
  };

  const cacheDiagnostics = extractCacheDiagnostics(response);

  return {
    text,
    toolCalls,
    usage,
    stopReason,
    thinkingText: thinkingText || undefined,
    assistantContent,
    ...(cacheDiagnostics ? { cacheDiagnostics } : {}),
  };
}

/**
 * Parse Anthropic's `diagnostics.cache_miss_reason` (beta `cache-diagnosis-2026-04-07`)
 * from a response. The field has four states per the docs:
 *   - absent: feature not enabled.
 *   - `null`: first turn (no prior to compare) or comparison ran and found no divergence.
 *   - `{ cache_miss_reason: null }`: comparison still running when response serialized.
 *   - `{ cache_miss_reason: { type, cache_missed_input_tokens? } }`: divergence located.
 *
 * Returns `undefined` for the first three (nothing actionable to surface) and a
 * populated CacheDiagnostics only for the fourth. Also emits a structured log
 * line on `*_changed` types so operators can grep engine.jsonl for divergence
 * causes without going through the dump viewer.
 */
function extractCacheDiagnostics(response: Anthropic.Message): CacheDiagnostics | undefined {
  const raw = (response as unknown as Record<string, unknown>).diagnostics;
  if (raw == null || typeof raw !== "object") return undefined;

  const reason = (raw as Record<string, unknown>).cache_miss_reason;
  if (reason == null || typeof reason !== "object") return undefined;

  const reasonObj = reason as Record<string, unknown>;
  const reasonType = typeof reasonObj.type === "string" ? reasonObj.type : undefined;
  if (!reasonType) return undefined;

  const missedRaw = reasonObj.cache_missed_input_tokens;
  const missedInputTokens = typeof missedRaw === "number" ? missedRaw : undefined;

  // *_changed reasons indicate an actual prompt-prefix divergence the operator
  // can fix; the other two (`previous_message_not_found`, `unavailable`) are
  // "no comparison was produced" and not bugs in our code. Log only the
  // actionable ones so the signal stays useful.
  if (reasonType.endsWith("_changed")) {
    logEvent("cache:miss", {
      messageId: response.id,
      model: response.model,
      reasonType,
      ...(missedInputTokens !== undefined ? { missedInputTokens } : {}),
    });
  }

  return missedInputTokens !== undefined
    ? { reasonType, missedInputTokens }
    : { reasonType };
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

async function anthropicHealthCheck(client: Anthropic, model?: string): Promise<HealthCheckResult> {
  try {
    const result = await client.messages.create({
      model: model ?? "claude-haiku-4-5-20251001",
      max_tokens: 1,
      messages: [{ role: "user", content: "." }],
    }).withResponse();

    const headers = result.response.headers;
    const rateLimits = {
      requestsRemaining: Number(headers.get("anthropic-ratelimit-requests-remaining") ?? 0),
      requestsLimit: Number(headers.get("anthropic-ratelimit-requests-limit") ?? 0),
      tokensRemaining: Number(headers.get("anthropic-ratelimit-tokens-remaining") ?? 0),
      tokensLimit: Number(headers.get("anthropic-ratelimit-tokens-limit") ?? 0),
    };

    return { status: "valid", message: "Valid", rateLimits };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      return { status: "invalid", message: "Invalid API key" };
    }
    if (e instanceof Anthropic.RateLimitError) {
      return { status: "rate_limited", message: "Rate limited (key is valid)" };
    }
    if (e instanceof Anthropic.APIError && e.status === 529) {
      return { status: "valid", message: "Valid (API overloaded)" };
    }
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
