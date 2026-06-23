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
  /**
   * Anthropic-shape thinking block. Persisted with the assistant turn and
   * replayed verbatim on subsequent turns so the model keeps its reasoning
   * across calls — on Opus 4.5+ and Sonnet 4.6+ these blocks are kept by the
   * API's automatic cache-prefix calculation. The `signature` is opaque and
   * MUST round-trip unchanged; passing back a thinking block with a missing
   * or mismatched signature gets rejected. `text` carries the visible thinking
   * text (Anthropic's wire field is `thinking`; we normalize the name). OpenAI
   * providers ignore this variant when serializing back to their APIs.
   */
  | { type: "thinking"; text: string; signature: string }
  /**
   * Redacted Anthropic thinking block — the model produced reasoning that
   * triggered a safety classifier, so the API returns only an opaque
   * `data` payload (no visible text) plus the surrounding `thinking` block
   * for continuity. Must be round-tripped unchanged on subsequent turns.
   */
  | { type: "redacted_thinking"; data: string }
  /**
   * Encrypted reasoning blob produced by an OpenAI reasoning model on the
   * Responses API (with `include: ["reasoning.encrypted_content"]`) — i.e. the
   * `openai-apikey` / `openrouter` providers. Persisted with the assistant turn
   * and replayed on subsequent turns so the model keeps its chain-of-thought
   * across calls without us setting `store: true`. The `encryptedContent`
   * payload is opaque; `summary` mirrors the human-readable reasoning summary we
   * already surface via `thinkingText` (kept here only so a turn round-trips
   * identically through persistence). Anthropic ignores this variant when
   * serializing back to its API; the `openai-chatgpt` (codex) provider neither
   * produces nor replays it — codex surfaces no usable blob on the
   * ChatGPT-account path, so its #533 replay was removed as a no-op (#607).
   */
  | { type: "reasoning"; id: string; encryptedContent: string; summary: string[] }
  /**
   * Image produced during a turn by dispatching the `generate_image`
   * function tool to {@link LLMProvider.generateImage}. Persisted with
   * the assistant turn for audit + transcripts; the actual model history
   * (round-trip serialization) sees the tool call + tool_result pair
   * and never replays the bytes, so the model-side prompt cache stays
   * lean. Captions are composed inside the image itself (printed as
   * part of the pixels — see the spec) so this variant carries no
   * separate caption string.
   *
   * `revisedPrompt` is whatever string the backend exposes as the
   * prompt it actually used (e.g. OpenAI's `revised_prompt`). Stored
   * for audit/debug; never rendered.
   *
   * `intent` distinguishes the trigger sites so disk-naming and
   * downstream behavior (portrait persistence vs scene snapshots) can
   * branch without re-deriving it from context.
   */
  | {
      type: "image_generated";
      id: string;
      base64: string;
      mimeType: string;
      revisedPrompt?: string;
      intent: "scene_snapshot" | "player_request" | "character_portrait";
    }
  /**
   * Image attached to a user/assistant message as input to the model.
   * Used to embed character portraits in the DM's cached prefix so the
   * model sees its party visually as well as textually. `lowDetail`
   * requests the cheapest available detail tier (OpenAI: `detail: "low"`,
   * flat 85 input tokens; other providers use their smallest tier).
   */
  | {
      type: "image_input";
      base64: string;
      mimeType: "image/png" | "image/jpeg" | "image/webp";
      lowDetail?: boolean;
      label?: string;
    };

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
// Image generation (provider-agnostic)
// ---------------------------------------------------------------------------

/**
 * Abstract render effort knob. Higher = slower + more expensive but
 * visibly nicer. Provider implementations map to their backend's nearest
 * equivalent — see openai-apikey for the canonical mapping.
 *
 * The four levels are deliberately named for *use case*, not backend
 * parameters, so we don't tie the schema to OpenAI's specific quality
 * tiers as those evolve:
 *   - `draft`    — fastest, low fidelity. Throwaway thumbnails.
 *   - `standard` — medium quality. Character portraits (setup-agent
 *                  chargen + in-game close-ups); quick/minor scene inserts.
 *   - `quality`  — high quality at a still-reasonable render time. The
 *                  default for DM scene snapshots and player-requested
 *                  illustrations.
 *   - `showcase` — highest polish for a rare hero shot; slower, so reserved
 *                  for set-piece moments.
 *
 * Per-backend reality of this knob:
 *   - **openai-apikey** — REAL. Maps to `quality: low|medium|high|high` on the
 *     `images.generate` REST call (see openai.ts EFFORT_TO_QUALITY).
 *   - **openai-chatgpt (codex)** — a NO-OP. The built-in image_gen tool exposes
 *     no quality/size param (upstream openai/codex#20839, open) and the backend
 *     renders at a fixed ~1.57 MP / `auto` quality regardless of the prompt
 *     (live-verified 2026-06-22). The value still rides the request and echoes
 *     back via `effortUsed` for contract parity, but does not affect the render.
 *
 * The knob is kept in the cross-provider contract regardless: it's load-bearing
 * on openai-apikey today and ready for any future image-capable backend (e.g.
 * Anthropic). The model picks per-call from the `generate_image` tool's `effort`
 * arg (each subagent's system prompt directs the model on when to pick what).
 */
export type ImageEffort = "draft" | "standard" | "quality" | "showcase";

/**
 * Abstract aspect ratio — the one render knob that steers output on EVERY
 * backend, including codex. Provider implementations map to the nearest
 * supported dimensions (OpenAI: portrait → 1024×1536, landscape → 1536×1024,
 * square → 1024×1024). On the codex path the backend honors the orientation but
 * renders a fixed pixel budget (~1.57 MP) either way, so `aspect` reshapes the
 * layout, not the pixel count/cost. Future backends pick their own canonical
 * sizes without breaking the schema.
 */
export type ImageAspect = "portrait" | "landscape" | "square";

/** Args accepted by {@link LLMProvider.generateImage}. */
export interface GenerateImageRequest {
  prompt: string;
  /** Default: `"standard"`. */
  effort?: ImageEffort;
  /** Default: `"square"`. */
  aspect?: ImageAspect;
  /**
   * Tag stamped onto the produced ContentPart for downstream routing
   * (disk naming via image-handler, persistence policy). Defaults to
   * `"player_request"`.
   */
  intent?: "scene_snapshot" | "player_request" | "character_portrait";
  /**
   * Optional visual reference images (e.g. PC portraits) the renderer should
   * condition on so a depicted character matches their established look. The
   * DM opts in per call by naming characters — references are NEVER attached
   * by default (a portrait reference biases the whole render toward that
   * character, wrong for a scene they're not in). Providers that can't do
   * image-to-image ignore this and render text-only. `label` (e.g. the
   * character name) lets the provider tie each reference to the prompt.
   */
  referenceImages?: { base64: string; mimeType: "image/png" | "image/jpeg" | "image/webp"; label?: string }[];
}

/** Result returned by {@link LLMProvider.generateImage}. */
export interface GenerateImageResult {
  /** Base64-encoded image bytes. */
  base64: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  /** What the backend says it actually drew (e.g. OpenAI's revised_prompt). */
  revisedPrompt?: string;
  /** Effort the provider actually used (after mapping / clamping). */
  effortUsed: ImageEffort;
  /** Aspect the provider actually used. */
  aspectUsed: ImageAspect;
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

/**
 * Canonical name for the image-generation function tool. Agents register
 * a NormalizedTool with this name when image-gen is enabled for the
 * subagent; the model invokes it like any other function tool. When the
 * tool fires, the host dispatches to {@link LLMProvider.generateImage}
 * and returns a text tool_result confirming the image was displayed —
 * the bytes flow out-of-band into TUI display + disk persistence.
 *
 * No provider-level interception: this is just a tool name like any
 * other. The constant exists to prevent typo drift between the
 * registration site and the dispatch handler.
 */
export const GENERATE_IMAGE_TOOL_NAME = "generate_image";

/**
 * Tool name for the DM's silent portrait-revision tool. Unlike
 * {@link GENERATE_IMAGE_TOOL_NAME} it does NOT display to the player: it
 * re-renders a PC's saved portrait (conditioned on the current one) to reflect
 * a durable appearance change, archives the prior version, and returns the new
 * portrait back into the DM's context on a later turn. Registered only when
 * image generation is enabled.
 */
export const UPDATE_PORTRAIT_TOOL_NAME = "update_portrait";

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
   * Anthropic thinking text blocks are excluded (they must not be sent back).
   * OpenAI `reasoning` blocks with encrypted_content ARE included so we can
   * replay them on subsequent turns and keep reasoning state across calls.
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

/**
 * Per-model capability surface. Synchronous, side-effect-free — providers
 * answer from a static table (the model registry or a hardcoded predicate),
 * never by calling the network. Used to gate prompt fragments and tool
 * registrations before a chat() call is constructed.
 */
export interface ProviderCapabilities {
  /**
   * The model + provider can emit images inline as part of a chat turn
   * via {@link GENERATE_IMAGE_TOOL_NAME}. When false, the engine omits
   * the image-gen tool from the tool list and skips loading the
   * image-related prompt fragments.
   */
  imageGeneration: boolean;
}

export interface LLMProvider {
  /** Provider identifier. */
  readonly providerId: string;

  /**
   * Capability lookup for a specific model id under this provider. Must be
   * synchronous and pure — no network calls. Used by the agent loop / DM
   * prompt assembly to decide whether to expose image-gen tooling and
   * prompts for the upcoming turn.
   */
  getCapabilities(model: string): ProviderCapabilities;

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
   * Generate an image from a textual prompt + abstract knobs (effort,
   * aspect). Optional — providers that don't support image generation
   * simply omit this method (and report `imageGeneration: false` from
   * getCapabilities for every model).
   *
   * Engine-side dispatch invokes this when the model calls the
   * `generate_image` function tool. The caller persists the bytes (see
   * `agents/image-handler.ts`), emits the TUI `display_image` command,
   * and returns a tool_result for the model's continuation.
   *
   * Throws on transport/backend errors. Callers translate the throw
   * into a tool_result with isError:true so the model can decide
   * whether to retry, apologize, or move on.
   */
  generateImage?(req: GenerateImageRequest): Promise<GenerateImageResult>;

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
