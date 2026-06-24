/**
 * Type definitions for the subset of the codex app-server JSON-RPC protocol
 * we actually use. Generated reference: `codex app-server generate-json-schema`.
 *
 * We intentionally model only the fields we read or write — the full
 * protocol is large (~37 client requests + many notifications + server
 * requests) and most of it is for the Codex coding agent's IDE/CLI
 * features (sandbox, approvals, plugins, marketplaces, MCP, skills).
 *
 * Spike-confirmed behavior (codex 0.130.0):
 *   - `dynamicTools` on `thread/start` is wire-supported even though
 *     missing from the generated schema — register tools there.
 *   - `developerInstructions` on `thread/start` works as the system
 *     prompt vector (NOT `personality`, which is a fixed enum).
 *   - `thread/inject_items` accepts arbitrary Responses-API items.
 *   - Server sends `item/tool/call` requests for each dynamic tool
 *     invocation; we reply with `{ success, contentItems }`.
 *   - `modelContextWindow` returned by `thread/tokenUsage/updated` is
 *     the per-plan cap, often smaller than the published model max.
 */

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

export interface InitializeParams {
  clientInfo: { name: string; title?: string; version?: string };
  capabilities?: { experimentalApi?: boolean };
}

export interface InitializeResult {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

// ---------------------------------------------------------------------------
// account/*
// ---------------------------------------------------------------------------

export type AccountType = "apiKey" | "chatgpt" | "chatgptAuthTokens";

export interface AccountReadResult {
  account: null | {
    type: AccountType;
    email?: string;
    planType?: string;
  };
  /** Misleading name — true even when ChatGPT auth is fine; check `account.type` instead. */
  requiresOpenaiAuth: boolean;
}

export type LoginAccountParams =
  | { type: "apiKey"; apiKey: string }
  | { type: "chatgpt"; codexStreamlinedLogin?: boolean }
  | { type: "chatgptDeviceCode" }
  | {
      type: "chatgptAuthTokens";
      /** Access token (JWT) acquired by the client's own OAuth flow. */
      accessToken: string;
      /** Workspace/account identifier (from the id_token's auth claims). */
      chatgptAccountId: string;
      /** Optional plan type. When null, codex derives from access-token claims. */
      chatgptPlanType?: string | null;
    };

export interface ChatGptLoginResult {
  type: "chatgpt";
  loginId: string;
  authUrl: string;
}

export interface ChatGptDeviceCodeLoginResult {
  type: "chatgptDeviceCode";
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

export type LoginAccountResult = ChatGptLoginResult | ChatGptDeviceCodeLoginResult | { type: "apiKey" };

export interface AccountLoginCompletedNotification {
  loginId: string;
  success: boolean;
  error?: string | null;
}

export interface AccountUpdatedNotification {
  authMode: AccountType | null;
  planType?: string;
}

// ---------------------------------------------------------------------------
// account/rateLimits/*
// ---------------------------------------------------------------------------

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}

export interface RateLimits {
  limitId: string;
  limitName: string | null;
  primary: RateLimitWindow;
  secondary?: RateLimitWindow;
  credits?: unknown;
  planType?: string;
  rateLimitReachedType?: string | null;
}

export interface RateLimitsUpdatedNotification {
  rateLimits: RateLimits;
}

// ---------------------------------------------------------------------------
// model/list
// ---------------------------------------------------------------------------

export interface ModelInfo {
  id: string;
  model: string;
  displayName: string;
  description?: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: ReasoningEffort;
  supportedReasoningEfforts: { reasoningEffort: ReasoningEffort; description?: string }[];
  inputModalities: string[];
  supportsPersonality: boolean;
  additionalSpeedTiers: string[];
}

export interface ModelListParams {
  limit?: number;
  includeHidden?: boolean;
}

export interface ModelListResult {
  data: ModelInfo[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// thread/*
// ---------------------------------------------------------------------------

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type ReasoningSummary = "auto" | "concise" | "detailed" | "none";

/** A custom tool registered with the thread. Wire-supported but absent from generated schema. */
export interface DynamicToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  namespace?: string | null;
  deferLoading?: boolean;
}

export interface ThreadStartParams {
  model?: string;
  cwd?: string;
  sandbox?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  developerInstructions?: string;
  baseInstructions?: string;
  dynamicTools?: DynamicToolSpec[];
  serviceName?: string;
  ephemeral?: boolean;
}

export interface ThreadStartResult {
  thread: {
    id: string;
    sessionId: string;
    cwd: string;
    [key: string]: unknown;
  };
  // Codex echoes back additional resolved config — we ignore most of it.
  [key: string]: unknown;
}

export interface ThreadInjectItemsParams {
  threadId: string;
  items: unknown[];
}

// ---------------------------------------------------------------------------
// turn/*
// ---------------------------------------------------------------------------

export type UserInputItem =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string };

export interface TurnStartParams {
  threadId: string;
  input: UserInputItem[];
  model?: string;
  effort?: ReasoningEffort;
  /**
   * Per-turn override for reasoning-summary verbosity. When unset, codex
   * falls back to its config default, which for the ChatGPT-account /
   * app-server flow is effectively "none" — meaning no
   * `item/reasoning/summaryTextDelta` notifications fire and our
   * `thinkingText` stays empty even though reasoning tokens are billed.
   * Set this explicitly to opt into streamed summaries.
   */
  summary?: ReasoningSummary;
}

export interface TurnStartResult {
  turn: {
    id: string;
    items: unknown[];
    itemsView: string;
    status: string;
    startedAt: number | null;
    completedAt: number | null;
    durationMs: number | null;
    error?: { message: string } | null;
  };
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: {
    id: string;
    status: "completed" | "failed" | "interrupted" | string;
    error?: { message: string } | null;
    completedAt: number;
    durationMs: number;
  };
}

export interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface ItemStartedNotification {
  threadId: string;
  turnId: string;
  startedAtMs: number;
  item: ItemBase;
}

export interface ItemCompletedNotification {
  threadId: string;
  turnId: string;
  completedAtMs: number;
  item: ItemBase;
}

export interface ItemBase {
  id: string;
  type: string;
  // Variant fields (only populated for matching types):
  text?: string;
  phase?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  callId?: string;
  status?: string;
  contentItems?: unknown[];
  success?: boolean;
  durationMs?: number;
  // `imageGeneration` variant (codex's built-in image_gen skill). Spike-
  // confirmed on codex 0.133.0: `result` carries the raw base64 image bytes
  // inline (no data: prefix), `revisedPrompt` is the backend-rewritten prompt,
  // and `savedPath` is where codex also wrote the PNG under
  // <codexHome>/generated_images/<sessionId>/. We harvest `result` inline when
  // it survives the stdio pipe, but that line is multi-MB and can be dropped or
  // corrupted in transit — so the canonical fallback is to read the PNG off
  // disk from that per-session dir. See provider.ts readNewestPngAsBase64.
  result?: string;
  revisedPrompt?: string | null;
  savedPath?: string;
}

export interface TokenUsageUpdatedNotification {
  threadId: string;
  turnId: string;
  tokenUsage: {
    total: TokenUsageBreakdown;
    last: TokenUsageBreakdown;
    modelContextWindow: number;
  };
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

// ---------------------------------------------------------------------------
// rawResponseItem/completed (notification)
//
// Codex exposes the raw Responses-API items it received from OpenAI on this
// secondary stream. The opaque `encrypted_content` blob on reasoning items lives
// here (the sanitized `item/completed` stream strips that field). #533 wired the
// codex provider to capture and replay it for cross-turn chain-of-thought, but
// that was a no-op on the ChatGPT-account path — codex emits no reasoning items
// here at all — so the replay was removed (#607). We still subscribe, now only
// to COUNT reasoning items for the #597 tripwire. See issues #533 / #607.
//
// Source: codex-rs/app-server-protocol/schema/json/v2/RawResponseItemCompletedNotification.json
// (codex 0.130.0+). Modeled minimally — we only read the reasoning variant's type.
// ---------------------------------------------------------------------------

export interface RawResponseItemCompletedNotification {
  threadId: string;
  turnId: string;
  item: RawResponseItem;
}

/**
 * Minimal model of the Responses-API item shape codex forwards on
 * `rawResponseItem/completed`. The wire format mirrors the OpenAI Responses
 * API item types (`message`, `function_call`, `reasoning`, …); we model the
 * fields we read and leave everything else open.
 */
export interface RawResponseItem {
  type: string;
  id?: string;
  /** Reasoning variant: opaque blob the API accepts back as input. Null when ZDR is off. */
  encrypted_content?: string | null;
  /** Reasoning variant: array of summary parts (text-only humans-readable). */
  summary?: RawReasoningSummaryItem[];
  // Other fields (content, role, call_id, name, arguments, …) exist on
  // sibling variants; we don't decode them here.
  [key: string]: unknown;
}

export interface RawReasoningSummaryItem {
  type: string;
  text?: string;
}

// ---------------------------------------------------------------------------
// item/tool/call (server request)
// ---------------------------------------------------------------------------

export interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments: Record<string, unknown>;
  namespace?: string | null;
}

export interface DynamicToolCallResponse {
  success: boolean;
  contentItems: (| { type: "inputText"; text: string }
    | { type: "inputImage"; imageUrl: string })[];
}

// ---------------------------------------------------------------------------
// account/chatgptAuthTokens/refresh (server request)
// ---------------------------------------------------------------------------

export interface ChatgptAuthTokensRefreshParams {
  reason: "unauthorized" | "expired" | string;
  previousAccountId?: string | null;
}

export interface ChatgptAuthTokensRefreshResponse {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType?: string | null;
}
