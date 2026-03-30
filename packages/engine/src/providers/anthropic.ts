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
  NormalizedUsage, ContentPart, StopReason,
} from "./types.js";
import { getKnownModel } from "../config/model-registry.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAnthropicProvider(apiKey?: string): LLMProvider {
  const client = new Anthropic({
    defaultHeaders: { "x-app-name": "machine-violet" },
    ...(apiKey ? { apiKey } : {}),
  });

  return {
    providerId: "anthropic",
    chat: (params) => anthropicChat(client, params, false),
    stream: (params, onDelta) => anthropicChat(client, params, true, onDelta),
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
  onDelta?: (text: string) => void,
): Promise<ChatResult> {
  const apiParams = toAnthropicParams(params);

  let response: Anthropic.Message;

  if (streaming && onDelta) {
    const stream = client.messages.stream(apiParams);
    stream.on("text", (delta) => onDelta(delta));
    response = await stream.finalMessage();
  } else {
    response = await client.messages.create({ ...apiParams, stream: false });
  }

  return fromAnthropicResponse(response, !streaming ? onDelta : undefined);
}

// ---------------------------------------------------------------------------
// Parameter mapping: normalized → Anthropic
// ---------------------------------------------------------------------------

function toAnthropicParams(params: ChatParams): {
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
        (tb as Record<string, unknown>).cache_control = {
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

  // Thinking config
  const isOpus = params.model.includes("opus");
  const effort = params.thinking?.effort ?? null;
  const thinking: Anthropic.Messages.ThinkingConfigParam =
    effort ? { type: "adaptive" } : { type: "disabled" };
  const output_config: Anthropic.Messages.OutputConfig | undefined =
    effort && isOpus ? { effort } : undefined;

  // When thinking is enabled, max_tokens must cover BOTH thinking and
  // response tokens. Boost to the model's max output so thinking doesn't
  // starve the actual response (especially on turn 1 with heavy tool use).
  let maxTokens = params.maxTokens;
  if (effort) {
    const modelInfo = getKnownModel(params.model);
    const modelMax = modelInfo?.maxOutput ?? 16384;
    maxTokens = Math.max(maxTokens, modelMax);
  }

  // Apply cache hint to last conversation message (BP4) if requested
  const msgCacheHint = params.cacheHints?.find((h) => h.target === "messages");
  if (msgCacheHint && messages.length > 0) {
    const last = messages[messages.length - 1];
    if (typeof last.content === "string") {
      if (last.content) {
        messages[messages.length - 1] = {
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
        messages[messages.length - 1] = { role: last.role, content: blocks as unknown as Anthropic.MessageParam["content"] };
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
    cacheReadTokens: (response.usage as Record<string, number>).cache_read_input_tokens ?? 0,
    cacheCreationTokens: (response.usage as Record<string, number>).cache_creation_input_tokens ?? 0,
    reasoningTokens: 0,
  };

  return {
    text,
    toolCalls,
    usage,
    stopReason,
    thinkingText: thinkingText || undefined,
    assistantContent,
  };
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
