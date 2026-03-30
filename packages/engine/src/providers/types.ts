/**
 * Provider-agnostic LLM interface.
 *
 * All provider-specific SDKs (Anthropic, OpenAI, OpenRouter) are wrapped
 * behind this interface. The agent loop and subagent infrastructure only
 * talk to these normalized types.
 */

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Role for conversation messages. */
export type MessageRole = "user" | "assistant";

/** A single content part within a message. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "thinking"; text: string };

/** A conversation message in normalized form. */
export interface NormalizedMessage {
  role: MessageRole;
  content: string | ContentPart[];
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** A tool definition in provider-agnostic form. */
export interface NormalizedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A tool call extracted from a model response. */
export interface NormalizedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

/**
 * Advisory cache hint for providers that support prompt caching.
 * The provider adapter decides how to apply these (or ignores them).
 */
export interface CacheHint {
  /** Index into the system prompt blocks or "tools" for tool-block caching. */
  target: "system" | "tools" | "messages";
  /** Position within the target (e.g., block index for system, message index for messages). */
  index?: number;
  /** Requested TTL. */
  ttl?: "5m" | "1h";
}

// ---------------------------------------------------------------------------
// Thinking / Reasoning
// ---------------------------------------------------------------------------

export interface ThinkingConfig {
  /** Effort level: maps to Anthropic adaptive/effort or OpenAI reasoning.effort. */
  effort: "low" | "medium" | "high" | "max" | null;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Reasoning/thinking tokens (counted separately from output). */
  reasoningTokens: number;
}

// ---------------------------------------------------------------------------
// Chat request / response
// ---------------------------------------------------------------------------

export interface ChatParams {
  model: string;
  systemPrompt: string | SystemBlock[];
  messages: NormalizedMessage[];
  tools?: NormalizedTool[];
  maxTokens: number;
  thinking?: ThinkingConfig;
  cacheHints?: CacheHint[];
}

/** A system prompt block (text with optional cache control). */
export interface SystemBlock {
  text: string;
  cacheControl?: { ttl: "5m" | "1h" };
}

export type StopReason = "end" | "tool_use" | "length" | "refusal";

export interface ChatResult {
  /** Accumulated text content. */
  text: string;
  /** Tool calls in the response. */
  toolCalls: NormalizedToolCall[];
  /** Token usage. */
  usage: NormalizedUsage;
  /** Why the model stopped. */
  stopReason: StopReason;
  /** Thinking/reasoning text (Anthropic: full text; OpenAI: summary). */
  thinkingText?: string;
  /**
   * The raw assistant content blocks for conversation history.
   * Providers map their native format to ContentPart[].
   * Thinking blocks are excluded (they must not be sent back).
   */
  assistantContent: ContentPart[];
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

export interface HealthCheckResult {
  status: "valid" | "invalid" | "error" | "rate_limited";
  message: string;
  rateLimits?: {
    requestsRemaining: number;
    requestsLimit: number;
    tokensRemaining: number;
    tokensLimit: number;
  };
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface LLMProvider {
  /** Provider identifier. */
  readonly providerId: string;

  /** Send a message and get the full response. */
  chat(params: ChatParams): Promise<ChatResult>;

  /**
   * Stream a message, calling onDelta for each text chunk.
   * Returns the complete result when done.
   */
  stream(params: ChatParams, onDelta: (text: string) => void): Promise<ChatResult>;

  /** Minimal API call to validate credentials. */
  healthCheck(model?: string): Promise<HealthCheckResult>;
}
