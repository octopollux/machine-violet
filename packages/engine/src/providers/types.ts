/**
 * Provider-agnostic LLM interface.
 *
 * All provider-specific SDKs (Anthropic, OpenAI, OpenRouter) are wrapped
 * behind this interface. The agent loop and subagent infrastructure only
 * talk to these normalized types.
 */
import type { UsageStatus } from "@machine-violet/shared";

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
  /**
   * True if this message's bytes are ephemeral — present only on the current
   * request and not persisted to conversation storage. Downstream the
   * Anthropic provider uses this to pick the BP4 cache stamp: we stamp on
   * the last *non-ephemeral* message so the cache entry's prefix matches
   * what subsequent turns send (which have this message stripped). Without
   * this flag, stamping on an ephemeral message would make every next-turn
   * lookup miss at that position and force a full tail rewrite.
   */
  ephemeral?: boolean;
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
// Cache diagnostics
// ---------------------------------------------------------------------------

/**
 * Provider-reported reason a prompt-cache lookup diverged from the previous
 * request. Currently sourced from Anthropic's `cache-diagnosis-2026-04-07`
 * beta; future providers with comparable signals can populate the same shape.
 *
 * `reasonType` mirrors the Anthropic `cache_miss_reason.type` discriminant:
 * `model_changed | system_changed | tools_changed | messages_changed |
 *  previous_message_not_found | unavailable`. Kept as `string` so newly
 * added types don't break parsing.
 */
export interface CacheDiagnostics {
  reasonType: string;
  /** Estimated input tokens that fell after the divergence point, when known. */
  missedInputTokens?: number;
}

// ---------------------------------------------------------------------------
// Chat request / response
// ---------------------------------------------------------------------------

/**
 * In-process tool dispatcher.
 *
 * Some providers (codex app-server) own tool dispatch end-to-end: the
 * model's tool calls arrive as JSON-RPC server requests that must be
 * replied to in-band, so the provider runs the entire multi-round tool
 * loop inside a single `chat()` call rather than surfacing intermediate
 * tool calls back to the bridge. Those providers invoke this callback
 * per tool call; the returned `content` is sent back to the model as
 * the tool result.
 *
 * Providers that don't support internal dispatch (Anthropic, openai-apikey,
 * openrouter, custom) ignore the field and continue to surface tool calls
 * via `ChatResult.toolCalls` for the caller to dispatch and re-issue.
 */
export type DispatchToolFn = (call: NormalizedToolCall) => Promise<{ content: string; isError?: boolean }>;

interface ChatParamsBase {
  model: string;
  systemPrompt: string | SystemBlock[];
  messages: NormalizedMessage[];
  maxTokens: number;
  thinking?: ThinkingConfig;
  cacheHints?: CacheHint[];
  /**
   * Opaque stable key identifying this chain of related calls (typically an
   * agent name like "dm" or "scribe"). Providers that surface cache
   * diagnostics use this to thread Anthropic's `previous_message_id` between
   * consecutive calls in the same chain so the API can pinpoint where the
   * cached prefix diverged. Optional — callers that don't set it just opt
   * out of cache-miss attribution; the call itself behaves identically.
   */
  conversationId?: string;
}

interface ChatParamsToolless extends ChatParamsBase {
  /** No tools on this call (text-only or model-driven generation). */
  tools?: undefined;
  dispatchTool?: undefined;
}

interface ChatParamsWithTools extends ChatParamsBase {
  /** Tools available to the model on this call. */
  tools: NormalizedTool[];
  /**
   * Required when `tools` is present. Providers with internal dispatch
   * (codex app-server) invoke this for each tool call mid-turn. Providers
   * without internal dispatch ignore it and instead surface tool calls
   * via `ChatResult.toolCalls`. The type system requires it either way
   * so the runtime guard in {@link ../openai-chatgpt/provider.ts} can
   * never silently misfire from a caller forgetting the wiring.
   */
  dispatchTool: DispatchToolFn;
}

/**
 * Discriminated union over `tools`: a call either provides no tools (and
 * no dispatcher) or provides both. This prevents the "tools without
 * dispatcher" footgun at compile time — codex's runtime guard becomes
 * the second line of defense, not the first.
 */
export type ChatParams = ChatParamsToolless | ChatParamsWithTools;

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
  /**
   * Per-call cache divergence attribution, when the provider supports it and
   * a comparison ran. `undefined` means the provider didn't surface
   * diagnostics for this call (no beta enabled, no prior request to compare
   * against, comparison still pending, or comparison unavailable). A present
   * value carries the divergence point that caused (or would have caused)
   * the prompt cache to miss — see {@link CacheDiagnostics}.
   */
  cacheDiagnostics?: CacheDiagnostics;
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

  /**
   * Return the provider's current remaining-usage snapshot, or null if the
   * provider has no usage concept (custom OpenAI-compatible endpoints,
   * local Ollama, etc.). Providers that can report usage may choose to
   * return a cached snapshot here and surface live updates via
   * {@link subscribeUsage}. Always synchronous — never call out to the
   * provider from this method; doing so would block the Connections UI
   * render loop.
   */
  getUsageStatus?(): UsageStatus | null;

  /**
   * Subscribe to push-style usage updates. Implementations that observe
   * usage out-of-band (Codex's `account/rateLimits/updated` JSON-RPC
   * notifications) fire `cb` on every change. Returns an unsubscribe
   * function. Providers without a push channel may omit this method;
   * consumers fall back to polling {@link getUsageStatus} on a timer.
   */
  subscribeUsage?(cb: (status: UsageStatus) => void): () => void;

  /**
   * Release any long-lived resources (subprocesses, sockets, file
   * handles). Stateless providers (Anthropic SDK, OpenAI SDK) may omit
   * this method. Stateful providers — currently only openai-chatgpt,
   * which owns a `codex app-server` subprocess — must implement it so
   * the session manager can shut down cleanly between sessions.
   *
   * Idempotent: calling dispose() on an already-disposed provider is a
   * no-op rather than an error.
   */
  dispose?(): Promise<void>;
}

/**
 * A resolved tier assignment: a provider paired with the model ID it should
 * be invoked with. Each LLM call needs both — and they must match (you can't
 * send a Claude model ID to an OpenAI provider). Producers (session-manager)
 * pair them once at session start; consumers (DM agent, subagents) destructure
 * `provider` and `model` at the call site.
 *
 * Used as the building block for `Record<ModelTier, TierProvider>` so subagent
 * dispatch can pick the right tier without re-resolving connections every call.
 */
export interface TierProvider {
  provider: LLMProvider;
  model: string;
}
