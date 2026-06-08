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
import type { UsageStatus, UsageSegment, UsageSegmentStatus } from "@machine-violet/shared";
import { getKnownModel, supportsImageGeneration } from "../config/model-registry.js";
import { logEvent } from "../context/engine-log.js";
import { patchOrphanedToolUses, reorderAssistantToolUseBlocksLast } from "./orphan-patch.js";

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

  /**
   * Most-recent rate-limit snapshot, parsed from the `anthropic-ratelimit-*`
   * response headers on every chat/stream call (see {@link captureRateLimits}).
   * Surfaced via getUsageStatus() so the Connections UI can show remaining
   * request/token quota for an active session. Null until the first response
   * carrying the headers lands — which is why getUsageStatus reports usage
   * only "after at least one request", per issue #464.
   */
  const rateLimitState: RateLimitState = { limits: null, capturedAt: 0 };

  return {
    providerId: "anthropic",
    getCapabilities: (model) => ({ imageGeneration: supportsImageGeneration(model) }),
    chat: (params) => anthropicChat(client, params, false, undefined, previousIdByConversation, rateLimitState),
    stream: (params, onDelta) => anthropicChat(client, params, true, onDelta, previousIdByConversation, rateLimitState),
    healthCheck: (model) => anthropicHealthCheck(client, model),
    getUsageStatus: () =>
      rateLimitState.limits
        ? rateLimitsToUsageStatus(rateLimitState.limits, rateLimitState.capturedAt)
        : null,
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
  rateLimitState: RateLimitState,
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
    // Rate-limit headers ride on the raw HTTP response, available on the
    // stream once it has connected — long settled by the time finalMessage
    // resolves.
    captureRateLimits(stream.response?.headers, rateLimitState);
  } else {
    // withResponse() surfaces the raw HTTP response alongside the parsed
    // Message so we can read the `anthropic-ratelimit-*` headers; awaiting it
    // is otherwise identical to awaiting create() directly.
    const { data, response: httpResponse } = await client.messages
      .create(createParams, requestOptions)
      .withResponse();
    response = data;
    captureRateLimits(httpResponse.headers, rateLimitState);
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

  // Messages — heal malformed history before mapping. Two passes:
  //   1. Reorder assistant blocks so any tool_use blocks come last. Anthropic
  //      400s when text follows tool_use ("tool_use ids were found without
  //      tool_result blocks immediately after") — the validator considers
  //      trailing text as abandoning the tool call and never checks the next
  //      user message for results.
  //   2. Insert synthetic tool_result stubs for any unpaired tool_use ids so
  //      every tool_use has a matching tool_result in the next message.
  // Together these heal the persisted shape the openai-chatgpt provider
  // produces (it appends final text after tool_use, and never persists
  // tool_results for tools it dispatched in-band).
  const reorderedMessages = params.messages.map(reorderAssistantToolUseBlocksLast);
  const patchedMessages = patchOrphanedToolUses(reorderedMessages);
  const messages = patchedMessages.map(toAnthropicMessage);

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
    while (stampMsgIdx >= 0 && patchedMessages[stampMsgIdx]?.ephemeral) {
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

  // Anthropic accepts thinking + redacted_thinking blocks as input — and on
  // Opus 4.5+ / Sonnet 4.6+ requires them to be sent back for the model's
  // reasoning to survive turn boundaries. The API auto-filters which blocks
  // are actually needed and only bills for what it shows the model, so we
  // pass back everything we captured rather than pruning manually.
  // See https://platform.claude.com/docs/en/docs/build-with-claude/extended-thinking
  const content: (
    | Anthropic.TextBlockParam
    | Anthropic.ToolUseBlockParam
    | Anthropic.ToolResultBlockParam
    | Anthropic.ThinkingBlockParam
    | Anthropic.RedactedThinkingBlockParam
  )[] = [];
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
    } else if (part.type === "thinking") {
      content.push({ type: "thinking", thinking: part.text, signature: part.signature });
    } else if (part.type === "redacted_thinking") {
      content.push({ type: "redacted_thinking", data: part.data });
    }
    // OpenAI `reasoning` blocks are skipped — the Anthropic API rejects them.
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
      // Persist for cross-turn replay. The signature is opaque and required
      // unchanged on the next turn — on Opus 4.5+/Sonnet 4.6+ this is what
      // lets the model continue reasoning where it left off instead of
      // re-deriving setup beat-to-beat. (See issue #533.)
      assistantContent.push({
        type: "thinking",
        text: block.thinking,
        signature: block.signature,
      });
      continue;
    }

    if (block.type === "redacted_thinking") {
      // No visible text to surface — the API redacted this reasoning step —
      // but the opaque `data` payload must round-trip for multi-turn continuity.
      assistantContent.push({ type: "redacted_thinking", data: block.data });
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
 *
 * Exported for tests.
 */
export function extractCacheDiagnostics(response: Anthropic.Message): CacheDiagnostics | undefined {
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
// Rate-limit usage tracking
// ---------------------------------------------------------------------------

/**
 * A parsed `anthropic-ratelimit-*` snapshot. Anthropic returns these headers
 * on every Messages response; we keep the most recent set on the provider and
 * expose it via getUsageStatus() so the Connections UI can show remaining
 * request/token quota. Shape matches `HealthCheckResult.rateLimits` so the
 * health-check path can reuse the same parse.
 */
export interface AnthropicRateLimits {
  requestsRemaining: number;
  requestsLimit: number;
  tokensRemaining: number;
  tokensLimit: number;
}

/** Mutable provider-scoped holder for the latest snapshot + when it landed. */
interface RateLimitState {
  limits: AnthropicRateLimits | null;
  /** Epoch ms when `limits` was observed (used as the UsageStatus snapshotAt). */
  capturedAt: number;
}

// Usage thresholds — mirror the openai-chatgpt provider (see openai-chatgpt/usage.ts)
// so the Connections UI colours every provider's segments on one scale.
const RATE_LIMIT_WARNING_THRESHOLD = 80;
const RATE_LIMIT_CRITICAL_THRESHOLD = 95;

function rateLimitSegmentStatus(usedPercent: number): UsageSegmentStatus {
  if (usedPercent >= 100) return "exceeded";
  if (usedPercent >= RATE_LIMIT_CRITICAL_THRESHOLD) return "critical";
  if (usedPercent >= RATE_LIMIT_WARNING_THRESHOLD) return "warning";
  return "ok";
}

/**
 * Parse the four `anthropic-ratelimit-*` headers into a snapshot, or null when
 * none are present (the API omits them on some error responses, and a mocked
 * client may not set any). A partial header set fills the missing values with
 * 0 — a 0 limit later suppresses that segment rather than showing a bogus 0%.
 *
 * Accepts any `{ get }` so both a fetch `Headers` and a test stub work.
 * Exported for tests.
 */
export function parseAnthropicRateLimits(
  headers: { get(name: string): string | null },
): AnthropicRateLimits | null {
  const reqRemaining = headers.get("anthropic-ratelimit-requests-remaining");
  const reqLimit = headers.get("anthropic-ratelimit-requests-limit");
  const tokRemaining = headers.get("anthropic-ratelimit-tokens-remaining");
  const tokLimit = headers.get("anthropic-ratelimit-tokens-limit");
  if (reqRemaining == null && reqLimit == null && tokRemaining == null && tokLimit == null) {
    return null;
  }
  return {
    requestsRemaining: Number(reqRemaining ?? 0),
    requestsLimit: Number(reqLimit ?? 0),
    tokensRemaining: Number(tokRemaining ?? 0),
    tokensLimit: Number(tokLimit ?? 0),
  };
}

/**
 * A `remaining`/`limit` pair is renderable only with a finite positive limit
 * and a finite remaining. Guards against a malformed/partial header set (e.g.
 * a `*-remaining` with no `*-limit`, or a non-numeric value that `Number()`
 * turned into NaN) producing a misleading 0% / NaN segment.
 */
function isRenderableLimit(remaining: number, limit: number): boolean {
  return Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining);
}

/** True when a snapshot has at least one renderable segment. */
function hasRenderableLimits(l: AnthropicRateLimits): boolean {
  return isRenderableLimit(l.requestsRemaining, l.requestsLimit)
    || isRenderableLimit(l.tokensRemaining, l.tokensLimit);
}

/**
 * Store the parsed snapshot when a response carries *usable* rate-limit headers.
 * A response without them (parse returns null) — or one whose parse yields no
 * renderable limit (a partial/garbage header set) — leaves the prior snapshot
 * intact. This is the missing-header fallback: a stray header-less or malformed
 * response must not blank the UI (or overwrite a good snapshot with junk)
 * between turns.
 */
function captureRateLimits(
  headers: { get(name: string): string | null } | null | undefined,
  state: RateLimitState,
): void {
  if (!headers) return;
  const parsed = parseAnthropicRateLimits(headers);
  if (parsed && hasRenderableLimits(parsed)) {
    state.limits = parsed;
    state.capturedAt = Date.now();
  }
}

/**
 * Build the generic {@link UsageStatus} from a rate-limit snapshot: up to two
 * `percentage` segments (requests, tokens). A segment without a finite positive
 * limit and finite remaining (header absent/partial/garbage) is skipped rather
 * than rendered as a misleading 0% / NaN; if neither is usable the result is
 * null so the UI shows no usage line. Exported for tests.
 */
export function rateLimitsToUsageStatus(
  limits: AnthropicRateLimits,
  snapshotAtMs: number,
): UsageStatus | null {
  const segments: UsageSegment[] = [];
  const addSegment = (id: string, label: string, remaining: number, limit: number): void => {
    if (!isRenderableLimit(remaining, limit)) return;
    const used = Math.max(0, limit - remaining);
    const usedPercent = Math.max(0, Math.min(100, (used / limit) * 100));
    segments.push({
      id,
      label,
      kind: "percentage",
      usedPercent,
      status: rateLimitSegmentStatus(usedPercent),
      detail: `${Math.max(0, remaining).toLocaleString()} of ${limit.toLocaleString()} remaining`,
      // Captured per-response (poll-style), not pushed — so the UI knows not
      // to expect live updates between its 30s refreshes.
      liveUpdates: false,
      source: "request-header",
    });
  };
  addSegment("requests", "Requests", limits.requestsRemaining, limits.requestsLimit);
  addSegment("tokens", "Tokens", limits.tokensRemaining, limits.tokensLimit);
  if (segments.length === 0) return null;
  return { segments, snapshotAt: snapshotAtMs, fresh: true };
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

    const rateLimits = parseAnthropicRateLimits(result.response.headers) ?? {
      requestsRemaining: 0, requestsLimit: 0, tokensRemaining: 0, tokensLimit: 0,
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
